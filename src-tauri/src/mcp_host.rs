//! The local MCP endpoint (ADR-0004): a small HTTP server on 127.0.0.1 that hands JSON-RPC
//! messages to `meshkeep_engine::mcp`. Transport only: the token check, the Origin check
//! (no browser page may reach it), one request at a time against the shared engine, and an
//! event per change so the open window follows what an agent did. The engine lock is taken
//! per message by `mcp::handle_shared`, and an import releases it while files move, so the
//! window's own commands are never stuck behind an agent's import for long.
//!
//! Streamable HTTP, the simple half: every message is a POST and the answer is JSON, no
//! session ids, notifications get 202. One exception (#102): a `tools/call` that carries a
//! progress token, from a client that accepts `text/event-stream`, is answered as a stream of
//! server-sent events on the same POST, progress notifications first and the result last.
//! `GET` stays 405: outside a running request the server never sends messages on its own.
//! A connection a client keeps open outlives `stop()` until the client gives up on it
//! (tiny_http closes only on the request's own `Connection: close`), so the bridge sends
//! that header; a stopped server refuses new connections at once.

use meshkeep_engine::import::ImportProgress;
use meshkeep_engine::mcp::{self, Change};
use meshkeep_engine::SharedEngine;
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tiny_http::{Header, Method, Request, Response, Server};

/// Called with the changes a message made, after the engine lock is released.
pub type OnChange = Arc<dyn Fn(&[Change]) + Send + Sync>;
/// Called with the progress of an import an agent started, like the window's own import.
pub type OnProgress = Arc<dyn Fn(ImportProgress) + Send + Sync>;

/// Reads the AI key from wherever the shell keeps it (the OS credential store), each time
/// an agent asks for a suggestion; the key is never held here.
pub type ReadAiKey = Arc<dyn Fn() -> Result<Option<String>, String> + Send + Sync>;

/// What the app lends the server.
#[derive(Clone)]
pub struct Hooks {
    pub on_change: OnChange,
    pub ai_key: ReadAiKey,
    /// Progress of an import an agent started, for the window's own display.
    pub on_import: OnProgress,
}

impl Hooks {
    /// Hooks for a server that only reports changes: no AI key, so no AI request, and
    /// nobody watching imports.
    pub fn changes_only(on_change: OnChange) -> Hooks {
        Hooks {
            on_change,
            ai_key: Arc::new(|| Ok(None)),
            on_import: Arc::new(|_| {}),
        }
    }
}

#[derive(Default)]
struct Stats {
    requests: AtomicU64,
    rejected: AtomicU64,
    last_request_at: Mutex<Option<time::OffsetDateTime>>,
}

struct Running {
    server: Arc<Server>,
    thread: Option<JoinHandle<()>>,
    port: u16,
    /// The token requests are checked against; replaced in place when the user asks for a
    /// new one, so that does not take the server down.
    token: Arc<Mutex<String>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// What the Settings page shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub error: Option<String>,
    pub requests: u64,
    pub rejected: u64,
    pub last_request_at: Option<String>,
}

/// How long a port this host just gave up is retried before "address in use" is believed.
const REBIND_FOR: std::time::Duration = std::time::Duration::from_secs(2);

