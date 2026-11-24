//! File-system watching with debouncing. The engine only reports which paths changed;
//! the shell decides what to rescan (see `Engine::rescan_paths`).

use crate::error::{EngineError, Result};
use notify::event::ModifyKind;
use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

/// Quiet time after which a batch of changes is reported.
pub const DEBOUNCE: Duration = Duration::from_millis(750);

#[derive(Debug, Clone, Default)]
pub struct WatchEvent {
    pub root_id: String,
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
    pub fn start(root_id: String, path: &Path, debounce: Duration, tx: mpsc::Sender<WatchEvent>) -> Result<RootWatcher> {
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
        let _w = RootWatcher::start("r1".into(), &root, Duration::from_millis(200), tx).unwrap();
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
        let _w = RootWatcher::start("r1".into(), dir.path(), Duration::from_millis(200), tx).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::create_dir_all(dir.path().join("P")).unwrap();
        std::fs::write(dir.path().join("P/part.stl"), b"x").unwrap();
        let ev = rx.recv_timeout(Duration::from_secs(5)).expect("watch event");
        assert_eq!(ev.root_id, "r1");
        assert!(
            ev.paths.iter().any(|p| p.ends_with("part.stl") || p.ends_with("P")),
            "{:?}",
            ev.paths
        );
    }
}
