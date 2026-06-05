//! Collects the SAFE diagnostic logs and packs them into an in-memory `.zip`
//! for opt-in attachment to a feedback report.
//!
//! Two log sources are collected, via a strict **filename allowlist** — never a
//! directory sweep:
//!
//! 1. This app's Tauri shell log (`app_log_dir()`): `goose.log` plus rotated
//!    `goose.<N>.log` files. Each line is run through
//!    [`sanitize_app_log_line`], which drops the captured goosed
//!    stdout/stderr lines (they can carry conversation/LLM content), applies
//!    the secret-key redactor to what remains, and includes app diagnostic
//!    events emitted as `[diagnostic] key=value` records.
//! 2. goosed's own diagnostic logs under `<goose-state>/logs/cli/**` and
//!    `<goose-state>/logs/server/**` — the `.log` files only. These are
//!    metadata-only diagnostics (session IDs, durations, token counts, tool and
//!    model names, errors) and are included verbatim.
//!
//! Files containing full conversation/LLM content are **hard-excluded** by an
//! explicit filename guard so they can never be swept in by accident:
//! `llm_request.*.jsonl` (sits directly in `<goose-state>/logs/`) and
//! `sessions.db` / `sessions.db-wal` / `sessions.db-shm`. We additionally only
//! ever walk the `cli`/`server` subtrees and only ever take `.log` files, so
//! those artifacts are out of scope twice over.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, NaiveDateTime, Utc};
use etcetera::{choose_app_strategy, AppStrategy, AppStrategyArgs};
use tauri::Manager;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Overall budget on raw (pre-compression) log bytes read across all files.
/// Deliberately kept well under kgoose's 10 MB per-file attachment limit so the
/// resulting `.zip` stays comfortably small after deflate compression.
const MAX_TOTAL_RAW_BYTES: u64 = 16 * 1024 * 1024;

/// Per-file cap. Files larger than this are tailed to their final
/// `PER_FILE_TAIL_BYTES` (the most recent activity is what matters for triage).
const PER_FILE_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// Recency window: only log files modified within this much of "now" are
/// collected. Layered on TOP of the filename allowlist / hard-exclude guard /
/// size caps — never a replacement for them. A current session's logs always
/// have fresh mtimes, so this comfortably keeps the active log while dropping
/// the long tail of stale rotated/dated files that only bloat the upload.
/// Tune here.
const MAX_LOG_AGE: Duration = Duration::from_secs(60 * 60);

/// Filename used for the diagnostic-log attachment part.
pub(crate) const LOG_ZIP_FILENAME: &str = "goose-logs.zip";

/// Resolved on-disk log directories. Resolving needs the Tauri `AppHandle`, but
/// the (potentially slow) filesystem enumeration in [`build_logs_zip`] does not,
/// so resolution and collection are split to keep the blocking work portable.
pub(crate) struct LogDirs {
    /// Tauri shell-log directory (`app_log_dir()`): holds `goose.log` and
    /// rotated `goose.<N>.log` files.
    app_log_dir: PathBuf,
    /// goosed state log directory (`<goose-state>/logs`). We only ever descend
    /// into its `cli`/`server` subtrees.
    goose_state_logs_dir: PathBuf,
}

/// Resolve both log directories. Mirrors how goosed itself resolves its state
/// directory: honour `GOOSE_PATH_ROOT` (rooted at `<root>/state`) when set,
/// otherwise use the same `etcetera` app strategy goosed uses
/// (`Block`/`Block`/`goose`), which yields
/// `~/Library/Application Support/Block/goose/state` on macOS.
pub(crate) fn resolve_log_dirs(app: &tauri::AppHandle) -> Result<LogDirs, String> {
    let app_log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Failed to resolve app log directory: {error}"))?;
    let goose_state_logs_dir = goose_state_dir()?.join("logs");
    Ok(LogDirs {
        app_log_dir,
        goose_state_logs_dir,
    })
}

