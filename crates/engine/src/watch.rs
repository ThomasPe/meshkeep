//! File-system watching with debouncing. The engine only reports which paths changed;
//! the shell decides what to rescan (see `Engine::rescan_paths`).

use crate::error::{EngineError, Result};
use notify::event::ModifyKind;
use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

/// Quiet time after which a batch of changes is reported.
pub const DEBOUNCE: Duration = Duration::from_millis(750);

#[derive(Debug, Clone, Default)]
pub struct WatchEvent {
    pub root_id: String,
    /// Which watcher of the root sent this: the `instance` it was started with. A root gets
    /// a new watcher now and then, and what an old one still has to say about itself
    /// (`missed`, `root_gone`) is no longer about the watcher that runs.
    pub instance: u64,
    pub paths: Vec<PathBuf>,
    /// The watcher says it did not see everything: its queue overflowed, or it reported an
    /// error. `paths` is then not all that changed, and the root has to be read as a whole.
    pub missed: bool,
    /// The watched folder itself was removed or renamed. Its watches went with it (inotify
    /// drops them, and they do not come back when a folder of that name appears again), so
    /// this watcher reports nothing further and has to be started again.
    pub root_gone: bool,
}

pub struct RootWatcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

/// What one batch of events means for a root: the paths that changed, whether events were
/// lost (`Flag::Rescan`), and whether the root folder itself went away.
fn digest<'a>(root: &Path, events: impl Iterator<Item = &'a notify::Event>) -> (Vec<PathBuf>, bool, bool) {
    let (mut paths, mut missed, mut root_gone) = (Vec::new(), false, false);
    for e in events {
        missed |= e.need_rescan();
        let leaves = matches!(e.kind, EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)));
        root_gone |= leaves && e.paths.iter().any(|p| p == root);
        paths.extend(e.paths.iter().cloned());
    }
    paths.sort();
    paths.dedup();
    (paths, missed, root_gone)
}

impl RootWatcher {
    /// Starts watching `path` recursively; batches of changed paths arrive on `tx` after
    /// `debounce` of quiet time. Returns an error when the platform cannot watch the path
    /// (network shares often), which is the signal to fall back to polling.
    ///
    /// Not every platform says when a watch dies: Windows stops watching a folder whose
    /// volume went away without a word. What can be told is told through
    /// [`WatchEvent::missed`] and [`WatchEvent::root_gone`]; the rest is for whoever looks at
    /// the folder now and then ([`WatchPresence`]).
    pub fn start(root_id: String, instance: u64, path: &Path, debounce: Duration, tx: mpsc::Sender<WatchEvent>) -> Result<RootWatcher> {
        let (rid, root) = (root_id.clone(), path.to_path_buf());
        let mut debouncer = new_debouncer(debounce, None, move |res: DebounceEventResult| {
            let (paths, missed, root_gone) = match res {
                Ok(events) => digest(&root, events.iter().map(|e| &e.event)),
                Err(errors) => {
                    for e in &errors {
                        tracing::warn!("watcher of root {rid}: {e}");
                    }
                    (Vec::new(), true, false)
                }
            };
            if !paths.is_empty() || missed || root_gone {
                let _ = tx.send(WatchEvent {
                    root_id: rid.clone(),
                    instance,
                    paths,
                    missed,
                    root_gone,
                });
            }
        })
        .map_err(|e| EngineError::Watch(e.to_string()))?;
        debouncer
            .watch(path, RecursiveMode::Recursive)
            .map_err(|e| EngineError::Watch(e.to_string()))?;
        Ok(RootWatcher { _debouncer: debouncer })
    }
}

/// Keeps track of watched roots whose folder is not reachable (a drive that is unplugged, a
/// share that dropped). A watcher on such a folder is dead and cannot be started, and it
/// does not come back by itself: the shell looks at the folders now and then, tells this
/// what it saw, and gets back which roots just dropped out (stop their watcher) and which
/// are back (start a watcher and catch up with what changed meanwhile, LIB-3).
#[derive(Debug, Default)]
pub struct WatchPresence {
    lost: std::collections::HashSet<String>,
}

