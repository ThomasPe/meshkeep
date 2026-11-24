use meshkeep_engine::model::SyncMode;
use meshkeep_engine::watch::{RootWatcher, Seen, WatchBook, WatchEvent, DEBOUNCE};
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
    /// The watchers of the roots, and what decides whether a started one may be installed
    /// (`WatchBook`). Lock order everywhere: this, then the engine.
    pub watching: Mutex<WatchBook<RootWatcher>>,
    pub watch_tx: mpsc::Sender<WatchEvent>,
    /// Scans the shell started on its own (catch-up at start, repair after a missing folder).
    pub sync: Mutex<BackgroundSync>,
    pub ai_keys: crate::keys::AiKeyStore,
    pub config: RuntimeConfig,
    pub data_dir: PathBuf,
    /// The local MCP endpoint (ADR-0004); runs only while the setting is on.
    pub mcp: crate::mcp_host::Host,
}

/// Which roots a background scan is reading right now, and what repairs could not fix.
#[derive(Default)]
pub struct BackgroundSync {
    running: HashSet<String>,
    /// A scan to run right after the one that is reading the root (see `scan_and_tell`).
    queued: HashMap<String, &'static str>,
    /// Watched roots whose folder is being asked for right now (`follow_watched_roots`).
    probing: HashSet<String>,
    /// Roots whose watcher is being replaced (`restart_watcher`); `true` when another
    /// replacement was asked for meanwhile and has to follow.
    restarting: HashMap<String, bool>,
    /// Missing folders and files (`project id` + file) that were still missing after the
    /// root was read again. A scan does not fix these, so they start no further one.
    unfixable: HashSet<String>,
    /// Roots whose last repair failed or changed nothing, and when.
    paused: HashMap<String, Instant>,
}

/// How long a root starts no repair after one that did not help. A repair that helped is
/// followed by the next one at once: after it the index matched the disk, so something that
/// is missing now was changed since. One that did not help (the scan failed, or it still
/// lists what cannot be read) would otherwise run again on every access.
const REPAIR_PAUSE: Duration = Duration::from_secs(30);

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
        ai_key: Arc::new(move |provider| keys.state::<AppState>().ai_keys.get(provider)),
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

/// How `start_watcher_for` ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchStart {
    Started,
    /// The folder is there and cannot be watched (network shares often); the user was told.
    Failed,
    /// The root is gone or not in watch mode: nothing was started.
    NotWatched,
    /// The folder is not reachable; `follow_watched_roots` starts the watcher when it is back.
    Unreachable,
    /// While this start was under way the root's watcher was stopped, its mode changed or a
    /// newer start began. What this one found (a watcher, a failure, a missing folder) is
    /// about a state that is over, and nothing of it was recorded.
    Overtaken,
}

