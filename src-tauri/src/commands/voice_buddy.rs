//! Cross-platform always-on-top controls for the process-wide voice conversation.

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use super::{native_voice::NativeVoiceState, voice_capture::VoiceCaptureState};

pub const WINDOW_LABEL: &str = "voice-buddy";
pub const OPEN_SESSION_EVENT: &str = "voice-conversation:open-session";
const WINDOW_WIDTH: f64 = 248.0;
const WINDOW_HEIGHT: f64 = 196.0;
const SCREEN_INSET: i32 = 24;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenSessionPayload {
    session_id: String,
}

fn focus_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub fn open_active_session(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<NativeVoiceState>();
    let Some((session_id, owner_window_label)) = state.active_session_target() else {
        return Ok(());
    };
    let window = app
        .get_webview_window(&owner_window_label)
        .ok_or_else(|| "The voice session window is no longer available.".to_string())?;
    focus_window(&window);
    if owner_window_label == "main" {
        window
            .emit(OPEN_SESSION_EVENT, OpenSessionPayload { session_id })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn position_near_bottom_right(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let Ok(window_size) = window.outer_size() else {
        return;
    };
    let x = monitor_position.x
        + i32::try_from(monitor_size.width.saturating_sub(window_size.width)).unwrap_or_default()
        - SCREEN_INSET;
    let y = monitor_position.y
        + i32::try_from(monitor_size.height.saturating_sub(window_size.height)).unwrap_or_default()
        - SCREEN_INSET;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        return Ok(());
    }

    let entrypoint = if cfg!(target_os = "macos") {
        "index.html?voiceBuddy=1&menuBar=1"
    } else {
        "index.html?voiceBuddy=1"
    };
    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App(entrypoint.into()))
        .title("Berd voice conversation")
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;
    position_near_bottom_right(&window);
    window.show().map_err(|error| error.to_string())
}

pub fn remove(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
}

pub fn emit<T: Clone + Serialize>(app: &AppHandle, payload: T) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.emit(super::native_voice::EVENT_NAME, payload);
    }
}

#[tauri::command]
pub fn open_voice_conversation_session(app: AppHandle) -> Result<(), String> {
    open_active_session(&app)
}

#[tauri::command]
pub async fn stop_voice_conversation_from_buddy(
    app: AppHandle,
    state: tauri::State<'_, NativeVoiceState>,
    capture: tauri::State<'_, VoiceCaptureState>,
) -> Result<(), String> {
    state.stop_active(&app, capture.inner()).await
}

#[tauri::command]
pub fn send_voice_conversation_to_menu_bar(
    app: AppHandle,
    state: tauri::State<'_, NativeVoiceState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        super::voice_menu_bar::install(&app, state.microphone_is_muted())?;
        remove(&app);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state);
        Err("The menu bar voice surface is available only on macOS.".to_string())
    }
}