/// What changed between two looks at the watched roots.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PresenceChange {
    pub lost: Vec<String>,
    pub back: Vec<String>,
}

/// What one look at a watched root's folder means for its watcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen {
    /// As before: there and watched, or still gone.
    Unchanged,
    /// Just dropped out: stop its watcher.
    Lost,
    /// Back after being gone: start a watcher and catch up.
    Back,
}

impl WatchPresence {
    /// A watcher could not be started because the root's folder is not there.
    pub fn mark_lost(&mut self, root_id: &str) {
        self.lost.insert(root_id.to_string());
    }

    pub fn is_lost(&self, root_id: &str) -> bool {
        self.lost.contains(root_id)
    }

    /// One root's folder was looked at. Roots are looked at independently of each other, so
    /// a share that takes long to answer holds up nobody else.
    pub fn see(&mut self, root_id: &str, reachable: bool) -> Seen {
        if reachable {
            if self.lost.remove(root_id) {
                return Seen::Back;
            }
        } else if self.lost.insert(root_id.to_string()) {
            return Seen::Lost;
        }
        Seen::Unchanged
    }

    /// Forgets roots that are no longer watched (removed, switched to another mode).
    pub fn retain(&mut self, watched: &[String]) {
        self.lost.retain(|id| watched.contains(id));
    }

    /// `seen` is every root in watch mode right now and whether its folder is reachable:
    /// `retain` and `see` for all of them at once.
    pub fn update(&mut self, seen: &[(String, bool)]) -> PresenceChange {
        let watched: Vec<String> = seen.iter().map(|(id, _)| id.clone()).collect();
        self.retain(&watched);
        let mut change = PresenceChange::default();
        for (id, reachable) in seen {
            match self.see(id, *reachable) {
                Seen::Lost => change.lost.push(id.clone()),
                Seen::Back => change.back.push(id.clone()),
                Seen::Unchanged => {}
            }
        }
        change
    }
}

/// The watchers of the roots and everything that decides whether one may be installed or
/// has to go, behind one lock in the shell. Watchers are started outside that lock (a
/// recursive watch can take seconds to register), folders are looked at outside it too (a
/// share can hang), and the user changes modes meanwhile. So every result comes back to a
/// world that may have moved on, and this book tells it so:
///
/// - Each root has a generation that counts what happened to its watcher: a start that
///   began, a stop, a change of mode, a root that dropped out.
/// - A start takes a ticket (`begin`) and may install its watcher, or record its failure,
///   only while that ticket is still the generation (`install`, `is_current`). A start
///   that was overtaken by a stop or by a newer start is dropped.
/// - A look at a folder notes the generation when it begins and counts only if nothing
///   happened to the watcher since (`observe`). A root seen gone loses its watcher in the
///   same step, so no stop is left pending that could remove a watcher installed later.
///
/// `W` is the watcher; the book only keeps it alive and drops it.
#[derive(Debug)]
pub struct WatchBook<W> {
    watchers: HashMap<String, (u64, W)>,
    generation: HashMap<String, u64>,
    presence: WatchPresence,
}

impl<W> Default for WatchBook<W> {
    fn default() -> Self {
        WatchBook {
            watchers: HashMap::new(),
            generation: HashMap::new(),
            presence: WatchPresence::default(),
        }
    }
}

impl<W> WatchBook<W> {
    pub fn generation(&self, root_id: &str) -> u64 {
        self.generation.get(root_id).copied().unwrap_or(0)
    }

    fn bump(&mut self, root_id: &str) -> u64 {
        let g = self.generation.entry(root_id.to_string()).or_insert(0);
        *g += 1;
        *g
    }

    /// A start of the root's watcher begins: its ticket, which also overtakes every start
    /// that began earlier and has not finished.
    pub fn begin(&mut self, root_id: &str) -> u64 {
        self.bump(root_id)
    }