/// Starts the watcher of one root, if the root is in watch mode. A root whose folder is not
/// reachable (a drive that is not plugged in) is not a root that cannot be watched: it gets
/// no "switch to Poll" notice.
///
/// The folder is asked for and the watch registered without any lock: a share can hang, and
/// a recursive watch is registered folder by folder on Linux, which must stop neither the
/// window nor the other roots. The start takes a ticket from the `WatchBook` first and its
/// result counts only if that ticket is still current when it comes back, so a start that
/// outlives a stop, a change of mode (`change_root`) or a newer start installs no watcher
/// and leaves no "cannot be watched" note on a root that is fine.
pub fn start_watcher_for(app: &AppHandle, root_id: &str) -> WatchStart {
    let state = app.state::<AppState>();
    let (root, ticket) = {
        let mut watching = state.watching.lock().unwrap();
        let root = state.engine.lock().unwrap().root(root_id).ok();
        let Some(root) = root.filter(|r| r.mode == SyncMode::Watch) else {
            return WatchStart::NotWatched;
        };
        (root, watching.begin(root_id))
    };
    if !root.path.is_dir() {
        if !state.watching.lock().unwrap().unreachable(root_id, ticket) {
            return WatchStart::Overtaken;
        }
        log::info!("root {root_id} is not reachable; its watcher starts when it is back");
        return WatchStart::Unreachable;
    }
    let started = RootWatcher::start(root.id.clone(), ticket, &root.path, DEBOUNCE, state.watch_tx.clone());
    let mut watching = state.watching.lock().unwrap();
    match started {
        Ok(watcher) => {
            if !watching.install(root_id, ticket, watcher) {
                return WatchStart::Overtaken;
            }
            let _ = state.engine.lock().unwrap().set_watch_error(root_id, None);
            log::info!("watching root {root_id}");
            WatchStart::Started
        }
        Err(e) => {
            if !watching.is_current(root_id, ticket) {
                return WatchStart::Overtaken;
            }
            // The folder was there a moment ago. If it is gone now, the start failed because
            // the drive dropped out while the watch was registered, not because the folder
            // cannot be watched: no "switch to Poll" note, which would outlive every scan
            // with nobody trying again. The root is lost, and the looks bring it back.
            if !root.path.is_dir() {
                watching.unreachable(root_id, ticket);
                log::info!("root {root_id} dropped out while its watcher was starting ({e})");
                return WatchStart::Unreachable;
            }
            log::warn!("cannot watch root {root_id}: {e}");
            let msg = format!("cannot watch for changes ({e}); switch this folder to Poll");
            // kept through the scans that follow, until a watcher starts or the mode changes
            let _ = state.engine.lock().unwrap().set_watch_error(root_id, Some(&msg));
            let _ = app.emit("watch://error", serde_json::json!({ "rootId": root_id, "message": msg }));
            WatchStart::Failed
        }
    }
}

/// Changes a root in the engine (its mode, or removes it) and stops its watcher, as one
/// step with respect to `start_watcher_for`: a start that is under way is overtaken by it.
/// If the change fails, the watcher stays.
pub fn change_root<T>(
    app: &AppHandle,
    root_id: &str,
    change: impl FnOnce(&mut meshkeep_engine::Engine) -> meshkeep_engine::Result<T>,
) -> meshkeep_engine::Result<T> {
    let state = app.state::<AppState>();
    let mut watching = state.watching.lock().unwrap();
    let out = change(&mut state.engine.lock().unwrap())?;
    watching.stop(root_id);
    Ok(out)
}

pub fn stop_watcher_for(app: &AppHandle, root_id: &str) {
    let state = app.state::<AppState>();
    state.watching.lock().unwrap().stop(root_id);
}

