//! File-system watching with debouncing. The engine only reports which paths changed;
//! the shell decides what to rescan (see `Engine::rescan_paths`).

use crate::error::{EngineError, Result};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct WatchEvent {
    pub root_id: String,
    pub paths: Vec<PathBuf>,
}

pub struct RootWatcher {
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

impl RootWatcher {
    /// Starts watching `path` recursively; batches of changed paths arrive on `tx` after
    /// `debounce` of quiet time. Returns an error when the platform cannot watch the path
    /// (network shares often), which is the signal to fall back to polling.
    pub fn start(root_id: String, path: &Path, debounce: Duration, tx: mpsc::Sender<WatchEvent>) -> Result<RootWatcher> {
        let rid = root_id.clone();
        let mut debouncer = new_debouncer(debounce, None, move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let mut paths: Vec<PathBuf> = events.into_iter().flat_map(|e| e.event.paths.clone()).collect();
                paths.sort();
                paths.dedup();
                if !paths.is_empty() {
                    let _ = tx.send(WatchEvent {
                        root_id: rid.clone(),
                        paths,
                    });
                }
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