    /// Whether the start with this ticket is still the last thing that happened to the root.
    pub fn is_current(&self, root_id: &str, ticket: u64) -> bool {
        self.generation(root_id) == ticket
    }

    /// Installs the watcher a start came back with and settles an older "lost" mark: the
    /// folder is there and watched. `Ok` holds the watcher it replaced, if any; `Err` gives
    /// the new one back because the start was overtaken. Either way the caller drops what
    /// it gets after it has let go of the lock: taking a recursive watch down takes time.
    pub fn install(&mut self, root_id: &str, ticket: u64, watcher: W) -> std::result::Result<Option<W>, W> {
        if !self.is_current(root_id, ticket) {
            return Err(watcher);
        }
        let replaced = self.watchers.insert(root_id.to_string(), (ticket, watcher));
        self.presence.see(root_id, true);
        Ok(replaced.map(|(_, old)| old))
    }

    /// A start found the folder missing: the root counts as lost until a look sees it back.
    /// `false` if the start was overtaken (nothing is recorded then).
    pub fn unreachable(&mut self, root_id: &str, ticket: u64) -> bool {
        if !self.is_current(root_id, ticket) {
            return false;
        }
        self.presence.mark_lost(root_id);
        true
    }

    /// Takes the root's watcher away (mode changed, root removed, watcher known dead) and
    /// overtakes every start that has not finished. The watcher comes back to the caller, to
    /// be dropped outside the lock.
    #[must_use = "drop the watcher after releasing the lock"]
    pub fn stop(&mut self, root_id: &str) -> Option<W> {
        self.bump(root_id);
        self.watchers.remove(root_id).map(|(_, watcher)| watcher)
    }

    /// The instance of the watcher that is installed for the root, if any.
    pub fn installed(&self, root_id: &str) -> Option<u64> {
        self.watchers.get(root_id).map(|(instance, _)| *instance)
    }

    /// Whether the watcher started with this instance is the root's watcher: the one that is
    /// installed, or the one whose start is the last thing that happened to the root. The
    /// second matters because a watcher runs from the moment it is started and is installed a
    /// moment later; what it reports in between (its folder is gone already) must not be
    /// taken for the voice of a replaced watcher.
    pub fn is_live(&self, root_id: &str, instance: u64) -> bool {
        self.installed(root_id) == Some(instance) || self.is_current(root_id, instance)
    }

    /// A look at the root's folder that began at generation `since` came back. If anything
    /// happened to the watcher meanwhile, the look is old and changes nothing. Otherwise:
    /// `Lost` (the watcher is stopped here and handed back, to be dropped outside the lock),
    /// `Back` (the caller starts one and catches up) or `Unchanged`.
    pub fn observe(&mut self, root_id: &str, since: u64, reachable: bool) -> (Seen, Option<W>) {
        if self.generation(root_id) != since {
            return (Seen::Unchanged, None);
        }
        let seen = self.presence.see(root_id, reachable);
        let stopped = if seen == Seen::Lost { self.stop(root_id) } else { None };
        (seen, stopped)
    }

    /// What to do with a batch from a watcher. Ordinary changes are rescanned whoever sent
    /// them. What a watcher says about itself counts only from the root's watcher
    /// (`is_live`): lost events mean the root has to be read as a whole, a root folder that
    /// went away means the watcher has to be replaced.
    pub fn verdict(&self, ev: &WatchEvent) -> Verdict {
        if !(ev.root_gone || ev.missed) {
            Verdict::Changed
        } else if !self.is_live(&ev.root_id, ev.instance) {
            Verdict::Ignore
        } else if ev.root_gone {
            Verdict::Replace
        } else {
            Verdict::Read
        }
    }

    pub fn is_lost(&self, root_id: &str) -> bool {
        self.presence.is_lost(root_id)
    }

    /// Forgets the lost marks of roots that are no longer watched.
    pub fn retain(&mut self, watched: &[String]) {
        self.presence.retain(watched);
    }
}

/// See [`WatchBook::verdict`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Files changed: rescan.
    Changed,
    /// The watcher lost events: read the whole root.
    Read,
    /// The watcher's own folder went away: replace the watcher.
    Replace,
    /// A replaced watcher talking about itself: nothing to do.
    Ignore,
}