fn goose_state_dir() -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("GOOSE_PATH_ROOT") {
        let root = root.trim();
        if !root.is_empty() {
            return Ok(PathBuf::from(root).join("state"));
        }
    }

    // NOTE: "Block" matches goosed's own `Paths` strategy (kept for backwards
    // compatibility with existing install dirs). Reusing the same `etcetera`
    // call guarantees we resolve the identical directory on every platform.
    let strategy = choose_app_strategy(AppStrategyArgs {
        top_level_domain: "Block".to_string(),
        author: "Block".to_string(),
        app_name: "goose".to_string(),
    })
    .map_err(|error| format!("Failed to resolve goose state directory: {error}"))?;

    Ok(strategy.state_dir().unwrap_or_else(|| strategy.data_dir()))
}

struct ZipEntry {
    /// Path inside the archive.
    name: String,
    bytes: Vec<u8>,
}

/// Enumerate the allowlisted logs, redact/sanitize as required, fold in the
/// doctor diagnostics, and build the `.zip` in memory. Returns an error if
/// nothing was collected (the caller treats that as "nothing to attach"). This
/// performs blocking filesystem I/O and is intended to run inside
/// `spawn_blocking`.
///
/// Both inputs are optional: `dirs` is `None` when the log directories could
/// not be resolved, and `doctor_report_text` is `None` when the doctor check
/// produced nothing to attach.
pub(crate) fn build_logs_zip(
    dirs: Option<&LogDirs>,
    doctor_report_text: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut budget = MAX_TOTAL_RAW_BYTES;
    let mut entries: Vec<ZipEntry> = Vec::new();

    // Recency cutoffs applied on top of filename allowlists and size caps.
    // `checked_sub` guards the practically impossible pre-epoch clock; falling
    // back to the epoch disables that filter rather than dropping everything.
    let cutoff = SystemTime::now()
        .checked_sub(MAX_LOG_AGE)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    if let Some(dirs) = dirs {
        // 1. Tauri shell log(s) — redacted + sidecar lines dropped. App
        // diagnostic events are emitted here as `[diagnostic] key=value`.
        for path in enumerate_app_shell_logs(&dirs.app_log_dir, cutoff) {
            if budget == 0 {
                break;
            }
            let Some(filename) = file_name_str(&path) else {
                continue;
            };
            let raw = read_tail(&path, &mut budget)?;
            let sanitized = sanitize_app_log(&raw);
            let filtered = filter_by_recency(&sanitized, ParserKind::ShellBracketed, cutoff);
            if filtered.is_empty() {
                continue;
            }
            entries.push(ZipEntry {
                name: format!("app-shell/{filename}"),
                bytes: filtered,
            });
        }

        // 2. goosed diagnostic logs under logs/cli/** and logs/server/**.
        for subdir in ["cli", "server"] {
            let root = dirs.goose_state_logs_dir.join(subdir);
            for path in enumerate_goosed_logs(&root, cutoff) {
                if budget == 0 {
                    break;
                }
                let Some(relative) = relative_archive_path(&dirs.goose_state_logs_dir, &path)
                else {
                    continue;
                };
                let raw = read_tail(&path, &mut budget)?;
                if raw.is_empty() {
                    continue;
                }
                let kind = match raw.iter().find(|&&b| !b.is_ascii_whitespace()) {
                    Some(&b'{') => ParserKind::TracingJson,
                    _ => ParserKind::TracingRfc3339,
                };
                let filtered = filter_by_recency(&raw, kind, cutoff);
                if filtered.is_empty() {
                    continue;
                }
                entries.push(ZipEntry {
                    name: format!("goosed-logs/{relative}"),
                    bytes: filtered,
                });
            }
        }
    }

    // 3. Doctor diagnostics report. Already vetted by the checks (keys only,
    //    never sensitive values), so it is included verbatim.
    if let Some(report) = doctor_report_text {
        let report = report.trim();
        if !report.is_empty() {
            entries.push(ZipEntry {
                name: "doctor/report.txt".to_string(),
                bytes: format!("{report}\n").into_bytes(),
            });
        }
    }

    if entries.is_empty() {
        return Err("No diagnostic logs were found to attach".to_string());
    }

    write_zip(entries)
}