/// Receives debounced file-system events and rescans the affected root, then tells the UI.
pub fn spawn_watch_loop(app: AppHandle, rx: mpsc::Receiver<WatchEvent>) {
    std::thread::Builder::new()
        .name("meshkeep-watch".into())
        .spawn(move || {
            while let Ok(ev) = rx.recv() {
                log::debug!("fs change in {}: {} paths", ev.root_id, ev.paths.len());
                // What the watcher says about itself comes first: both cases end in a scan of
                // the whole root, which covers the changed paths of this batch as well. Neither
                // is handled on this thread, which serves every root: replacing a watcher asks
                // for a folder and registers a watch, and both can take long.
                if ev.root_gone || ev.missed {
                    // a watcher that was replaced since has nothing to say about the new one;
                    // one that is started and not installed yet does (`WatchBook::is_live`)
                    let live = { app.state::<AppState>().watching.lock().unwrap().is_live(&ev.root_id, ev.instance) };
                    if !live {
                        log::debug!("root {}: ignoring what a replaced watcher says about itself", ev.root_id);
                    } else if ev.root_gone {
                        log::info!("root {}: its folder was removed or renamed; replacing the watcher", ev.root_id);
                        restart_watcher(&app, &ev.root_id);
                    } else {
                        log::info!("root {}: the watcher lost events; reading the root", ev.root_id);
                        catch_up(&app, &ev.root_id);
                    }
                    continue;
                }
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

/// How a background scan of one root ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scan {
    Done,
    Failed,
    /// Another background scan is reading this root; nothing was done.
    Busy,
}

/// Reads one root again and tells the window (`scan_once`). If another background scan is
/// reading the root, nothing is done and the answer is `Busy`; with `queue`, the scan is
/// then run by that other one right after its own. A catch-up needs that: the scan that is
/// running may have passed a folder before it changed, and the watcher that just started
/// only sees what changes from now on.
fn scan_and_tell(app: &AppHandle, root_id: &str, reason: &'static str, queue: bool) -> Scan {
    let state = app.state::<AppState>();
    {
        let mut sync = state.sync.lock().unwrap();
        if !sync.running.insert(root_id.to_string()) {
            if queue {
                sync.queued.insert(root_id.to_string(), reason);
            }
            return Scan::Busy;
        }
    }
    let outcome = scan_once(app, root_id, reason);
    loop {
        // one lock for "anything queued?" and "no longer running": a scan queued after the
        // look would otherwise wait for nobody
        let next = {
            let mut sync = state.sync.lock().unwrap();
            let next = sync.queued.remove(root_id);
            if next.is_none() {
                sync.running.remove(root_id);
            }
            next
        };
        match next {
            Some(reason) => scan_once(app, root_id, reason),
            None => return outcome,
        };
    }
}

/// One scan of one root: `scan://progress` while it is read (a first one with no projects
/// right away, so a root that is empty or slow to reach its first project shows as being
/// scanned too), `library://changed` with `reason` when it is done (with `error` when it
/// could not be read, e.g. an offline drive). The disk is read without the engine lock
/// (`SharedEngine::scan_root`), so the window is not kept waiting.
fn scan_once(app: &AppHandle, root_id: &str, reason: &'static str) -> Scan {
    let state = app.state::<AppState>();
    let _ = app.emit(
        "scan://progress",
        meshkeep_engine::ScanProgress {
            root_id: root_id.to_string(),
            projects_found: 0,
        },
    );
    let mut last = Instant::now();
    let result = state.engine.scan_root(root_id, reason, |p| {
        if last.elapsed() >= Duration::from_millis(100) {
            last = Instant::now();
            let _ = app.emit("scan://progress", &p);
        }
    });
    match result {
        Ok(report) => {
            log::info!("{reason} scan of {root_id}: {} projects in {} ms", report.projects, report.millis);
            let _ = app.emit(
                "library://changed",
                serde_json::json!({ "rootId": root_id, "report": report, "reason": reason }),
            );
            Scan::Done
        }
        Err(e) => {
            log::warn!("{reason} scan of {root_id} failed: {e}");
            let _ = app.emit(
                "library://changed",
                serde_json::json!({ "rootId": root_id, "report": serde_json::Value::Null, "reason": reason, "error": e.to_string() }),
            );
            Scan::Failed
        }
    }
}

/// `false` when the thread could not be started (the work was not done).
fn spawn_sync(name: &str, work: impl FnOnce() + Send + 'static) -> bool {
    match std::thread::Builder::new().name(name.into()).spawn(work) {
        Ok(_) => true,
        Err(e) => {
            log::error!("cannot start the {name} thread: {e}");
            false
        }
    }
}
/// LIB-3: a watcher only sees what happens while the app runs. What was moved, renamed or
/// deleted while it was closed is caught up here, once, for every watched root, one root
/// after the other on a thread of its own.
pub fn spawn_startup_sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let roots = { state.engine.lock().unwrap().roots_to_catch_up() };
    if roots.is_empty() {
        return;
    }
    let app = app.clone();
    spawn_sync("meshkeep-sync", move || {
        for root_id in roots {
            scan_and_tell(&app, &root_id, "startup", false);
        }
    });
}

/// LIB-3, the same catch-up for a watcher that starts while the app runs: a root switched to
/// watch mode, or a watched root that was unreachable and is back. What changed before the
/// watcher started is read once, in the background; if a background scan is reading the root
/// right now, this one follows it.
pub fn catch_up(app: &AppHandle, root_id: &str) {
    let (app, root_id) = (app.clone(), root_id.to_string());
    spawn_sync("meshkeep-sync", move || {
        scan_and_tell(&app, &root_id, "catchup", true);
    });
}

/// The watcher reported that its own folder was removed or renamed: it is dead (or watching
/// a folder that is no longer the root) and is replaced. If the folder is there (deleted and
/// made again, or the event was about something that put it back), the new watcher is caught
/// up at once; if not, the root is marked offline, counts as lost, and `follow_watched_roots`
/// brings it back.
///
/// The work runs on a thread of its own, one per root: a request that arrives while the
/// root's watcher is being replaced does not start a second replacement next to it, it makes
/// the running one go round once more.
pub fn restart_watcher(app: &AppHandle, root_id: &str) {
    let state = app.state::<AppState>();
    {
        let mut sync = state.sync.lock().unwrap();
        if let Some(again) = sync.restarting.get_mut(root_id) {
            *again = true;
            return;
        }
        sync.restarting.insert(root_id.to_string(), false);
    }
    let (handle, id) = (app.clone(), root_id.to_string());
    let started = spawn_sync("meshkeep-rewatch", move || loop {
        stop_watcher_for(&handle, &id);
        // Read the root in every case that is still about this watcher. With the folder there,
        // that catches up; with the folder gone, the scan is what marks the root and its
        // projects offline and tells the window (the rescan of such a batch did that before
        // watchers were replaced here).
        match start_watcher_for(&handle, &id) {
            WatchStart::Started | WatchStart::Failed | WatchStart::Unreachable => catch_up(&handle, &id),
            WatchStart::NotWatched | WatchStart::Overtaken => {}
        }
        let state = handle.state::<AppState>();
        let mut sync = state.sync.lock().unwrap();
        match sync.restarting.get_mut(&id) {
            Some(again) if *again => *again = false,
            _ => {
                sync.restarting.remove(&id);
                break;
            }
        }
    });
    if !started {
        state.sync.lock().unwrap().restarting.remove(root_id);
    }
}

/// How often the folders of the watched roots are looked at. A watcher does not always say
/// when it dies: on Windows it stops without a word when the volume goes away, and inotify
/// reports nothing on an unmount. Such a dropout is only seen if a look falls into it, so
/// the looks are close together; one that is shorter than this can still pass unnoticed.
const PRESENCE_INTERVAL: Duration = Duration::from_secs(5);

pub fn spawn_presence_loop(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("meshkeep-presence".into()).spawn(move || loop {
        std::thread::sleep(PRESENCE_INTERVAL);
        follow_watched_roots(&app);
    });
    if let Err(e) = spawned {
        log::error!("cannot start the presence thread: {e}");
    }
}

/// Looks at the folders of the watched roots (every [`PRESENCE_INTERVAL`]). A root
/// that dropped out loses its watcher, which is dead anyway; a root that is back gets a new
/// one and is caught up. Without this a drive that was unplugged at start, or for a while,
/// stayed unwatched until the app was restarted.
///
/// Each folder is asked on a thread of its own, at most one per root at a time: a share that
/// takes long to answer holds up neither the other roots nor the poll loop, and the threads
/// do not pile up behind it.
pub fn follow_watched_roots(app: &AppHandle) {
    let state = app.state::<AppState>();
    let roots = { state.engine.lock().unwrap().watched_roots() };
    {
        let watched: Vec<String> = roots.iter().map(|(id, _)| id.clone()).collect();
        state.watching.lock().unwrap().retain(&watched);
    }
    for (root_id, folder) in roots {
        if !state.sync.lock().unwrap().probing.insert(root_id.clone()) {
            continue;
        }
        // what the look finds counts only if nothing happens to the root's watcher meanwhile
        let since = state.watching.lock().unwrap().generation(&root_id);
        let (handle, id) = (app.clone(), root_id.clone());
        let started = spawn_sync("meshkeep-probe", move || {
            let reachable = folder.is_dir();
            let state = handle.state::<AppState>();
            // seeing it gone and stopping its watcher is one step (`WatchBook::observe`)
            let seen = { state.watching.lock().unwrap().observe(&id, since, reachable) };
            match seen {
                Seen::Unchanged => {}
                Seen::Lost => {
                    log::info!("root {id} is not reachable any more; its watcher is stopped");
                    // the scan finds the folder missing: the root goes offline, the window hears
                    catch_up(&handle, &id);
                }
                Seen::Back => {
                    if matches!(start_watcher_for(&handle, &id), WatchStart::Started | WatchStart::Failed) {
                        log::info!("root {id} is back; catching up");
                        catch_up(&handle, &id);
                    }
                }
            }
            // the root's next look starts only when this one has been acted on
            state.sync.lock().unwrap().probing.remove(&id);
        });
        if !started {
            state.sync.lock().unwrap().probing.remove(&root_id);
        }
    }
}

/// What an access to a project found missing on an online root.
#[derive(Debug, Clone)]
pub enum Missing {
    /// The project's folder.
    Folder,
    /// One of its indexed files (for a packed project: its archive).
    File(String),
    /// An indexed entry of its packed archive; the archive itself is there.
    Entry(String),
}

impl Missing {
    fn rel(&self) -> Option<&str> {
        match self {
            Missing::Folder => None,
            Missing::File(rel) | Missing::Entry(rel) => Some(rel),
        }
    }

    /// Whether the index names it right now although it cannot be read. An archive entry is
    /// judged by the index alone: a scan lists a changed archive again, so an entry that is
    /// still listed after one is not something a scan fixes.
    fn still_listed(&self, engine: &meshkeep_engine::Engine, project_id: &str) -> bool {
        match self {
            Missing::Folder => engine.stale_root(project_id, None).is_some(),
            Missing::File(rel) => engine.stale_root(project_id, Some(rel)).is_some(),
            Missing::Entry(rel) => engine.has_file(project_id, rel),
        }
    }
}

/// The index named a folder, file or archive entry that is gone from an online root: the
/// library was changed outside the app and nothing has reported it yet (a manual root, a
/// polled one between two polls, an event the watcher missed). Reads that root again; the
/// window then shows what is there and says why (`reason: "resync"`). If the same thing is
/// still listed and missing afterwards, a scan does not fix it: it starts no further repair,
/// and the root pauses for [`REPAIR_PAUSE`], as it does after a scan that failed.
pub fn repair_root(app: &AppHandle, root_id: &str, project_id: &str, missing: Missing) {
    let state = app.state::<AppState>();
    let cause = format!("{project_id}\n{}", missing.rel().unwrap_or_default());
    {
        let sync = state.sync.lock().unwrap();
        let paused = sync.paused.get(root_id).is_some_and(|t| t.elapsed() < REPAIR_PAUSE);
        if paused || sync.running.contains(root_id) || sync.unfixable.contains(&cause) {
            return;
        }
    }
    let (app, root_id, project_id) = (app.clone(), root_id.to_string(), project_id.to_string());
    spawn_sync("meshkeep-repair", move || {
        let state = app.state::<AppState>();
        // The caller saw it missing before it got here. A repair that ended in between has
        // dealt with it already: no second scan, no second notice.
        if !missing.still_listed(&state.engine.lock().unwrap(), &project_id) {
            return;
        }
        log::info!(
            "root {root_id}: {project_id} {} is gone from disk, reading the root again",
            missing.rel().unwrap_or("(the folder)")
        );
        let still_missing = match scan_and_tell(&app, &root_id, "resync", false) {
            // the scan that is reading the root may be the repair; this one did nothing
            Scan::Busy => return,
            Scan::Failed => false,
            Scan::Done => {
                if !missing.still_listed(&state.engine.lock().unwrap(), &project_id) {
                    return;
                }
                true
            }
        };
        let mut sync = state.sync.lock().unwrap();
        sync.paused.insert(root_id.clone(), Instant::now());
        if still_missing {
            log::warn!("root {root_id}: {project_id} is still listed with something that cannot be read; not scanning for it again");
            sync.unfixable.insert(cause);
        }
    });
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
