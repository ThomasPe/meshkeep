use meshkeep_engine::model::SyncMode;
use meshkeep_engine::watch::{RootWatcher, WatchEvent};
use meshkeep_engine::SharedEngine;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Startup configuration. Test mode isolates all app data and can seed a fixture root so
/// agent-driven E2E runs are deterministic (docs/spec/04-quality.md).
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub test_mode: bool,
    pub data_dir_override: Option<PathBuf>,
    pub fixture_root: Option<PathBuf>,
    /// Test mode only: `MESHKEEP_AI_MOCK` swaps the hosted AI client for canned answers.
    pub ai_mock: Option<meshkeep_engine::ai::MockMode>,
}

impl RuntimeConfig {
    pub fn from_env_and_args() -> RuntimeConfig {
        let args: Vec<String> = std::env::args().collect();
        let test_mode = args.iter().any(|a| a == "--test-mode") || std::env::var("MESHKEEP_TEST_MODE").map(|v| v == "1").unwrap_or(false);
        let data_dir_override = std::env::var_os("MESHKEEP_DATA_DIR").map(PathBuf::from);
        let fixture_root = std::env::var_os("MESHKEEP_FIXTURE_ROOT").map(PathBuf::from);
        let ai_mock = std::env::var("MESHKEEP_AI_MOCK")
            .ok()
            .and_then(|v| meshkeep_engine::ai::MockMode::parse(&v));
        if ai_mock.is_some() && !test_mode {
            log::warn!("MESHKEEP_AI_MOCK ignored outside test mode");
        }
        RuntimeConfig {
            test_mode,
            data_dir_override,
            fixture_root,
            ai_mock: ai_mock.filter(|_| test_mode),
        }
    }

    pub fn resolve_data_dir(&self, app: &AppHandle) -> tauri::Result<PathBuf> {
        if let Some(d) = &self.data_dir_override {
            return Ok(d.clone());
        }
        if self.test_mode {
            let d = std::env::temp_dir().join(format!("meshkeep-test-{}", std::process::id()));
            return Ok(d);
        }
        app.path().app_data_dir()
    }
}

pub struct AppState {
    pub engine: Arc<SharedEngine>,
    pub watchers: Mutex<HashMap<String, RootWatcher>>,
    pub watch_tx: mpsc::Sender<WatchEvent>,
    /// Scans the shell started on its own (catch-up at start, repair after a missing folder).
    pub sync: Mutex<BackgroundSync>,
    pub ai_keys: crate::keys::AiKeyStore,
    pub config: RuntimeConfig,
    pub data_dir: PathBuf,
    /// The local MCP endpoint (ADR-0004); runs only while the setting is on.
    pub mcp: crate::mcp_host::Host,
}

/// Which roots a background scan is reading right now, and when each was last repaired.
#[derive(Default)]
pub struct BackgroundSync {
    running: HashSet<String>,
    repaired: HashMap<String, Instant>,
}

/// A root is repaired at most this often. After a scan the index matches the disk, so a
/// second missing file within the interval is something a scan does not fix (a file that
/// vanishes again and again, a volume that drops out); it must not scan in a loop.
const REPAIR_INTERVAL: Duration = Duration::from_secs(30);

/// Starts or stops the MCP server to match the stored settings, and wires its changes to
/// the same events the commands emit, so the window follows what an agent does.
pub fn apply_mcp_settings(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.engine.lock().unwrap().mcp_settings();
    let handle = app.clone();
    let on_change: crate::mcp_host::OnChange = Arc::new(move |changes: &[meshkeep_engine::mcp::Change]| {
        for c in changes {
            match c {
                meshkeep_engine::mcp::Change::Project(id) => {
                    let _ = handle.emit("project://changed", serde_json::json!({ "projectId": id }));
                }
                meshkeep_engine::mcp::Change::Library { root_id, reason } => {
                    let _ = handle.emit(
                        "library://changed",
                        serde_json::json!({ "rootId": root_id, "report": serde_json::Value::Null, "reason": reason }),
                    );
                    if reason == "import" || reason == "promote" {
                        if let Some(r) = root_id {
                            let _ = handle.emit("inbox://changed", serde_json::json!({ "rootId": r }));
                        }
                    }
                    if reason == "collection" {
                        let _ = handle.emit("collections://changed", serde_json::json!({}));
                    }
                }
            }
        }
    });
    // an agent's AI suggestion uses the key the user stored, read when it is needed (#101);
    // an import it starts shows in the window like the window's own
    let keys = app.clone();
    let progress_handle = app.clone();
    let hooks = crate::mcp_host::Hooks {
        on_change,
        ai_key: Arc::new(move || keys.state::<AppState>().ai_keys.get()),
        on_import: Arc::new(move |p| {
            let _ = progress_handle.emit("import://progress", &p);
        }),
    };
    state.mcp.apply(&settings, state.engine.clone(), hooks);
}