fn write_zip(entries: Vec<ZipEntry>) -> Result<Vec<u8>, String> {
    let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for entry in entries {
        writer
            .start_file(&entry.name, options)
            .map_err(|error| format!("Failed to add {} to log archive: {error}", entry.name))?;
        writer
            .write_all(&entry.bytes)
            .map_err(|error| format!("Failed to write {} to log archive: {error}", entry.name))?;
    }

    let cursor = writer
        .finish()
        .map_err(|error| format!("Failed to finalize log archive: {error}"))?;
    Ok(cursor.into_inner())
}

/// Allowlist the Tauri shell log files: `goose.log` and rotated `goose.<N>.log`.
/// Files last modified before `cutoff` are skipped (recency filter).
fn enumerate_app_shell_logs(dir: &Path, cutoff: SystemTime) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return paths;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = file_name_str(&path) else {
            continue;
        };
        if is_hard_excluded(name) {
            continue;
        }
        if is_app_shell_log(name) && is_recent(&path, cutoff) {
            paths.push(path);
        }
    }
    paths.sort();
    paths
}

/// `goose.log` or `goose.<digits>.log` (rotated). Nothing else.
fn is_app_shell_log(name: &str) -> bool {
    if name == "goose.log" {
        return true;
    }
    match name
        .strip_prefix("goose.")
        .and_then(|r| r.strip_suffix(".log"))
    {
        Some(middle) => !middle.is_empty() && middle.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// Recursively collect `.log` files under a goosed log subtree (`cli`/`server`),
/// applying the hard-exclude guard and the recency filter to every candidate.
fn enumerate_goosed_logs(root: &Path, cutoff: SystemTime) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    collect_log_files(root, cutoff, &mut paths);
    paths.sort();
    paths
}

fn collect_log_files(dir: &Path, cutoff: SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_log_files(&path, cutoff, out);
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let Some(name) = file_name_str(&path) else {
            continue;
        };
        if is_hard_excluded(name) {
            continue;
        }
        if has_log_extension(name) && is_recent(&path, cutoff) {
            out.push(path);
        }
    }
}

/// True if `path`'s last-modified time is at or after `cutoff`. Uses the file's
/// real mtime (NOT the Jan 1 1980 timestamp the zip writer later stamps on
/// entries). If the mtime can't be read, the file is kept — better to over-
/// include a diagnostic than to silently drop a possibly-current log.
fn is_recent(path: &Path, cutoff: SystemTime) -> bool {
    match path.metadata().and_then(|meta| meta.modified()) {
        Ok(modified) => modified >= cutoff,
        Err(_) => true,
    }
}

fn has_log_extension(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("log"))
}

/// Files that contain full conversation/LLM content and must NEVER be exported,
/// even if they somehow appeared inside a scanned directory.
fn is_hard_excluded(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    // Full prompt/response transcripts written directly under logs/.
    if lower.starts_with("llm_request.") {
        return true;
    }
    // Conversation history database and its sidecars.
    if lower == "sessions.db" || lower == "sessions.db-wal" || lower == "sessions.db-shm" {
        return true;
    }
    false
}

