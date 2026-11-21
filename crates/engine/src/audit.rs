//! What agents changed over MCP (#103): a journal in the app data directory, one JSON line
//! per writing tool call that changed something. Which tool, which projects, when, and the
//! arguments the agent sent. The window shows it; nothing reads it to act on.
//!
//! It is a record, not an undo log: it holds no inverse operations. When undo/redo (APP-6)
//! brings a log of its own, an entry here is where an agent's change gets its "take back".
//!
//! The file is app data like the index: it never lives in a library, and losing it loses
//! history, not content. It is trimmed to its newer half when it outgrows `MAX_BYTES`.

use crate::error::{io_err, EngineError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use time::OffsetDateTime;

pub const AUDIT_FILE: &str = "mcp-audit.jsonl";
const MAX_BYTES: u64 = 2 << 20;
/// Projects named per entry; a batch over thousands keeps its count in `project_count`.
pub const MAX_PROJECTS: usize = 50;
const MAX_ARRAY: usize = 20;
const MAX_STRING: usize = 400;

/// A project as it was called when the tool ran: ids change with a rename or a move, and a
/// deleted project has no title to look up afterwards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditProject {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditEntry {
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub tool: String,
    /// At most `MAX_PROJECTS` of the projects the call touched.
    pub projects: Vec<AuditProject>,
    /// How many it touched in all.
    pub project_count: u32,
    /// What the agent asked for, long lists and texts shortened.
    pub args: Value,
    /// Items the tool reported as failed (the rest of the call went through).
    #[serde(default)]
    pub failed: u32,
}

impl AuditEntry {
    pub fn new(tool: &str, args: &Value, mut projects: Vec<AuditProject>, failed: u32) -> AuditEntry {
        let mut seen = std::collections::BTreeSet::new();
        projects.retain(|p| seen.insert(p.id.clone()));
        let project_count = projects.len() as u32;
        projects.truncate(MAX_PROJECTS);
        AuditEntry {
            at: OffsetDateTime::now_utc(),
            tool: tool.to_string(),
            projects,
            project_count,
            args: shorten(args),
            failed,
        }
    }
}

/// A page of the journal, newest first.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AuditPage {
    pub entries: Vec<AuditEntry>,
    pub total: u32,
}

/// Arguments as an agent sent them can be large (two thousand ids, a long description):
/// the journal keeps enough to see what was asked.
fn shorten(v: &Value) -> Value {
    match v {
        Value::Array(items) => {
            let mut out: Vec<Value> = items.iter().take(MAX_ARRAY).map(shorten).collect();
            if items.len() > MAX_ARRAY {
                out.push(Value::String(format!("… {} more", items.len() - MAX_ARRAY)));
            }
            Value::Array(out)
        }
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), shorten(v))).collect()),
        Value::String(s) if s.chars().count() > MAX_STRING => {
            let cut: String = s.chars().take(MAX_STRING).collect();
            Value::String(format!("{cut}…"))
        }
        other => other.clone(),
    }
}

fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(AUDIT_FILE)
}

/// Adds an entry at the end. The line is written in one call, so a crash leaves at worst a
/// cut last line, which `read` skips.
pub fn append(data_dir: &Path, entry: &AuditEntry) -> Result<()> {
    let path = path(data_dir);
    let mut line = serde_json::to_string(entry).map_err(|e| EngineError::Serde(e.to_string()))?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(io_err(&path))?;
    file.write_all(line.as_bytes()).map_err(io_err(&path))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    drop(file);
    if len > MAX_BYTES {
        trim(&path)?;
    }
    Ok(())
}

/// Keeps the newer half of the lines; rewritten through a temporary file.
fn trim(path: &Path) -> Result<()> {
    let text = std::fs::read_to_string(path).map_err(io_err(path))?;
    let lines: Vec<&str> = text.lines().collect();
    let mut kept = lines[lines.len() / 2..].join("\n");
    kept.push('\n');
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, kept).map_err(io_err(&tmp))?;
    std::fs::rename(&tmp, path).map_err(io_err(path))
}