/// In test mode with `MESHKEEP_FIXTURE_ROOT` set: register that folder (once) and scan it.
pub fn seed_test_fixture(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(fixture) = state.config.fixture_root.clone() else { return };
    if !state.config.test_mode {
        log::warn!("MESHKEEP_FIXTURE_ROOT ignored outside test mode");
        return;
    }
    let mut engine = state.engine.lock().unwrap();
    let id = match engine.add_root(&fixture, SyncMode::Manual) {
        Ok(r) => r.id,
        Err(meshkeep_engine::EngineError::RootExists(_)) => engine
            .roots()
            .ok()
            .and_then(|rs| rs.into_iter().find(|r| r.path == fixture).map(|r| r.id))
            .unwrap_or_default(),
        Err(e) => {
            log::error!("fixture root {}: {e}", fixture.display());
            return;
        }
    };
    match engine.scan_root_as(&id, "startup", |_| {}) {
        Ok(r) => log::info!("fixture root scanned: {} projects", r.projects),
        Err(e) => log::error!("fixture scan failed: {e}"),
    }
}

/// Start a watcher for every root in `watch` mode. Failures (e.g. network shares) are logged
/// and surfaced as an event; the root keeps working with manual rescans.
pub fn start_watchers(app: &AppHandle) {
    let state = app.state::<AppState>();
    let roots = { state.engine.lock().unwrap().roots().unwrap_or_default() };
    for root in roots {
        if root.mode == SyncMode::Watch {
            start_watcher_for(app, &root.id);
        }
    }
}

pub fn start_watcher_for(app: &AppHandle, root_id: &str) {
    let state = app.state::<AppState>();
    let result = { state.engine.lock().unwrap().start_watch(root_id, state.watch_tx.clone()) };
    match result {
        Ok(w) => {
            state.watchers.lock().unwrap().insert(root_id.to_string(), w);
            log::info!("watching root {root_id}");
        }
        Err(e) => {
            log::warn!("cannot watch root {root_id}: {e}");
            let msg = format!("cannot watch for changes ({e}); switch this folder to Poll");
            let _ = state.engine.lock().unwrap().set_root_error(root_id, &msg);
            let _ = app.emit("watch://error", serde_json::json!({ "rootId": root_id, "message": msg }));
        }
    }
}

pub fn stop_watcher_for(app: &AppHandle, root_id: &str) {
    let state = app.state::<AppState>();
    state.watchers.lock().unwrap().remove(root_id);
}

/// Receives debounced file-system events and rescans the affected root, then tells the UI.
pub fn spawn_watch_loop(app: AppHandle, rx: mpsc::Receiver<WatchEvent>) {
    std::thread::Builder::new()
        .name("meshkeep-watch".into())
        .spawn(move || {
            while let Ok(ev) = rx.recv() {
                log::debug!("fs change in {}: {} paths", ev.root_id, ev.paths.len());
                let state = app.state::<AppState>();
                let result = { state.engine.lock().unwrap().rescan_for_event(&ev) };
                match result {
                    Ok(report) => {
                        let _ = app.emit("library://changed", serde_json::json!({ "rootId": ev.root_id, "report": report, "reason": "watch" }));
                    }
                    Err(e) => {
                        log::warn!("rescan after change failed: {e}");
                        let _ = app.emit("library://changed", serde_json::json!({ "rootId": ev.root_id, "report": serde_json::Value::Null, "reason": "watch", "error": e.to_string() }));
                    }
                }
            }
        })
        .expect("spawn watch thread");
}