/// Read up to `PER_FILE_TAIL_BYTES` (and no more than the remaining global
/// `budget`) from the END of the file, decrementing `budget` by what was read.
/// When the read starts mid-file, the leading partial line is trimmed.
fn read_tail(path: &Path, budget: &mut u64) -> Result<Vec<u8>, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open log {}: {error}", path.display()))?;
    let total = file
        .metadata()
        .map_err(|error| format!("Failed to stat log {}: {error}", path.display()))?
        .len();

    let read_len = total.min(PER_FILE_TAIL_BYTES).min(*budget);
    if read_len == 0 {
        return Ok(Vec::new());
    }

    let start = total - read_len;
    if start > 0 {
        file.seek(SeekFrom::Start(start))
            .map_err(|error| format!("Failed to seek log {}: {error}", path.display()))?;
    }

    let mut buffer = Vec::with_capacity(read_len as usize);
    file.take(read_len)
        .read_to_end(&mut buffer)
        .map_err(|error| format!("Failed to read log {}: {error}", path.display()))?;

    *budget = budget.saturating_sub(buffer.len() as u64);

    // If we started mid-file, drop the (likely partial) first line.
    if start > 0 {
        if let Some(newline) = buffer.iter().position(|&b| b == b'\n') {
            buffer.drain(..=newline);
        }
    }

    Ok(buffer)
}

/// Apply [`sanitize_app_log_line`] to every line of a shell-log chunk, dropping
/// captured sidecar lines and redacting secrets from the rest.
fn sanitize_app_log(raw: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(raw);
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        if let Some(sanitized) = crate::services::log_redaction::sanitize_app_log_line(line) {
            out.push_str(&sanitized);
            out.push('\n');
        }
    }
    out.into_bytes()
}

/// Per-line timestamp formats handled by [`filter_by_recency`].
#[derive(Clone, Copy)]
enum ParserKind {
    /// Tauri shell log: `[YYYY-MM-DD][HH:MM:SS]…`, UTC.
    ShellBracketed,
    /// goosed plain-text tracing: leading `YYYY-MM-DDTHH:MM:SS(.fraction)?Z`.
    TracingRfc3339,
    /// goosed JSON-line tracing: `…"timestamp":"<rfc3339>"…`.
    TracingJson,
}

/// Walk `raw` line-by-line and emit only lines whose nearest preceding parseable
/// timestamp is at or after `cutoff`. Lines without a parseable timestamp
/// inherit the previous line's decision so panic backtraces / multi-line
/// `Display` fields stay grouped with their header. Lines before any parseable
/// timestamp are dropped.
fn filter_by_recency(raw: &[u8], kind: ParserKind, cutoff: SystemTime) -> Vec<u8> {
    let cutoff_dt: DateTime<Utc> = cutoff.into();
    let text = String::from_utf8_lossy(raw);
    let mut out = String::with_capacity(text.len());
    let mut keep_current: Option<bool> = None;
    for line in text.split_inclusive('\n') {
        match parse_line_ts(line, kind) {
            Some(ts) => {
                let keep = ts >= cutoff_dt;
                keep_current = Some(keep);
                if keep {
                    out.push_str(line);
                }
            }
            None => {
                if keep_current == Some(true) {
                    out.push_str(line);
                }
            }
        }
    }
    out.into_bytes()
}