/// One worker per key at a time, and requests that arrive while it works are not lost: they
/// make it go round once more. For work that must not run twice side by side and where a
/// later request may know more than the round that is running (replacing a root's watcher).
#[derive(Debug, Default)]
pub struct Rounds {
    /// Keys with a worker; `true` when another round was asked for meanwhile.
    working: HashMap<String, bool>,
}

impl Rounds {
    /// `true`: nobody works on this key, the caller starts the worker. `false`: a worker is
    /// at it and will go round once more.
    pub fn request(&mut self, key: &str) -> bool {
        match self.working.get_mut(key) {
            Some(again) => {
                *again = true;
                false
            }
            None => {
                self.working.insert(key.to_string(), false);
                true
            }
        }
    }

    /// The worker finished a round. `true`: another was asked for, go again. `false`: done,
    /// and the next request starts a new worker.
    pub fn finished(&mut self, key: &str) -> bool {
        match self.working.get_mut(key) {
            Some(again) if *again => {
                *again = false;
                true
            }
            _ => {
                self.working.remove(key);
                false
            }
        }
    }

    /// The worker could not be started: the key is free again.
    pub fn abandon(&mut self, key: &str) {
        self.working.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_reports_a_root_once_when_it_drops_out_and_once_when_it_is_back() {
        let seen = |a: bool, b: bool| vec![("a".to_string(), a), ("b".to_string(), b)];
        let mut p = WatchPresence::default();
        assert_eq!(
            p.update(&seen(true, true)),
            PresenceChange::default(),
            "nothing to do while all is there"
        );
        assert_eq!(
            p.update(&seen(true, false)),
            PresenceChange {
                lost: vec!["b".into()],
                back: vec![]
            }
        );
        assert!(p.is_lost("b") && !p.is_lost("a"));
        assert_eq!(p.update(&seen(true, false)), PresenceChange::default(), "still gone: reported once");
        assert_eq!(
            p.update(&seen(true, true)),
            PresenceChange {
                lost: vec![],
                back: vec!["b".into()]
            }
        );
        assert_eq!(p.update(&seen(true, true)), PresenceChange::default(), "back: reported once");

        // a root that was unreachable when its watcher should have started (app start)
        p.mark_lost("a");
        assert_eq!(p.update(&seen(true, true)).back, ["a"]);

        // one root at a time, as the shell looks at them
        assert_eq!(p.see("a", false), Seen::Lost);
        assert_eq!(p.see("a", false), Seen::Unchanged);
        assert_eq!(p.see("b", true), Seen::Unchanged, "another root is not touched by it");
        assert_eq!(p.see("a", true), Seen::Back);
        assert_eq!(p.see("a", true), Seen::Unchanged);

        // a lost root that is no longer watched is forgotten, also if it is watched again later
        p.mark_lost("b");
        assert_eq!(p.update(&[("a".to_string(), true)]), PresenceChange::default());
        assert_eq!(p.update(&seen(true, true)), PresenceChange::default());
    }

    /// The three ways a result can come back to a root that has moved on.
    #[test]
    fn the_book_drops_what_was_overtaken() {
        let mut book: WatchBook<&str> = WatchBook::default();

        // a start, alone: installed
        let t = book.begin("r");
        assert_eq!(book.install("r", t, "first"), Ok(None));
        assert_eq!(book.installed("r"), Some(t));

        // watch -> manual -> watch while the first start is still registering: the old
        // start comes back late, with a watcher or with a failure, and neither counts
        let old = book.begin("r");
        assert_eq!(book.stop("r"), Some("first"), "handed back, to be dropped outside the lock"); // switched to manual
        let new = book.begin("r"); // and back to watch
        assert_eq!(book.install("r", new, "new"), Ok(None));
        assert_eq!(
            book.install("r", old, "late"),
            Err("late"),
            "a late success does not replace the newer watcher"
        );
        assert!(!book.is_current("r", old), "and a late failure is not recorded for a healthy root");
        assert_eq!(book.installed("r"), Some(new));

        // whose reports about itself count: the installed watcher, and one that is started
        // and about to be installed; not one that was stopped or overtaken
        assert!(book.is_live("r", new) && !book.is_live("r", old));
        let starting = book.begin("r");
        assert!(book.is_live("r", starting), "started, not installed yet");
        assert!(book.is_live("r", new), "the installed one stays the watcher until it is replaced");
        assert_eq!(book.stop("r"), Some("new"));
        assert!(!book.is_live("r", starting) && !book.is_live("r", new));
        let t = book.begin("r");
        assert_eq!(book.install("r", t, "again"), Ok(None));

        // a look saw the folder gone, then a start installed a watcher before the look came
        // back: the look is old, it stops nothing and marks nothing
        let since = book.generation("r");
        let t = book.begin("r");
        assert_eq!(
            book.install("r", t, "replacement"),
            Ok(Some("again")),
            "the one it replaces comes back"
        );
        assert_eq!(book.observe("r", since, false), (Seen::Unchanged, None));
        assert_eq!(book.installed("r"), Some(t), "the replacement stays");
        assert!(!book.is_lost("r"));

        // the other way round: the folder drops out while a start is registering. The look
        // counts, and the start that comes back afterwards is dropped with its dead watcher
        let t = book.begin("r");
        let since = book.generation("r");
        assert_eq!(book.observe("r", since, false), (Seen::Lost, Some("replacement")));
        assert_eq!(book.installed("r"), None, "stopped in the same step");
        assert_eq!(book.install("r", t, "dead on arrival"), Err("dead on arrival"));
        // back again: the caller starts a watcher, which settles the mark
        let since = book.generation("r");
        assert_eq!(book.observe("r", since, true), (Seen::Back, None));
        let t = book.begin("r");
        assert_eq!(book.install("r", t, "back"), Ok(None));
        assert_eq!(book.observe("r", book.generation("r"), true), (Seen::Unchanged, None));

        // a start that finds the folder missing marks the root lost, unless it was overtaken
        let old = book.begin("r");
        let t = book.begin("r");
        assert!(!book.unreachable("r", old));
        assert!(!book.is_lost("r"));
        assert!(book.unreachable("r", t));
        assert!(book.is_lost("r"));
        book.retain(&[]);
        assert!(!book.is_lost("r"), "no longer watched: forgotten");
    }

    /// What the event loop does with a batch, and whose word about itself it takes.
    #[test]
    fn a_batch_is_judged_by_what_it_says_and_who_says_it() {
        let mut book: WatchBook<()> = WatchBook::default();
        let ev = |instance: u64, missed: bool, root_gone: bool| WatchEvent {
            root_id: "r".into(),
            instance,
            paths: vec![PathBuf::from("/lib/A")],
            missed,
            root_gone,
        };
        let old = book.begin("r");
        assert!(book.install("r", old, ()).is_ok());
        let _ = book.stop("r");
        let now = book.begin("r");

        // ordinary changes are rescanned, also from a watcher that is on its way out
        assert_eq!(book.verdict(&ev(old, false, false)), Verdict::Changed);
        assert_eq!(book.verdict(&ev(now, false, false)), Verdict::Changed);
        // the root's watcher is heard, already before it is installed
        assert_eq!(book.verdict(&ev(now, true, false)), Verdict::Read);
        assert_eq!(book.verdict(&ev(now, false, true)), Verdict::Replace);
        assert_eq!(
            book.verdict(&ev(now, true, true)),
            Verdict::Replace,
            "a new watcher is caught up anyway"
        );
        assert!(book.install("r", now, ()).is_ok());
        assert_eq!(book.verdict(&ev(now, false, true)), Verdict::Replace);
        // a replaced one is not
        assert_eq!(book.verdict(&ev(old, true, false)), Verdict::Ignore);
        assert_eq!(book.verdict(&ev(old, false, true)), Verdict::Ignore);
        // nor is anybody for a root without a watcher
        assert_eq!(
            book.verdict(&WatchEvent {
                root_id: "other".into(),
                instance: 3,
                root_gone: true,
                ..Default::default()
            }),
            Verdict::Ignore
        );
    }

    #[test]
    fn rounds_run_one_worker_per_key_and_lose_no_request() {
        let mut rounds = Rounds::default();
        assert!(rounds.request("r"), "nobody at it: start the worker");
        assert!(rounds.request("other"), "another key is another worker");
        assert!(!rounds.request("r"), "one is at it");
        assert!(!rounds.request("r"), "and however many ask, it is one more round");
        assert!(rounds.finished("r"), "go round once more");
        assert!(!rounds.finished("r"), "nothing asked since: done");
        assert!(rounds.request("r"), "free again");
        rounds.abandon("r");
        assert!(rounds.request("r"), "a worker that could not start leaves the key free");
        assert!(!rounds.finished("other"));
    }

    #[test]
    fn a_batch_says_when_events_were_lost_or_the_root_went_away() {
        use notify::event::{Flag, RemoveKind, RenameMode};
        use notify::Event;
        let root = Path::new("/lib");
        let ev = |kind: EventKind, paths: &[&str]| paths.iter().fold(Event::new(kind), |e, p| e.add_path(PathBuf::from(p)));
        let run = |events: Vec<Event>| digest(root, events.iter());

        // ordinary changes: the paths, once each, and nothing else
        let (paths, missed, gone) = run(vec![
            ev(EventKind::Remove(RemoveKind::Folder), &["/lib/A"]),
            ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &["/lib/B", "/lib/C"]),
            ev(EventKind::Remove(RemoveKind::File), &["/lib/A"]),
        ]);
        assert_eq!(paths, [PathBuf::from("/lib/A"), "/lib/B".into(), "/lib/C".into()]);
        assert!(!missed && !gone, "a folder below the root is an ordinary change");

        // the queue overflowed: an event without a path that says "read everything"
        let (paths, missed, gone) = run(vec![Event::new(EventKind::Other).set_flag(Flag::Rescan)]);
        assert!(paths.is_empty() && missed && !gone);

        // the root itself: deleted, renamed away, or replaced by a rename onto it
        for e in [
            ev(EventKind::Remove(RemoveKind::Folder), &["/lib"]),
            ev(EventKind::Modify(ModifyKind::Name(RenameMode::From)), &["/lib"]),
            ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &["/elsewhere", "/lib"]),
        ] {
            let (_, missed, gone) = run(vec![e.clone()]);
            assert!(gone && !missed, "{e:?}");
        }
        // a change of the root that leaves it where it is (its own metadata) is not that
        let (_, _, gone) = run(vec![ev(EventKind::Modify(ModifyKind::Any), &["/lib"])]);
        assert!(!gone);
    }

    /// inotify reports the watched folder's own removal; that is the one place the watcher's
    /// death can be seen from the outside.
    #[cfg(target_os = "linux")]
    #[test]
    fn reports_that_its_root_was_removed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("lib");
        std::fs::create_dir_all(root.join("P")).unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = RootWatcher::start("r1".into(), 7, &root, Duration::from_millis(200), tx).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::remove_dir_all(&root).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut gone = false;
        while !gone {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            gone = rx.recv_timeout(left).expect("the removal of the root is reported").root_gone;
        }
    }

    #[test]
    fn reports_created_files() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = RootWatcher::start("r1".into(), 7, dir.path(), Duration::from_millis(200), tx).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::create_dir_all(dir.path().join("P")).unwrap();
        std::fs::write(dir.path().join("P/part.stl"), b"x").unwrap();
        let ev = rx.recv_timeout(Duration::from_secs(5)).expect("watch event");
        assert_eq!((ev.root_id.as_str(), ev.instance), ("r1", 7));
        assert!(
            ev.paths.iter().any(|p| p.ends_with("part.stl") || p.ends_with("P")),
            "{:?}",
            ev.paths
        );
    }
}
