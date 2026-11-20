//! `meshkeep --mcp [url] [token]`: a stdio MCP server for clients that only launch commands
//! (Claude Desktop). Each line on stdin is forwarded to the running app's HTTP endpoint and
//! the answer written back as one line; when the app answers with an event stream (progress
//! of a long tool, #102), every message of it becomes a line as it arrives. Nothing else may
//! touch stdout: it is the protocol channel. The token can also come from
//! `MESHKEEP_MCP_TOKEN`.

use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

pub const DEFAULT_URL: &str = "http://127.0.0.1:7340/mcp";

/// The app execution alias the MSIX registers (`msix/AppxManifest.xml`).
pub const ALIAS: &str = "meshkeep.exe";

/// The command an MCP client launches for this bridge, as Settings shows it.
///
/// Normally that is the running exe. In an MSIX install the exe lives below `WindowsApps`
/// in a folder named after the package version, so a path copied into a client's
/// configuration would break with every Store update. There the answer is the app
/// execution alias in `%LOCALAPPDATA%\Microsoft\WindowsApps`, which stays put and is the
/// supported way for another program to start a packaged exe; without `LOCALAPPDATA` the
/// bare alias name, since that folder is on the user's `PATH`.
/// Works on strings so the Windows paths can be tested on any platform.
pub fn client_command(exe: &str, local_app_data: Option<&str>) -> String {
    if !exe.to_ascii_lowercase().contains("\\windowsapps\\") {
        return exe.to_string();
    }
    match local_app_data.map(|d| d.trim_end_matches('\\')).filter(|d| !d.is_empty()) {
        Some(dir) => format!("{dir}\\Microsoft\\WindowsApps\\{ALIAS}"),
        None => ALIAS.to_string(),
    }
}

/// Runs until stdin closes. Returns the process exit code.
pub fn run(url: &str, token: &str) -> i32 {
    let client = match reqwest::blocking::Client::builder().timeout(Duration::from_secs(900)).build() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("meshkeep --mcp: {e}");
            return 2;
        }
    };
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let mut closed = false;
        forward_each(&client, url, token, &line, &mut |text| {
            let mut out = stdout.lock();
            if out
                .write_all(text.as_bytes())
                .and_then(|_| out.write_all(b"\n"))
                .and_then(|_| out.flush())
                .is_err()
            {
                closed = true;
            }
        });
        if closed {
            break;
        }
    }
    0
}

/// One message in, its answer out: the last line `forward_each` produces. For a request
/// that is the response, after any progress notifications.
pub fn forward(client: &reqwest::blocking::Client, url: &str, token: &str, line: &str) -> Option<String> {
    let mut last = None;
    forward_each(client, url, token, line, &mut |text| last = Some(text));
    last
}

/// One message in; every message the app sends back for it goes to `emit` as one line, in
/// order and as it arrives: nothing for a notification, the response for a request, and
/// before it the progress notifications of a long tool. Transport failures become a
/// JSON-RPC error for the request's id so the client shows the reason instead of hanging.
pub fn forward_each(client: &reqwest::blocking::Client, url: &str, token: &str, line: &str, emit: &mut dyn FnMut(String)) {
    let id = serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .filter(|v| !v.is_null());
    let result = client
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("Connection", "close")
        .body(line.to_string())
        .send();
    let fail = |message: String| {
        id.as_ref()
            .map(|id| serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message } }).to_string())
    };
    let answer = match result {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let streamed = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|c| c.to_str().ok())
                .is_some_and(|c| c.trim_start().to_ascii_lowercase().starts_with("text/event-stream"));
            if status == 200 && streamed {
                if relay_events(BufReader::new(resp), id.as_ref(), emit) {
                    None
                } else {
                    fail("the connection to Meshkeep ended before the answer arrived".into())
                }
            } else {
                let body = resp.text().unwrap_or_default();
                match status {
                    200 => serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .map(|v| v.to_string())
                        .or_else(|| fail("Meshkeep returned something that is not JSON".into())),
                    202 => None,
                    401 => fail("Meshkeep rejected the token; copy the current one from Settings → MCP server".into()),
                    _ => fail(format!("Meshkeep answered {status}: {}", body.trim())),
                }
            }
        }
        Err(e) => fail(if e.is_connect() {
            format!("Meshkeep is not running or its MCP server is off ({url}); start the app and enable the server in Settings")
        } else {
            format!("cannot reach Meshkeep: {e}")
        }),
    };
    if let Some(text) = answer {
        emit(text);
    }
}