fn entries(data_dir: &Path) -> Result<Vec<AuditEntry>> {
    let path = path(data_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(EngineError::Io { path, source: e }),
    };
    // a line that does not parse (cut by a crash, written by a newer version) is skipped
    Ok(text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

/// The journal, newest first.
pub fn read(data_dir: &Path, limit: u32, offset: u32) -> Result<AuditPage> {
    let all = entries(data_dir)?;
    Ok(AuditPage {
        total: all.len() as u32,
        entries: all.into_iter().rev().skip(offset as usize).take(limit as usize).collect(),
    })
}

/// Forgets the history. The libraries are not touched.
pub fn clear(data_dir: &Path) -> Result<()> {
    let path = path(data_dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(EngineError::Io { path, source: e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(n: usize) -> AuditProject {
        AuditProject {
            id: format!("r:P{n}"),
            title: format!("P{n}"),
        }
    }

    #[test]
    fn entries_come_back_newest_first_and_page() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path(), 10, 0).unwrap().total, 0);
        for n in 0..5 {
            append(
                dir.path(),
                &AuditEntry::new(
                    "update_metadata",
                    &json!({ "project_id": format!("r:P{n}"), "creator": "A" }),
                    vec![project(n)],
                    0,
                ),
            )
            .unwrap();
        }
        let page = read(dir.path(), 2, 0).unwrap();
        assert_eq!(page.total, 5);
        assert_eq!(page.entries.len(), 2);
        assert_eq!(page.entries[0].projects[0].title, "P4");
        assert_eq!(page.entries[1].projects[0].title, "P3");
        assert_eq!(read(dir.path(), 2, 4).unwrap().entries[0].projects[0].title, "P0");
        assert!(read(dir.path(), 2, 5).unwrap().entries.is_empty());

        // a damaged line costs that line, not the journal
        let file = dir.path().join(AUDIT_FILE);
        let mut text = std::fs::read_to_string(&file).unwrap();
        text.push_str("{\"at\":\"2026-11-20T10:00:00Z\",\"tool\":\"cut of");
        std::fs::write(&file, text).unwrap();
        assert_eq!(read(dir.path(), 10, 0).unwrap().total, 5);

        clear(dir.path()).unwrap();
        assert_eq!(read(dir.path(), 10, 0).unwrap().total, 0);
        clear(dir.path()).unwrap();
    }

    #[test]
    fn an_entry_keeps_what_was_asked_without_keeping_everything() {
        let ids: Vec<String> = (0..120).map(|n| format!("r:P{n}")).collect();
        let mut projects: Vec<AuditProject> = (0..120).map(project).collect();
        projects.push(project(3)); // named twice by the tool: counted once
        let e = AuditEntry::new(
            "batch_update",
            &json!({ "project_ids": ids, "creator": "x".repeat(1000), "nested": { "tags": ["a", "b"] } }),
            projects,
            2,
        );
        assert_eq!(e.project_count, 120);
        assert_eq!(e.projects.len(), MAX_PROJECTS);
        assert_eq!(e.failed, 2);
        let listed = e.args["project_ids"].as_array().unwrap();
        assert_eq!(listed.len(), MAX_ARRAY + 1);
        assert_eq!(listed[MAX_ARRAY], "… 100 more");
        assert_eq!(e.args["creator"].as_str().unwrap().chars().count(), MAX_STRING + 1);
        assert_eq!(e.args["nested"]["tags"], json!(["a", "b"]));
        // and survives the trip through the file
        let dir = tempfile::tempdir().unwrap();
        append(dir.path(), &e).unwrap();
        assert_eq!(read(dir.path(), 1, 0).unwrap().entries[0], e);
    }

    #[test]
    fn the_file_is_trimmed_to_its_newer_half() {
        let dir = tempfile::tempdir().unwrap();
        let big = json!({ "description": "d".repeat(MAX_STRING) });
        let size = || std::fs::metadata(dir.path().join(AUDIT_FILE)).unwrap().len();
        let mut n = 0;
        let mut before = 0;
        // write until the file shrank: one trim has happened
        loop {
            append(dir.path(), &AuditEntry::new("update_metadata", &big, vec![project(n)], 0)).unwrap();
            n += 1;
            if size() < before {
                break;
            }
            before = size();
            assert!(n < 20_000, "the journal never trimmed");
        }
        let page = read(dir.path(), 1, 0).unwrap();
        assert!((page.total as usize) < n, "older entries went");
        assert_eq!(page.entries[0].projects[0].title, format!("P{}", n - 1), "the newest stayed");
        assert!(std::fs::metadata(dir.path().join(AUDIT_FILE)).unwrap().len() <= MAX_BYTES);
    }
}
