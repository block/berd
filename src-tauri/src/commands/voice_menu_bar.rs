//! macOS menu bar controls for the process-wide native voice conversation.

use serde::Serialize;
use std::sync::mpsc;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewWindow,
};

use super::{native_voice::NativeVoiceState, voice_capture::VoiceCaptureState};

const TRAY_ID: &str = "voice-conversation";
const MUTE_ID: &str = "voice-conversation-mute";
const OPEN_ID: &str = "voice-conversation-open";
const STOP_ID: &str = "voice-conversation-stop";
pub const OPEN_SESSION_EVENT: &str = "voice-conversation:open-session";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenSessionPayload {
    session_id: String,
}

// AppKit traps if an NSStatusItem is created, mutated, or dropped off its main
// queue. Tauri's tray wrapper drops the native item when it leaves the manager.
fn on_main_thread<T, F>(app: &AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
{
    if objc2::MainThreadMarker::new().is_some() {
        return operation(app);
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    let main_thread_app = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(operation(&main_thread_app));
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .map_err(|_| "The voice menu bar main-thread operation was interrupted.".to_string())?
}

fn menu(app: &AppHandle, muted: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let status = MenuItem::new(app, "Voice conversation active", false, None::<&str>)?;
    let mute = CheckMenuItem::with_id(app, MUTE_ID, "Mute Microphone", true, muted, None::<&str>)?;
    let open = MenuItem::with_id(app, OPEN_ID, "Open Voice Session", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, STOP_ID, "Stop Voice Conversation", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&status, &separator, &mute, &open, &stop])
}

pub fn install(app: &AppHandle, muted: bool) -> Result<(), String> {
    on_main_thread(app, move |app| {
        let _ = app.remove_tray_by_id(TRAY_ID);
        let menu = menu(app, muted).map_err(|error| error.to_string())?;
        TrayIconBuilder::with_id(TRAY_ID)
            .menu(&menu)
            .title(if muted { "🔇" } else { "🎙" })
            .tooltip("Berd voice conversation")
            .build(app)
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
}

pub fn set_muted(app: &AppHandle, muted: bool) -> Result<(), String> {
    on_main_thread(app, move |app| {
        let Some(tray) = app.tray_by_id(TRAY_ID) else {
            return Ok(());
        };
        tray.set_title(Some(if muted { "🔇" } else { "🎙" }))
            .map_err(|error| error.to_string())?;
        tray.set_menu(Some(menu(app, muted).map_err(|error| error.to_string())?))
            .map_err(|error| error.to_string())
    })
}

pub fn remove(app: &AppHandle) {
    if let Err(error) = on_main_thread(app, |app| {
        let _ = app.remove_tray_by_id(TRAY_ID);
        Ok(())
    }) {
        log::warn!("Failed to remove the voice menu bar: {error}");
    }
}

fn focus_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn open_voice_session(app: &AppHandle) -> Result<(), String> {
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

pub fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        MUTE_ID => {
            let state = app.state::<NativeVoiceState>();
            let muted = !state.microphone_is_muted();
            if let Err(error) = state.set_microphone_muted(app, muted) {
                log::warn!("Failed to update voice microphone mute: {error}");
            }
        }
        OPEN_ID => {
            if let Err(error) = open_voice_session(app) {
                log::warn!("Failed to open the voice session: {error}");
            }
        }
        STOP_ID => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<NativeVoiceState>().inner().clone();
                let capture = app.state::<VoiceCaptureState>();
                if let Err(error) = state.stop_active(&app, capture.inner()).await {
                    log::warn!("Failed to stop the voice conversation from the menu bar: {error}");
                }
            });
        }
        _ => {}
    }
}