/// Reads server-sent events and hands the JSON-RPC message of each on as one line. Returns
/// whether the answer to `id` was among them (a stream that breaks off earlier is a failure
/// the caller reports). Fields other than `data` and comments are skipped.
fn relay_events(reader: impl BufRead, id: Option<&serde_json::Value>, emit: &mut dyn FnMut(String)) -> bool {
    let mut answered = false;
    let mut data = String::new();
    let mut dispatch = |data: &mut String| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
            if id.is_some() && v.get("id") == id && (v.get("result").is_some() || v.get("error").is_some()) {
                answered = true;
            }
            emit(v.to_string());
        }
        data.clear();
    };
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.is_empty() {
            if !data.is_empty() {
                dispatch(&mut data);
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    if !data.is_empty() {
        dispatch(&mut data);
    }
    answered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_event_stream_becomes_one_line_per_message() {
        let id = serde_json::json!(5);
        let stream =
            "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":1}}\r\n\r\n\
: a comment\n\
id: 17\n\
data: {\"jsonrpc\":\"2.0\",\n\
data:  \"id\":5,\"result\":{\"text\":\"a\\nb\"}}\n\n\
data: not json\n\n";
        let mut lines = Vec::new();
        assert!(relay_events(stream.as_bytes(), Some(&id), &mut |l| lines.push(l)));
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("notifications/progress"));
        assert!(lines[1].contains("\"id\":5"));
        assert!(lines.iter().all(|l| !l.contains('\n')), "one line per message");

        // a stream that breaks off before the answer is a failure, not a silent end
        let cut = "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":1}}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":6,\"result\":{}}\n\n";
        let mut lines = Vec::new();
        assert!(!relay_events(cut.as_bytes(), Some(&id), &mut |l| lines.push(l)));
        assert_eq!(lines.len(), 2);
        // the last event counts even without the closing blank line
        let mut lines = Vec::new();
        assert!(relay_events(
            "data: {\"jsonrpc\":\"2.0\",\"id\":5,\"error\":{\"code\":-1,\"message\":\"x\"}}".as_bytes(),
            Some(&id),
            &mut |l| lines.push(l)
        ));
        assert_eq!(lines.len(), 1);
    }

    #[test]
    fn an_installed_or_dev_exe_is_launched_by_its_own_path() {
        let nsis = r"C:\Users\me\AppData\Local\Meshkeep\meshkeep.exe";
        assert_eq!(client_command(nsis, Some(r"C:\Users\me\AppData\Local")), nsis);
        assert_eq!(client_command("/usr/bin/meshkeep", None), "/usr/bin/meshkeep");
    }

    #[test]
    fn a_packaged_exe_is_launched_through_its_alias() {
        let packaged = r"C:\Program Files\WindowsApps\12345DevSym.Meshkeep_0.2.1.0_x64__abcdefgh12345\meshkeep.exe";
        let alias = r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\meshkeep.exe";
        assert_eq!(client_command(packaged, Some(r"C:\Users\me\AppData\Local")), alias);
        assert_eq!(client_command(packaged, Some(r"C:\Users\me\AppData\Local\")), alias);
        // Apps moved to another drive live in `<drive>:\WindowsApps`.
        let moved = r"D:\WindowsApps\12345DevSym.Meshkeep_0.2.1.0_x64__abcdefgh12345\meshkeep.exe";
        assert_eq!(client_command(moved, Some(r"C:\Users\me\AppData\Local")), alias);
        // No LOCALAPPDATA: the alias folder is on the user's PATH.
        assert_eq!(client_command(packaged, None), "meshkeep.exe");
        assert_eq!(client_command(packaged, Some("")), "meshkeep.exe");
    }
}
