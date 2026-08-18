//! Frontend-facing renderer telemetry command.
//!
//! Lets the web UI forward lifecycle signals it can observe (e.g. an
//! unexpected page reload after a renderer reap) into `berd.log`, alongside
//! the backend's `renderer_monitor` memory samples.
//!
//! This module also owns the Stdout log formatter: dev-time telemetry-viewer
//! lines arrive over this command tagged with [`TELEMETRY_VIEWER_LOG_TARGET`],
//! and the formatter renders exactly those records grey in the terminal. Both
//! ends of that seam — the command that stamps the target and the formatter
//! that keys off it — live here so they cannot drift apart. The LogDir target
//! deliberately has no formatter: the grey is ANSI escapes, which belong on a
//! terminal and would be pollution in `berd.log`.

use std::fmt::Arguments;

/// Log target for dev-time telemetry-viewer lines (`src/shared/telemetry/
/// devLog.ts`). Carrying the tag as the record's target rather than a message
/// prefix keeps it structured: the default format prints it as `[telemetry]`
/// in both the terminal and `berd.log`, and the Stdout formatter can key off
/// it without sniffing message content.
pub const TELEMETRY_VIEWER_LOG_TARGET: &str = "telemetry";

/// Bright-black (SGR 90): grey on every common terminal theme without
/// assuming a palette, unlike faint (SGR 2), which some terminals ignore.
const TELEMETRY_VIEWER_STYLE: &str = "\x1b[90m";
const ANSI_RESET: &str = "\x1b[0m";

/// Append a renderer lifecycle event from the frontend to the app log.
///
/// `target` is validated to a closed set; anything unrecognized falls back to
/// this module's own target, so the renderer cannot ride an arbitrary value
/// into another target's level filters (e.g. `perf`'s debug override).
#[tauri::command]
pub fn log_renderer_event(level: String, message: String, target: Option<String>) {
    let target = renderer_log_target(target.as_deref());
    match level.as_str() {
        "error" => log::error!(target: target, "[renderer] {message}"),
        "warn" => log::warn!(target: target, "[renderer] {message}"),
        _ => log::info!(target: target, "[renderer] {message}"),
    }
}

fn renderer_log_target(requested: Option<&str>) -> &'static str {
    match requested {
        Some(TELEMETRY_VIEWER_LOG_TARGET) => TELEMETRY_VIEWER_LOG_TARGET,
        _ => module_path!(),
    }
}

/// Per-target formatter for the Stdout log target: telemetry-viewer records
/// are wrapped in grey so they read apart from ordinary log output; every
/// other record passes through byte-identical.
///
/// This runs after the plugin's root formatter, so `message` is the finished
/// `[date][time][target][level] …` line and the whole line takes the color.
/// Styling here — on the one target that is a terminal — is what keeps the
/// escapes out of the LogDir target's `berd.log`.
pub fn stdout_log_format(
    out: fern::FormatCallback<'_>,
    message: &Arguments<'_>,
    record: &log::Record<'_>,
) {
    if record.target() == TELEMETRY_VIEWER_LOG_TARGET {
        out.finish(format_args!(
            "{TELEMETRY_VIEWER_STYLE}{message}{ANSI_RESET}"
        ));
    } else {
        out.finish(format_args!("{message}"));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// Runs one record through a dispatch wired like the Stdout target in
    /// `lib.rs` (the production formatter, then the sink) and returns the
    /// exact line the terminal would receive.
    fn stdout_line(target: &str, message: &str) -> String {
        let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&lines);
        let (_, logger) = fern::Dispatch::new()
            .format(stdout_log_format)
            .chain(fern::Output::call(move |record| {
                sink.lock().unwrap().push(record.args().to_string());
            }))
            .into_log();
        logger.log(
            &log::Record::builder()
                .args(format_args!("{message}"))
                .level(log::Level::Info)
                .target(target)
                .build(),
        );
        let lines = lines.lock().unwrap();
        assert_eq!(lines.len(), 1, "expected exactly one formatted line");
        lines[0].clone()
    }

    #[test]
    fn stdout_wraps_telemetry_viewer_records_in_grey() {
        // The exact bytes: bright-black SGR 90 opens, the full already-
        // formatted line rides inside, and the reset closes — nothing is
        // left styled after the record.
        assert_eq!(
            stdout_line(TELEMETRY_VIEWER_LOG_TARGET, "[renderer] main berd_x {}"),
            "\u{1b}[90m[renderer] main berd_x {}\u{1b}[0m"
        );
    }

    #[test]
    fn stdout_passes_other_records_through_byte_identical() {
        let line = "[2026-08-17][10:00:00][berd_lib::foo][INFO] plain line";
        assert_eq!(stdout_line("berd_lib::foo", line), line);
    }

    #[test]
    fn stdout_does_not_grey_on_message_content() {
        // Only the record's target selects the styling; a message that merely
        // mentions telemetry stays plain.
        let line = "[renderer] [telemetry] lookalike";
        assert_eq!(stdout_line("berd_lib::commands::renderer", line), line);
    }

    #[test]
    fn renderer_log_target_accepts_only_the_telemetry_tag() {
        assert_eq!(
            renderer_log_target(Some("telemetry")),
            TELEMETRY_VIEWER_LOG_TARGET
        );
        // Absent and unrecognized values both fall back to this module — in
        // particular "perf", whose debug level override a renderer request
        // must not be able to opt into.
        let fallback = "berd_lib::commands::renderer";
        assert_eq!(renderer_log_target(None), fallback);
        assert_eq!(renderer_log_target(Some("perf")), fallback);
        assert_eq!(renderer_log_target(Some("")), fallback);
    }
}