fn parse_line_ts(line: &str, kind: ParserKind) -> Option<DateTime<Utc>> {
    match kind {
        ParserKind::ShellBracketed => {
            // [YYYY-MM-DD][HH:MM:SS]
            let bytes = line.as_bytes();
            if bytes.len() < 22
                || bytes[0] != b'['
                || bytes[11] != b']'
                || bytes[12] != b'['
                || bytes[21] != b']'
            {
                return None;
            }
            let combined = format!("{}T{}", &line[1..11], &line[13..21]);
            let naive = NaiveDateTime::parse_from_str(&combined, "%Y-%m-%dT%H:%M:%S").ok()?;
            Some(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
        }
        ParserKind::TracingRfc3339 => {
            let end = line.find(|c: char| c.is_whitespace())?;
            DateTime::parse_from_rfc3339(&line[..end])
                .ok()
                .map(|dt| dt.with_timezone(&Utc))
        }
        ParserKind::TracingJson => {
            let needle = "\"timestamp\":\"";
            let start = line.find(needle)? + needle.len();
            let rest = &line[start..];
            let end = rest.find('"')?;
            DateTime::parse_from_rfc3339(&rest[..end])
                .ok()
                .map(|dt| dt.with_timezone(&Utc))
        }
    }
}

fn file_name_str(path: &Path) -> Option<&str> {
    path.file_name().and_then(|name| name.to_str())
}

/// Path of `file` relative to `base`, using forward slashes for the archive.
fn relative_archive_path(base: &Path, file: &Path) -> Option<String> {
    let relative = file.strip_prefix(base).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        parts.push(component.as_os_str().to_str()?.to_string());
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn allowlists_only_goose_shell_logs() {
        assert!(is_app_shell_log("goose.log"));
        assert!(is_app_shell_log("goose.0.log"));
        assert!(is_app_shell_log("goose.12.log"));
        assert!(!is_app_shell_log("goose.log.bak"));
        assert!(!is_app_shell_log("goose.abc.log"));
        assert!(!is_app_shell_log("other.log"));
        assert!(!is_app_shell_log("llm_request.0.jsonl"));
    }

    #[test]
    fn hard_excludes_conversation_artifacts() {
        assert!(is_hard_excluded("llm_request.0.jsonl"));
        assert!(is_hard_excluded("LLM_REQUEST.5.jsonl"));
        assert!(is_hard_excluded("sessions.db"));
        assert!(is_hard_excluded("sessions.db-wal"));
        assert!(is_hard_excluded("sessions.db-shm"));
        assert!(!is_hard_excluded("20260101_120000.log"));
        assert!(!is_hard_excluded("goose.log"));
    }

    #[test]
    fn only_dot_log_files_are_goosed_candidates() {
        assert!(has_log_extension("20260101_120000.log"));
        assert!(has_log_extension("session.LOG"));
        assert!(!has_log_extension("llm_request.0.jsonl"));
        assert!(!has_log_extension("sessions.db"));
    }

    #[test]
    fn enumerate_goosed_logs_recurses_and_filters() {
        let temp = tempfile::tempdir().unwrap();
        let cli = temp.path().join("cli").join("2026-01-01");
        fs::create_dir_all(&cli).unwrap();
        fs::write(cli.join("20260101_120000.log"), b"diag line\n").unwrap();
        // Must be ignored even if it somehow lands in the tree.
        fs::write(cli.join("llm_request.0.jsonl"), b"secret prompt\n").unwrap();
        fs::write(cli.join("sessions.db"), b"db\n").unwrap();

        // Wide-open cutoff (epoch) so the recency filter keeps everything; this
        // test is about the filename/extension filtering, not recency.
        let found = enumerate_goosed_logs(&temp.path().join("cli"), SystemTime::UNIX_EPOCH);

        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("20260101_120000.log"));
    }

    #[test]
    fn recency_filter_excludes_stale_and_keeps_recent() {
        let temp = tempfile::tempdir().unwrap();
        let cli = temp.path().join("cli");
        fs::create_dir_all(&cli).unwrap();

        let recent = cli.join("recent.log");
        let stale = cli.join("stale.log");
        fs::write(&recent, b"fresh diagnostics\n").unwrap();
        fs::write(&stale, b"ancient diagnostics\n").unwrap();

        // Backdate the stale file's mtime well beyond the window.
        let old = SystemTime::now() - (MAX_LOG_AGE + Duration::from_secs(3600));
        fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();

        let cutoff = SystemTime::now() - MAX_LOG_AGE;
        let found = enumerate_goosed_logs(&cli, cutoff);

        assert_eq!(found.len(), 1, "only the recent file should remain");
        assert!(found[0].ends_with("recent.log"));

        // is_recent agrees on each file directly.
        assert!(is_recent(&recent, cutoff));
        assert!(!is_recent(&stale, cutoff));
    }

    #[test]
    fn sanitize_app_log_drops_sidecar_and_redacts() {
        let raw = b"[INFO] starting token=abc123\n\
                    [INFO] [goose serve stdout] user typed a secret message\n\
                    [WARN] [goose serve stderr] panic with prompt text\n\
                    [INFO] ready\n";
        let out = String::from_utf8(sanitize_app_log(raw)).unwrap();

        assert!(out.contains("token=[redacted]"));
        assert!(!out.contains("goose serve stdout"));
        assert!(!out.contains("user typed a secret message"));
        assert!(!out.contains("prompt text"));
        assert!(out.contains("[INFO] ready"));
    }

    #[test]
    fn read_tail_returns_recent_bytes_on_line_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("goose.log");
        fs::write(&path, b"first line\nsecond line\nthird line\n").unwrap();

        // Plenty of budget, small file: full contents returned.
        let mut budget = MAX_TOTAL_RAW_BYTES;
        let all = read_tail(&path, &mut budget).unwrap();
        assert_eq!(all, b"first line\nsecond line\nthird line\n");
        assert_eq!(budget, MAX_TOTAL_RAW_BYTES - all.len() as u64);
    }

    #[test]
    fn build_logs_zip_collects_both_sources_and_excludes_unsafe() {
        let temp = tempfile::tempdir().unwrap();
        let app_log_dir = temp.path().join("Logs");
        let state_logs = temp.path().join("state").join("logs");
        fs::create_dir_all(&app_log_dir).unwrap();
        fs::create_dir_all(state_logs.join("cli").join("2026-01-01")).unwrap();
        fs::create_dir_all(state_logs.join("server").join("2026-01-01")).unwrap();

        // Embed a current-time timestamp on each line so the per-line recency
        // filter keeps them. Format mirrors what tauri_plugin_log and goosed
        // tracing emit in production.
        let now_utc: DateTime<Utc> = SystemTime::now().into();
        let shell_ts = now_utc.format("[%Y-%m-%d][%H:%M:%S]").to_string();
        let goosed_ts = now_utc.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        fs::write(
            app_log_dir.join("goose.log"),
            format!(
                "{shell_ts}[INFO] hello token=abc\n\
                 {shell_ts}[INFO] [diagnostic] category=gooseServe event=ready port=1234 api_key=abc\n\
                 {shell_ts}[INFO] [goose serve stdout] private\n"
            ),
        )
        .unwrap();
        // Conversation artifacts that must never appear, including one placed
        // directly under logs/ (where llm_request actually lives).
        fs::write(state_logs.join("llm_request.0.jsonl"), b"prompt\n").unwrap();
        fs::write(
            state_logs.join("cli").join("2026-01-01").join("run.log"),
            format!("{goosed_ts} INFO session_id=123 duration_ms=42\n"),
        )
        .unwrap();

        let dirs = LogDirs {
            app_log_dir,
            goose_state_logs_dir: state_logs,
        };
        let bytes = build_logs_zip(Some(&dirs), Some("Goose Internal doctor report\n")).unwrap();

        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names = Vec::new();
        for i in 0..archive.len() {
            names.push(archive.by_index(i).unwrap().name().to_string());
        }

        assert!(names.iter().any(|n| n == "app-shell/goose.log"));
        assert!(names
            .iter()
            .any(|n| n == "goosed-logs/cli/2026-01-01/run.log"));
        assert!(names.iter().any(|n| n == "doctor/report.txt"));
        assert!(names.iter().all(|n| !n.contains("llm_request")));

        let mut app_log_entry = archive.by_name("app-shell/goose.log").unwrap();
        let mut app_log_text = String::new();
        app_log_entry.read_to_string(&mut app_log_text).unwrap();
        assert!(app_log_text.contains("[diagnostic]"));
        assert!(app_log_text.contains("api_key=[redacted]"));
        assert!(!app_log_text.contains("api_key=abc"));
    }

    #[test]
    fn build_logs_zip_includes_doctor_report_without_log_dirs() {
        let bytes = build_logs_zip(None, Some("Goose Internal doctor report\nall good"))
            .expect("doctor-only zip should build");

        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names = Vec::new();
        for i in 0..archive.len() {
            names.push(archive.by_index(i).unwrap().name().to_string());
        }

        assert_eq!(names, vec!["doctor/report.txt".to_string()]);
    }

    fn fmt_shell(dt: DateTime<Utc>) -> String {
        dt.format("[%Y-%m-%d][%H:%M:%S]").to_string()
    }

    fn fmt_rfc3339(dt: DateTime<Utc>) -> String {
        dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
    }

    #[test]
    fn filter_shell_bracketed_keeps_recent_drops_stale() {
        let now: DateTime<Utc> = SystemTime::now().into();
        let stale = now - chrono::Duration::seconds((MAX_LOG_AGE.as_secs() + 3600) as i64);
        let raw = format!(
            "{}[INFO] stale entry\n{}[INFO] fresh entry\n",
            fmt_shell(stale),
            fmt_shell(now),
        );
        let cutoff = SystemTime::now() - MAX_LOG_AGE;
        let out = filter_by_recency(raw.as_bytes(), ParserKind::ShellBracketed, cutoff);
        let out = String::from_utf8(out).unwrap();
        assert!(!out.contains("stale entry"));
        assert!(out.contains("fresh entry"));
    }

    #[test]
    fn filter_tracing_rfc3339_keeps_recent_drops_stale() {
        let now: DateTime<Utc> = SystemTime::now().into();
        let stale = now - chrono::Duration::seconds((MAX_LOG_AGE.as_secs() + 3600) as i64);
        let raw = format!(
            "{} INFO stale event\n{} INFO fresh event\n",
            fmt_rfc3339(stale),
            fmt_rfc3339(now),
        );
        let cutoff = SystemTime::now() - MAX_LOG_AGE;
        let out = filter_by_recency(raw.as_bytes(), ParserKind::TracingRfc3339, cutoff);
        let out = String::from_utf8(out).unwrap();
        assert!(!out.contains("stale event"));
        assert!(out.contains("fresh event"));
    }

    #[test]
    fn filter_tracing_json_keeps_recent_drops_stale() {
        let now: DateTime<Utc> = SystemTime::now().into();
        let stale = now - chrono::Duration::seconds((MAX_LOG_AGE.as_secs() + 3600) as i64);
        let raw = format!(
            "{{\"timestamp\":\"{}\",\"msg\":\"stale json\"}}\n\
             {{\"timestamp\":\"{}\",\"msg\":\"fresh json\"}}\n",
            fmt_rfc3339(stale),
            fmt_rfc3339(now),
        );
        let cutoff = SystemTime::now() - MAX_LOG_AGE;
        let out = filter_by_recency(raw.as_bytes(), ParserKind::TracingJson, cutoff);
        let out = String::from_utf8(out).unwrap();
        assert!(!out.contains("stale json"));
        assert!(out.contains("fresh json"));
    }

    #[test]
    fn filter_groups_continuation_lines_with_header() {
        let now: DateTime<Utc> = SystemTime::now().into();
        let stale = now - chrono::Duration::seconds((MAX_LOG_AGE.as_secs() + 3600) as i64);
        let raw = format!(
            "{} INFO stale header\n  stale backtrace frame 1\n  stale backtrace frame 2\n\
             {} INFO fresh header\n  fresh backtrace frame 1\n  fresh backtrace frame 2\n",
            fmt_rfc3339(stale),
            fmt_rfc3339(now),
        );
        let cutoff = SystemTime::now() - MAX_LOG_AGE;
        let out = filter_by_recency(raw.as_bytes(), ParserKind::TracingRfc3339, cutoff);
        let out = String::from_utf8(out).unwrap();
        assert!(!out.contains("stale header"));
        assert!(!out.contains("stale backtrace"));
        assert!(out.contains("fresh header"));
        assert!(out.contains("fresh backtrace frame 1"));
        assert!(out.contains("fresh backtrace frame 2"));
    }

    #[test]
    fn build_logs_zip_errors_when_nothing_to_attach() {
        assert!(build_logs_zip(None, Some("   \n  ")).is_err());
        assert!(build_logs_zip(None, None).is_err());
    }
}
