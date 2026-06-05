//! Renderer (WKWebView WebContent) memory telemetry.
//!
//! The UI runs inside a WKWebView whose web content lives in a separate
//! `com.apple.WebKit.WebContent` process. When that process exhausts memory,
//! WebKit silently reaps it and reloads the page — which users experience as
//! the app "crashing and restarting", but which leaves no trace in the app log
//! (the Rust/Tauri process and the goose backend both keep running).
//!
//! This service makes those failures visible:
//!   * It samples the renderer's resident set size (RSS) on a fixed interval
//!     and writes it to `goose.log`, with a louder warning once the renderer
//!     approaches the size at which WebKit tends to reap it.
//!   * It detects the reap itself by watching the WebContent process id: when
//!     the id changes, WebKit has spun up a fresh renderer in place of one it
//!     killed, so we log a warning with the last-known footprint.
//!   * It mirrors each sample to the frontend via the `goose:renderer-stats`
//!     event so the UI can surface the number if it wants to.
//!
//! Attribution note: the WebContent process is an XPC service re-parented to
//! `launchd` (ppid 1), so it can't be matched to this app by walking the
//! process tree. We instead read the exact renderer pid from the WKWebView via
//! its `-_webProcessIdentifier` accessor (guarded by `respondsToSelector:`),
//! then let `sysinfo` sample that pid's RSS. This is macOS-only; on other
//! platforms the monitor is simply never started.

#[cfg(target_os = "macos")]
use std::time::Duration;

#[cfg(target_os = "macos")]
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter, Manager};

/// Event emitted to the frontend with each renderer memory sample.
#[cfg(target_os = "macos")]
pub const RENDERER_STATS_EVENT: &str = "goose:renderer-stats";

/// Wait this long after startup before the first sample, so the WKWebView and
/// its WebContent process have been created.
#[cfg(target_os = "macos")]
const START_DELAY: Duration = Duration::from_secs(15);

/// Interval between renderer memory samples.
#[cfg(target_os = "macos")]
const SAMPLE_INTERVAL: Duration = Duration::from_secs(30);

/// Soft limit (MB) above which we warn that the renderer is at risk of being
/// reaped by WebKit. Empirically WebContent has been observed reaching ~5–6 GB
/// before macOS reaps it; warning at 4 GB gives early signal.
#[cfg(target_os = "macos")]
const WARN_RSS_MB: u64 = 4096;

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RendererStats {
    pid: u32,
    rss_bytes: u64,
    rss_mb: u64,
}

