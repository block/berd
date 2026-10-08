//! Berd Desktop Agent — native panel shell (macOS only, experiment-gated).
//!
//! Owns the lifecycle of the `desktop-agent` window: a small always-on-top,
//! non-activating NSPanel hosting the desktop-agent webview route
//! (`index.html?window=desktop-agent`). The settings bridge in the main
//! webview drives it:
//!
//! - setting enabled -> `desktop_agent_open`
//! - setting disabled -> `desktop_agent_close` (destroy; "Hide agent" in
//!   the panel's context menu turns the setting off, so hide == disable)
//!
//! The panel-toggle chord arrives as an ARGUMENT from the bridge (read
//! from the shortcuts-registry entry `desktopAgent.togglePanel`) — never
//! hardcoded here. Registration failure (e.g. the chord is held by another
//! app) logs and continues: the panel works without a shortcut.
//!
//! No activation-policy calls anywhere in this module: Berd is a regular
//! app with a Dock icon and must stay one. The non-activating NSPanel
//! style mask (panel.rs) alone keeps focus with the app the user is
//! working in.

pub mod capture;
pub mod coordinate_space;
mod main_thread;
mod overlay_panel;
mod panel;
pub mod perch;
pub mod permissions;
pub mod window_commands;

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Window label for the panel webview. Also referenced by the window-state
/// plugin denylist (lib.rs) and capabilities/desktop-agent.json.
pub const WINDOW_LABEL: &str = "desktop-agent";

/// Berd's main window label (the settings deep-link target). lib.rs uses
/// the string literal throughout; this module names it once.
const MAIN_WINDOW_LABEL: &str = "main";

/// Webview entry route: src/main.tsx branches on `?window=desktop-agent`.
const WINDOW_URL: &str = "index.html?window=desktop-agent";

/// Chord currently registered for the panel toggle (None while the panel
/// is closed). Lets a re-open with a changed binding swap chords, and
/// keeps the plugin handler honest about which chord is ours.
static REGISTERED_SHORTCUT: Mutex<Option<Shortcut>> = Mutex::new(None);

/// Global-shortcut plugin for the app builder (lib.rs). Nothing else in
/// Berd registers through this plugin today (the existing "global
/// shortcut" feature is the external catch sidecar), but the handler still
/// checks the chord against the one this module registered so a future
/// second registrant can't fire the panel toggle by accident.
pub fn global_shortcut_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let is_ours = REGISTERED_SHORTCUT
                .lock()
                .map(|registered| registered.as_ref() == Some(shortcut))
                .unwrap_or(false);
            if is_ours {
                let _ = app.emit_to(WINDOW_LABEL, "desktop-agent:toggle-panel", ());
            }
        })
        .build()
}

/// Settings deep-link from the panel's custom webview menu. Settings live
/// in the MAIN window: reveal + focus it first (it may be hidden or buried — the
/// panel is always-on-top, the main window is not), then tell its webview
/// to open the General settings section. The bridge listens (it is the
/// desktop-agent presence in the main webview).
#[tauri::command]
pub fn desktop_agent_open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
    app.emit_to(MAIN_WINDOW_LABEL, "desktop-agent:open-settings", ())
        .map_err(|e| e.to_string())
}

/// Opens the panel window (idempotent) and keeps the toggle chord
/// registered. Window flags match the prototype's panel window entry; the
/// NSPanel swizzle + flags land on the main thread before first paint.
///
/// The window is ALWAYS built hidden: a visible-at-build window
/// flashes as a white square at the OS default position — the webview
/// paints white until its first transparent paint, and the persisted
/// avatar position only lands after the webview restores it. The webview
/// itself reveals the panel via its first set_state once restore has
/// painted.
#[tauri::command]
pub fn desktop_agent_open(app: AppHandle, shortcut: String) -> Result<(), String> {
    if app.get_webview_window(WINDOW_LABEL).is_none() {
        let window =
            WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::App(WINDOW_URL.into()))
                .title("Berd Desktop Agent")
                .inner_size(94.0, 94.0)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .skip_taskbar(true)
                .accept_first_mouse(true)
                // ALWAYS hidden at build: the reveal happens at
                // the webview's first set_state after position restore —
                // never here, where the webview is an unpainted white
                // rect at the OS default position.
                .visible(false)
                .build()
                .map_err(|e| format!("failed to create desktop-agent window: {e}"))?;

        let panel_window = window.clone();
        main_thread::on_main(&app, move || {
            panel::install(&panel_window).map_err(|e| e.to_string())
        })??;
    }

    register_toggle_shortcut(&app, &shortcut);
    Ok(())
}

/// Destroys the panel window and releases the toggle chord (setting
/// disable). Chat state is server-side: a later open re-adopts it.
#[tauri::command]
pub fn desktop_agent_close(app: AppHandle) -> Result<(), String> {
    unregister_toggle_shortcut(&app);
    // Perch teardown BEFORE the window is destroyed: stops the targeting
    // and follow loops (whose next tick would otherwise touch the dying
    // window), hides both overlays, releases the AX element.
    perch::teardown(&app);
    // Un-swizzle IMMEDIATELY before destroy (the first live disable
    // crashed) — restores tao's original window class so teardown and
    // the eventual dealloc run the chain the window was built with.
    panel::prepare_destroy(&app);
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Native performWindowDrag handoff for the avatar (the webview mousedown
/// has already preventDefault-ed).
#[tauri::command]
pub fn desktop_agent_start_drag(app: AppHandle) -> Result<(), String> {
    panel::start_drag(&app).map_err(|e| e.to_string())
}

/// The shortcuts registry stores web-style chords ("alt+meta+b", where
/// meta = Command). The global-shortcut parser wants "super" for that
/// modifier; normalize so the registry format works unchanged.
fn normalize_chord(chord: &str) -> String {
    chord
        .split('+')
        .map(|token| match token.trim().to_ascii_lowercase().as_str() {
            "meta" => "super".to_string(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn register_toggle_shortcut(app: &AppHandle, chord: &str) {
    let parsed: Shortcut = match normalize_chord(chord).parse() {
        Ok(parsed) => parsed,
        Err(error) => {
            log::warn!("desktop-agent: unparseable toggle chord {chord:?}: {error}");
            // Release any previously registered chord (review Check 3):
            // an unparseable rebind (e.g. a cleared binding arriving as
            // "") must not leave the OLD chord registered with the OS
            // while settings show something else.
            unregister_toggle_shortcut(app);
            return;
        }
    };
    let Ok(mut registered) = REGISTERED_SHORTCUT.lock() else {
        log::warn!("desktop-agent: toggle chord state lock poisoned");
        return;
    };
    if *registered == Some(parsed) {
        return;
    }
    if let Some(previous) = registered.take() {
        if let Err(error) = app.global_shortcut().unregister(previous) {
            log::warn!("desktop-agent: failed to unregister previous toggle chord: {error}");
        }
    }
    match app.global_shortcut().register(parsed) {
        Ok(()) => *registered = Some(parsed),
        Err(error) => {
            // Log-and-continue: the chord may be held by another app; the
            // panel still works without a shortcut, and users can rebind
            // in Berd's shortcut settings.
            log::warn!("desktop-agent: could not register toggle chord {chord:?}: {error}");
        }
    }
}

fn unregister_toggle_shortcut(app: &AppHandle) {
    let Ok(mut registered) = REGISTERED_SHORTCUT.lock() else {
        return;
    };
    if let Some(previous) = registered.take() {
        if let Err(error) = app.global_shortcut().unregister(previous) {
            log::warn!("desktop-agent: failed to unregister toggle chord: {error}");
        }
    }
}