/// Reads roots again on a thread of their own, one after the other, and tells the window:
/// `scan://progress` while a root is read, `library://changed` with `reason` when it is done
/// (with `error` when it could not be read, e.g. an offline drive). The disk is read without
/// the engine lock (`SharedEngine::scan_root`), so the window is not kept waiting. A root
/// that such a scan is already reading is skipped.
pub fn sync_in_background(app: &AppHandle, root_ids: Vec<String>, reason: &'static str) {
    if root_ids.is_empty() {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("meshkeep-sync".into()).spawn(move || {
        let state = app.state::<AppState>();
        for root_id in root_ids {
            if !state.sync.lock().unwrap().running.insert(root_id.clone()) {
                continue;
            }
            let mut last = Instant::now() - Duration::from_secs(1);
            let result = state.engine.scan_root(&root_id, reason, |p| {
                if last.elapsed() >= Duration::from_millis(100) {
                    last = Instant::now();
                    let _ = app.emit("scan://progress", &p);
                }
            });
            state.sync.lock().unwrap().running.remove(&root_id);
            match result {
                Ok(report) => {
                    log::info!("{reason} scan of {root_id}: {} projects in {} ms", report.projects, report.millis);
                    let _ = app.emit("library://changed", serde_json::json!({ "rootId": root_id, "report": report, "reason": reason }));
                }
                Err(e) => {
                    log::warn!("{reason} scan of {root_id} failed: {e}");
                    let _ = app.emit(
                        "library://changed",
                        serde_json::json!({ "rootId": root_id, "report": serde_json::Value::Null, "reason": reason, "error": e.to_string() }),
                    );
                }
            }
        }
    });
    if let Err(e) = spawned {
        log::error!("cannot start the sync thread: {e}");
    }
}

/// LIB-3: a watcher only sees what happens while the app runs. What was moved, renamed or
/// deleted while it was closed is caught up here, once, for every watched root.
pub fn spawn_startup_sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let roots = { state.engine.lock().unwrap().roots_to_catch_up() };
    sync_in_background(app, roots, "startup");
}

/// The index named a folder or file that is gone from an online root (`Engine::stale_root`):
/// the library was changed outside the app and nothing has reported it yet (a manual root, a
/// polled one between two polls, an event the watcher missed). Reads that root again; the
/// window then shows what is there and says why (`reason: "resync"`).
pub fn repair_root(app: &AppHandle, root_id: &str) {
    let state = app.state::<AppState>();
    {
        let mut sync = state.sync.lock().unwrap();
        if sync.running.contains(root_id) || sync.repaired.get(root_id).is_some_and(|t| t.elapsed() < REPAIR_INTERVAL) {
            return;
        }
        sync.repaired.insert(root_id.to_string(), Instant::now());
    }
    log::info!("root {root_id}: the index names something that is gone from disk, reading it again");
    sync_in_background(app, vec![root_id.to_string()], "resync");
}

/// Polled roots (LIB-4): every 30 s, rescan the roots whose interval has elapsed. Network
/// shares that cannot be watched end up here. Scans run one at a time under the engine lock.
pub fn spawn_poll_loop(app: AppHandle) {
    std::thread::Builder::new()
        .name("meshkeep-poll".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            let state = app.state::<AppState>();
            let due = { state.engine.lock().unwrap().poll_due(time::OffsetDateTime::now_utc()) };
            for root_id in due {
                log::debug!("poll: rescanning {root_id}");
                let result = { state.engine.lock().unwrap().scan_root(&root_id, |_| {}) };
                match result {
                    Ok(report) => {
                        let _ = app.emit(
                            "library://changed",
                            serde_json::json!({ "rootId": root_id, "report": report, "reason": "poll" }),
                        );
                    }
                    Err(e) => log::warn!("poll rescan of {root_id} failed: {e}"),
                }
            }
        })
        .expect("spawn poll thread");
}
