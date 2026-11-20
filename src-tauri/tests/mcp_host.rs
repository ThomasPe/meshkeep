//! The MCP endpoint over a real socket: token and Origin checks, JSON in and out, and the
//! change callback that keeps the window in sync.
use meshkeep_engine::settings::McpSettings;
use meshkeep_engine::Engine;
use meshkeep_lib::mcp_host::{Hooks, Host};
use std::sync::{Arc, Mutex};

#[test]
fn serves_mcp_over_http_with_a_token() {
    let data = tempfile::tempdir().unwrap();
    let mut engine = Engine::open(data.path()).unwrap();
    engine
        .set_mcp_settings(McpSettings {
            enabled: true,
            token: "secret-token".into(),
            allow_writes: false,
            ..Default::default()
        })
        .unwrap();
    let engine = Arc::new(Mutex::new(engine));
    let seen = Arc::new(Mutex::new(0usize));
    let counter = seen.clone();
    let key_reads = Arc::new(Mutex::new(0usize));
    let asked = key_reads.clone();
    let host = Host::new();
    let port = host
        .start(
            "127.0.0.1:0",
            "secret-token".into(),
            engine.clone(),
            Hooks {
                on_change: Arc::new(move |changes| *counter.lock().unwrap() += changes.len()),
                ai_key: Arc::new(move || {
                    *asked.lock().unwrap() += 1;
                    Ok(Some("sk-test".into()))
                }),
            },
        )
        .unwrap();
    assert!(port > 0);
    assert!(host.status(0).running);
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::blocking::Client::new();
    let post = |body: &str, token: Option<&str>, origin: Option<&str>| {
        let mut r = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Connection", "close")
            .body(body.to_string());
        if let Some(t) = token {
            r = r.header("Authorization", format!("Bearer {t}"));
        }
        if let Some(o) = origin {
            r = r.header("Origin", o);
        }
        r.send().unwrap()
    };
    let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#;

    // no token, wrong token, a web page's origin: refused before anything runs
    assert_eq!(post(init, None, None).status(), 401);
    assert_eq!(post(init, Some("other"), None).status(), 401);
    assert_eq!(post(init, Some("secret-token"), Some("https://evil.example")).status(), 403);
    assert_eq!(host.status(0).rejected, 3);

    let r = post(init, Some("secret-token"), Some("http://localhost:1420"));
    assert_eq!(r.status(), 200);
    let v: serde_json::Value = r.json().unwrap();
    assert_eq!(v["result"]["serverInfo"]["name"], "Meshkeep");
    assert_eq!(
        post(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            Some("secret-token"),
            None
        )
        .status(),
        202
    );
    let r = post(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, Some("secret-token"), None);
    let v: serde_json::Value = r.json().unwrap();
    assert!(v["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "search_projects"));
    assert!(
        !v["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "update_metadata"),
        "writes are off"
    );
    assert_eq!(post("not json", Some("secret-token"), None).status(), 400);
    assert_eq!(
        client
            .get(&url)
            .header("Authorization", "Bearer secret-token")
            .send()
            .unwrap()
            .status(),
        405
    );
    assert_eq!(client.post(format!("http://127.0.0.1:{port}/other")).send().unwrap().status(), 404);

    // a write through the socket reaches the change callback
    engine
        .lock()
        .unwrap()
        .set_mcp_settings(McpSettings {
            enabled: true,
            token: "secret-token".into(),
            allow_writes: true,
            ..Default::default()
        })
        .unwrap();
    let lib = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(lib.path().join("Vase")).unwrap();
    std::fs::write(lib.path().join("Vase/vase.stl"), b"solid").unwrap();
    let root = engine
        .lock()
        .unwrap()
        .add_root(lib.path(), meshkeep_engine::model::SyncMode::Manual)
        .unwrap();
    engine.lock().unwrap().scan_root(&root.id, |_| {}).unwrap();
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"update_metadata","arguments":{{"project_id":"{}:Vase","creator":"Agent"}}}}}}"#,
        root.id
    );
    let v: serde_json::Value = post(&body, Some("secret-token"), None).json().unwrap();
    assert_eq!(v["result"]["structuredContent"]["creator"], "Agent", "{v}");
    assert_eq!(*seen.lock().unwrap(), 1);
    assert!(host.status(0).requests >= 4);

    // the app's AI suggestion over the socket (#101): the key comes from the shell's store,
    // read only when an agent asks, and the provider is called outside the engine lock
    assert_eq!(*key_reads.lock().unwrap(), 0);
    {
        let mut engine = engine.lock().unwrap();
        engine.set_ai_provider(Some(Arc::new(meshkeep_engine::ai::MockProvider::new(
            meshkeep_engine::ai::MockMode::Ok,
        ))));
        engine
            .set_mcp_settings(McpSettings {
                enabled: true,
                token: "secret-token".into(),
                allow_writes: true,
                allow_ai: true,
                ..Default::default()
            })
            .unwrap();
    }
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"suggest_metadata","arguments":{{"project_id":"{}:Vase"}}}}}}"#,
        root.id
    );
    let v: serde_json::Value = post(&body, Some("secret-token"), None).json().unwrap();
    assert_eq!(v["result"]["structuredContent"]["creator"], "Mock Creator", "{v}");
    assert_eq!(*key_reads.lock().unwrap(), 1);
    assert_eq!(*seen.lock().unwrap(), 1, "a suggestion is not a change");

    // progress (#102): a tool call with a progress token, from a client that accepts an event
    // stream, is answered as one: the notifications first, the result last
    std::fs::create_dir_all(lib.path().join("Vase copy")).unwrap();
    std::fs::write(lib.path().join("Vase copy/vase.stl"), b"solid").unwrap();
    engine.lock().unwrap().scan_root(&root.id, |_| {}).unwrap();
    let duplicates = r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"find_duplicates","arguments":{},"_meta":{"progressToken":"dup"}}}"#;
    let r = client
        .post(&url)
        .header("Authorization", "Bearer secret-token")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(duplicates)
        .send()
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["content-type"], "text/event-stream");
    let events: Vec<serde_json::Value> = r
        .text()
        .unwrap()
        .split("\n\n")
        .filter(|e| !e.trim().is_empty())
        .map(|e| {
            let data = e.lines().find_map(|l| l.strip_prefix("data: ")).expect("every event carries data");
            assert!(e.starts_with("event: message\n"), "{e}");
            serde_json::from_str(data).unwrap()
        })
        .collect();
    assert_eq!(events.len(), 3, "{events:?}");
    assert_eq!(events[0]["method"], "notifications/progress");
    assert_eq!(events[0]["params"]["progressToken"], "dup");
    assert_eq!(events[0]["params"]["progress"], 0.0);
    assert_eq!(events[1]["params"]["progress"], 2.0);
    assert_eq!(events[2]["id"], 5);
    assert_eq!(events[2]["result"]["structuredContent"]["hashed"], 2, "{}", events[2]);
    // the connection stays usable after a stream (the chunked body ended properly)
    assert_eq!(
        client
            .post(&url)
            .header("Authorization", "Bearer secret-token")
            .body(r#"{"jsonrpc":"2.0","id":6,"method":"ping"}"#)
            .send()
            .unwrap()
            .json::<serde_json::Value>()
            .unwrap()["id"],
        6
    );
    // a client that does not accept a stream, or sent no token, gets plain JSON as before
    let v: serde_json::Value = post(duplicates, Some("secret-token"), None).json().unwrap();
    assert_eq!(v["result"]["structuredContent"]["groups"].as_array().unwrap().len(), 1, "{v}");
    let r = client
        .post(&url)
        .header("Authorization", "Bearer secret-token")
        .header("Accept", "application/json, text/event-stream")
        .body(r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"find_duplicates","arguments":{}}}"#)
        .send()
        .unwrap();
    assert_eq!(r.headers()["content-type"], "application/json");
    // and it is a stream on the wire, not a body sent at the end: the head arrives while the
    // tool has not even started (the test holds the engine), the result once it could run
    {
        use std::io::{Read, Write};
        let body = r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"find_duplicates","arguments":{},"_meta":{"progressToken":1}}}"#;
        let busy = engine.lock().unwrap();
        let mut socket = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
        write!(
            socket,
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer secret-token\r\nAccept: text/event-stream\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).expect("the response head arrives before the tool ran");
            head.push(byte[0]);
        }
        let head = String::from_utf8(head).unwrap();
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert!(head.contains("text/event-stream"), "{head}");
        drop(busy);
        let mut rest = String::new();
        socket.read_to_string(&mut rest).unwrap();
        assert!(rest.contains(r#""id":8"#), "{rest}");
        assert!(rest.ends_with("0\r\n\r\n"), "the chunked body is closed: {rest:?}");
    }
    // through the stdio bridge every message of the stream is a line of its own, in order
    engine.lock().unwrap().scan_root(&root.id, |_| {}).unwrap();
    std::fs::write(lib.path().join("Vase/vase.stl"), b"SOLID").unwrap();
    std::fs::write(lib.path().join("Vase copy/vase.stl"), b"SOLID").unwrap();
    engine.lock().unwrap().scan_root(&root.id, |_| {}).unwrap();
    let mut lines = Vec::new();
    meshkeep_lib::mcp_bridge::forward_each(&reqwest::blocking::Client::new(), &url, "secret-token", duplicates, &mut |l| {
        lines.push(l)
    });
    assert!(lines.len() >= 2, "{lines:?}");
    assert!(lines.iter().all(|l| !l.contains('\n')));
    assert!(lines[0].contains("notifications/progress"), "{lines:?}");
    let last: serde_json::Value = serde_json::from_str(lines.last().unwrap()).unwrap();
    assert_eq!(last["id"], 5);
    assert!(last["result"]["structuredContent"]["groups"].is_array());

    // the stdio bridge forwards one line and turns transport trouble into JSON-RPC errors
    let bridge = reqwest::blocking::Client::new();
    let line = meshkeep_lib::mcp_bridge::forward(&bridge, &url, "secret-token", r#"{"jsonrpc":"2.0","id":"a","method":"ping"}"#).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&line).unwrap()["result"],
        serde_json::json!({})
    );
    assert!(!line.contains('\n'), "one line per message");
    assert!(meshkeep_lib::mcp_bridge::forward(
        &bridge,
        &url,
        "secret-token",
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
    )
    .is_none());
    let bad = meshkeep_lib::mcp_bridge::forward(&bridge, &url, "wrong", r#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#).unwrap();
    let bad: serde_json::Value = serde_json::from_str(&bad).unwrap();
    assert_eq!(bad["id"], 7);
    assert!(bad["error"]["message"].as_str().unwrap().contains("token"));
    assert!(
        meshkeep_lib::mcp_bridge::forward(&bridge, &url, "wrong", r#"{"jsonrpc":"2.0","method":"notifications/x"}"#).is_none(),
        "no id, no answer"
    );

    host.stop();
    // the accept thread lets go of the port on its own a moment later
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(!host.status(7340).running);
    assert!(
        std::net::TcpStream::connect(("127.0.0.1", port)).is_err(),
        "nothing listens after stop"
    );
    let down = meshkeep_lib::mcp_bridge::forward(&bridge, &url, "secret-token", r#"{"jsonrpc":"2.0","id":8,"method":"ping"}"#).unwrap();
    assert!(down.contains("not running"), "{down}");
}