/// Binds the listener. With `patient`, a failure is retried for `REBIND_FOR`: the HTTP
/// library closes a stopped server's socket on its own thread, a moment after `stop`.
fn listen(addr: &str, patient: bool) -> Result<Server, String> {
    let began = std::time::Instant::now();
    loop {
        match Server::http(addr) {
            Ok(server) => return Ok(server),
            Err(e) if patient && began.elapsed() < REBIND_FOR => {
                log::debug!("MCP server: {addr} not free yet ({e}), trying again");
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Owns the server thread; `apply` makes it match the settings.
#[derive(Default)]
pub struct Host {
    running: Mutex<Option<Running>>,
    stopped_at: Mutex<Option<std::time::Instant>>,
    error: Mutex<Option<String>>,
    stats: Arc<Stats>,
}

impl Host {
    pub fn new() -> Host {
        Host::default()
    }

    /// Starts on `addr` ("127.0.0.1:0" picks a free port) and returns the port in use.
    pub fn start(&self, addr: &str, token: String, engine: Arc<SharedEngine>, hooks: Hooks) -> Result<u16, String> {
        self.stop();
        // a server of ours stopped a moment ago (off and on again, a restart) may still hold
        // the port: its listener closes shortly after it was told to
        let patient = self.stopped_at.lock().unwrap().is_some_and(|t| t.elapsed() < REBIND_FOR);
        let server = listen(addr, patient).map_err(|e| format!("cannot listen on {addr}: {e}"))?;
        let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
        let server = Arc::new(server);
        let stats = self.stats.clone();
        let srv = server.clone();
        let token = Arc::new(Mutex::new(token));
        let current = token.clone();
        let thread = std::thread::Builder::new()
            .name("meshkeep-mcp".into())
            .spawn(move || {
                while let Ok(req) = srv.recv() {
                    let token = current.lock().unwrap().clone();
                    serve(req, &token, &engine, &hooks, &stats);
                }
            })
            .map_err(|e| e.to_string())?;
        *self.running.lock().unwrap() = Some(Running {
            server,
            thread: Some(thread),
            port,
            token,
        });
        *self.error.lock().unwrap() = None;
        log::info!("MCP server listening on 127.0.0.1:{port}");
        Ok(port)
    }

    pub fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            log::info!("MCP server on port {} stopped", r.port);
            drop(r);
            *self.stopped_at.lock().unwrap() = Some(std::time::Instant::now());
        }
    }

    /// Starts, stops or moves the server so it matches the settings; a failure to bind is
    /// kept for the status line instead of failing the settings change.
    ///
    /// A server already listening on the configured port stays up: the switches are read
    /// from the engine with every request and a new token is swapped in, so nothing a
    /// settings change brings needs a restart except another port. Restarting on the same
    /// port would also race the old listener, which lets go of it only a moment after it
    /// was told to stop.
    pub fn apply(&self, settings: &meshkeep_engine::settings::McpSettings, engine: Arc<SharedEngine>, hooks: Hooks) {
        if !settings.enabled || settings.token.is_empty() {
            self.stop();
            *self.error.lock().unwrap() = None;
            return;
        }
        if let Some(r) = self.running.lock().unwrap().as_ref().filter(|r| r.port == settings.port) {
            *r.token.lock().unwrap() = settings.token.clone();
            *self.error.lock().unwrap() = None;
            return;
        }
        if let Err(e) = self.start(&format!("127.0.0.1:{}", settings.port), settings.token.clone(), engine, hooks) {
            log::warn!("{e}");
            *self.error.lock().unwrap() = Some(e);
        }
    }

    pub fn status(&self, configured_port: u16) -> McpStatus {
        let running = self.running.lock().unwrap();
        McpStatus {
            running: running.is_some(),
            port: running.as_ref().map(|r| r.port).unwrap_or(configured_port),
            error: self.error.lock().unwrap().clone(),
            requests: self.stats.requests.load(Ordering::Relaxed),
            rejected: self.stats.rejected.load(Ordering::Relaxed),
            last_request_at: self
                .stats
                .last_request_at
                .lock()
                .unwrap()
                .map(|t| t.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()),
        }
    }
}

type Reply = Response<std::io::Cursor<Vec<u8>>>;

fn json_reply(status: u16, body: String) -> Reply {
    Response::from_string(body)
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json").expect("static header"))
}

fn header<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

/// Browsers send an Origin; only the machine itself may talk to this port (DNS rebinding
/// protection as the MCP transport spec asks for).
fn origin_ok(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(o) => {
            let o = o.trim().to_ascii_lowercase();
            o == "null" || o.starts_with("http://localhost") || o.starts_with("http://127.0.0.1") || o.starts_with("http://[::1]")
        }
    }
}

/// Everything that can refuse a request before a tool runs: path, Origin, token, method,
/// body. `Ok` is the JSON-RPC message.
fn admit(req: &mut Request, token: &str, stats: &Stats) -> Result<serde_json::Value, Reply> {
    let path = req.url().split('?').next().unwrap_or("/");
    if path != "/mcp" && path != "/" {
        return Err(json_reply(404, r#"{"error":"not found"}"#.into()));
    }
    if !origin_ok(header(req, "Origin")) {
        stats.rejected.fetch_add(1, Ordering::Relaxed);
        return Err(json_reply(403, r#"{"error":"origin not allowed"}"#.into()));
    }
    let presented = header(req, "Authorization")
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(str::trim);
    if presented != Some(token) || token.is_empty() {
        stats.rejected.fetch_add(1, Ordering::Relaxed);
        return Err(json_reply(401, r#"{"error":"missing or wrong token"}"#.into())
            .with_header(Header::from_bytes("WWW-Authenticate", "Bearer").expect("static header")));
    }
    match req.method() {
        Method::Post => {}
        Method::Delete => return Err(json_reply(200, "{}".into())),
        _ => {
            return Err(json_reply(405, r#"{"error":"POST a JSON-RPC message"}"#.into())
                .with_header(Header::from_bytes("Allow", "POST, DELETE").expect("static header")))
        }
    }
    let mut body = String::new();
    if let Err(e) = req.as_reader().take(16 << 20).read_to_string(&mut body) {
        return Err(json_reply(400, format!(r#"{{"error":"{e}"}}"#)));
    }
    stats.requests.fetch_add(1, Ordering::Relaxed);
    *stats.last_request_at.lock().unwrap() = Some(time::OffsetDateTime::now_utc());
    serde_json::from_str(&body).map_err(|e| {
        json_reply(
            400,
            serde_json::json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("parse error: {e}") } })
                .to_string(),
        )
    })
}

/// Whether the client can take the answer as an event stream (it lists the type in
/// `Accept`) and speaks the HTTP version chunked transfer needs.
fn accepts_stream(req: &Request) -> bool {
    let version = req.http_version();
    (version.0, version.1) >= (1, 1) && header(req, "Accept").is_some_and(|a| a.to_ascii_lowercase().contains("text/event-stream"))
}

fn serve(mut req: Request, token: &str, engine: &Arc<SharedEngine>, hooks: &Hooks, stats: &Stats) {
    let message = match admit(&mut req, token, stats) {
        Ok(m) => m,
        Err(reply) => {
            let _ = req.respond(reply);
            return;
        }
    };
    if mcp::wants_progress(&message) && accepts_stream(&req) {
        // progress travels on the response itself: notifications as they happen, the result last
        let mut events = EventStream::open(req.into_writer());
        let response = run(&message, engine, hooks, Some(&mut |note| events.send(&note)));
        if let Some(r) = response {
            events.send(&r);
        }
        events.close();
        return;
    }
    let _ = req.respond(match run(&message, engine, hooks, None) {
        Some(r) => json_reply(200, r.to_string()),
        None => Response::from_string("").with_status_code(202),
    });
}

/// Hands one message to the engine and returns its response (none for notifications).
fn run(
    message: &serde_json::Value,
    engine: &Arc<SharedEngine>,
    hooks: &Hooks,
    mut notify: Option<&mut dyn FnMut(serde_json::Value)>,
) -> Option<serde_json::Value> {
    // the engine is locked inside, and for an import only to plan and to finish
    let outcome = {
        let ai_key = || (hooks.ai_key)();
        let streaming = notify.is_some();
        let mut relay = |note: serde_json::Value| {
            if let Some(n) = notify.as_mut() {
                n(note)
            }
        };
        let mut import_progress = |p: ImportProgress| (hooks.on_import)(p);
        mcp::handle_shared(
            engine,
            message,
            &mut mcp::Session {
                ai_key: Some(&ai_key),
                notify: if streaming { Some(&mut relay) } else { None },
                import_progress: Some(&mut import_progress),
            },
        )
    };
    // the AI provider is called without the engine lock, so the window keeps working meanwhile
    let outcome = outcome.finish();
    if !outcome.changes.is_empty() {
        (hooks.on_change)(&outcome.changes);
    }
    outcome.response
}

/// An HTTP response written by hand as server-sent events: tiny_http would buffer a body
/// until it is complete, and progress is only worth sending while the work is going on. Each
/// event is one chunk, flushed at once. A client that went away is not an error: the tool
/// finishes anyway, the rest is dropped.
struct EventStream<W: Write> {
    out: W,
    broken: bool,
}

impl<W: Write> EventStream<W> {
    fn open(out: W) -> EventStream<W> {
        let mut s = EventStream { out, broken: false };
        s.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\n\r\n");
        s
    }

    fn write(&mut self, bytes: &[u8]) {
        if !self.broken && self.out.write_all(bytes).and_then(|_| self.out.flush()).is_err() {
            self.broken = true;
        }
    }

    /// One JSON-RPC message as one event. Serialized JSON has no raw line breaks, so it
    /// fits the single `data:` line.
    fn send(&mut self, message: &serde_json::Value) {
        let event = format!("event: message\ndata: {message}\n\n");
        self.write(format!("{:x}\r\n{event}\r\n", event.len()).as_bytes());
    }

    fn close(mut self) {
        self.write(b"0\r\n\r\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Counts flushes, so the test can tell a stream from a buffered body.
    #[derive(Default)]
    struct Wire {
        bytes: Vec<u8>,
        flushes: usize,
        fail: bool,
    }

    impl Write for &mut Wire {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.fail {
                return Err(std::io::ErrorKind::BrokenPipe.into());
            }
            self.bytes.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    #[test]
    fn every_event_is_a_chunk_of_its_own_and_goes_out_at_once() {
        let mut wire = Wire::default();
        let mut events = EventStream::open(&mut wire);
        assert_eq!(events.out.flushes, 1, "the head is on the wire before the tool starts");
        events.send(&serde_json::json!({ "method": "notifications/progress", "params": { "message": "line\nbreak" } }));
        assert_eq!(events.out.flushes, 2);
        events.send(&serde_json::json!({ "id": 1, "result": {} }));
        assert_eq!(events.out.flushes, 3);
        events.close();
        let text = String::from_utf8(wire.bytes).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(head.contains("Content-Type: text/event-stream"));
        assert!(head.contains("Transfer-Encoding: chunked"));
        // chunks: <hex length>\r\n<payload>\r\n ... 0\r\n\r\n
        let mut rest = body;
        let mut payloads = Vec::new();
        loop {
            let (len, after) = rest.split_once("\r\n").unwrap();
            let len = usize::from_str_radix(len, 16).unwrap();
            if len == 0 {
                assert_eq!(after, "\r\n");
                break;
            }
            payloads.push(&after[..len]);
            rest = after[len..].strip_prefix("\r\n").unwrap();
        }
        assert_eq!(payloads.len(), 2);
        assert_eq!(
            payloads[0],
            "event: message\ndata: {\"method\":\"notifications/progress\",\"params\":{\"message\":\"line\\nbreak\"}}\n\n"
        );
        assert!(payloads[1].contains("\"result\""));
    }

    #[test]
    fn a_client_that_went_away_does_not_stop_the_work() {
        let mut wire = Wire {
            fail: true,
            ..Default::default()
        };
        let mut events = EventStream::open(&mut wire);
        events.send(&serde_json::json!({ "id": 1 }));
        events.close();
        assert!(wire.bytes.is_empty());
    }
}