/// Start the renderer memory monitor on a dedicated background thread.
///
/// No-op on non-macOS targets (the renderer pid lookup is macOS-specific).
#[cfg(target_os = "macos")]
pub fn start(app: AppHandle) {
    if let Err(error) = std::thread::Builder::new()
        .name("renderer-monitor".into())
        .spawn(move || run_loop(app))
    {
        log::warn!("[renderer] failed to start renderer monitor: {error}");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn start(_app: tauri::AppHandle) {}

#[cfg(target_os = "macos")]
fn run_loop(app: AppHandle) {
    let mut sys = System::new();
    let mut last_pid: Option<u32> = None;
    let mut last_rss: Option<u64> = None;

    std::thread::sleep(START_DELAY);

    loop {
        let pid = app
            .get_webview_window("main")
            .as_ref()
            .and_then(query_webcontent_pid);

        if let Some(current) = pid {
            let rss = sample_rss(&mut sys, current);

            if let Some(message) = detect_reap(last_pid, last_rss, current) {
                log::warn!("[renderer] {message}");
            }

            if let Some(bytes) = rss {
                let mb = bytes / (1024 * 1024);
                log::info!("[renderer] WebContent pid={current} rss={mb} MB");
                if mb >= WARN_RSS_MB {
                    log::warn!(
                        "[renderer] WebContent pid={current} rss={mb} MB is above the {WARN_RSS_MB} MB soft limit; renderer is at risk of being reaped by WebKit"
                    );
                }
                let _ = app.emit(
                    RENDERER_STATS_EVENT,
                    RendererStats {
                        pid: current,
                        rss_bytes: bytes,
                        rss_mb: mb,
                    },
                );
                last_rss = Some(bytes);
            }

            // Only advance the tracked pid when we have a real reading, so a
            // transient lookup failure doesn't get mistaken for a reap.
            last_pid = Some(current);
        }

        std::thread::sleep(SAMPLE_INTERVAL);
    }
}

/// Returns a warning message when the renderer pid has changed, which means
/// WebKit reaped the previous WebContent process and started a fresh one.
///
/// Pure function so the reap heuristic can be unit-tested without a webview.
#[cfg(target_os = "macos")]
fn detect_reap(last_pid: Option<u32>, last_rss: Option<u64>, current_pid: u32) -> Option<String> {
    match last_pid {
        Some(old) if old != current_pid => {
            let footprint = match last_rss {
                Some(bytes) => format!("{} MB", bytes / (1024 * 1024)),
                None => "unknown".to_string(),
            };
            Some(format!(
                "WebContent process was reaped and restarted (was pid {old} at {footprint}, now pid {current_pid}); the renderer crashed and reloaded, likely out of memory"
            ))
        }
        _ => None,
    }
}

/// Sample the resident set size (bytes) of the given pid via sysinfo.
#[cfg(target_os = "macos")]
fn sample_rss(sys: &mut System, pid: u32) -> Option<u64> {
    let spid = Pid::from_u32(pid);
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[spid]),
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );
    sys.process(spid).map(|process| process.memory())
}

/// Read the WebContent process id backing the given window's WKWebView.
///
/// Uses the private `-_webProcessIdentifier` accessor, guarded by
/// `respondsToSelector:` so we degrade gracefully if it is ever removed.
/// `with_webview` marshals the call onto the main thread; we hand the result
/// back over a channel with a short timeout.
#[cfg(target_os = "macos")]
fn query_webcontent_pid(window: &tauri::WebviewWindow) -> Option<u32> {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};

    let (tx, rx) = std::sync::mpsc::channel::<Option<u32>>();
    let dispatch = window.with_webview(move |webview| {
        let ptr = webview.inner() as *mut AnyObject;
        // SAFETY: `ptr` is the live WKWebView for this window, accessed on the
        // main thread inside `with_webview`. We confirm the selector exists
        // before sending it, and `-_webProcessIdentifier` returns a `pid_t`.
        let pid = unsafe {
            if ptr.is_null() {
                None
            } else {
                let responds: bool =
                    msg_send![&*ptr, respondsToSelector: sel!(_webProcessIdentifier)];
                if responds {
                    let raw: i32 = msg_send![&*ptr, _webProcessIdentifier];
                    (raw > 0).then_some(raw as u32)
                } else {
                    None
                }
            }
        };
        let _ = tx.send(pid);
    });

    if dispatch.is_err() {
        return None;
    }
    rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn no_reap_on_first_observation() {
        assert!(detect_reap(None, None, 1234).is_none());
    }

    #[test]
    fn no_reap_when_pid_is_stable() {
        assert!(detect_reap(Some(1234), Some(5_000_000_000), 1234).is_none());
    }

    #[test]
    fn reap_detected_when_pid_changes() {
        let message = detect_reap(Some(1234), Some(5_368_709_120), 5678)
            .expect("pid change should be reported as a reap");
        assert!(message.contains("pid 1234"));
        assert!(message.contains("5120 MB"));
        assert!(message.contains("pid 5678"));
    }

    #[test]
    fn reap_message_handles_unknown_footprint() {
        let message =
            detect_reap(Some(10), None, 11).expect("pid change should be reported as a reap");
        assert!(message.contains("unknown"));
    }
}
