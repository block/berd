//! Cross-platform always-on-top controls for the process-wide voice conversation.

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

use super::{native_voice::NativeVoiceState, voice_capture::VoiceCaptureState};

pub const WINDOW_LABEL: &str = "voice-buddy";
pub const OPEN_SESSION_EVENT: &str = "voice-conversation:open-session";
const WINDOW_WIDTH: f64 = 160.0;
const WINDOW_HEIGHT: f64 = 56.0;
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

fn position_near_bottom_right(app: &AppHandle, window: &WebviewWindow) {
    let owner_monitor = app
        .state::<NativeVoiceState>()
        .active_session_target()
        .and_then(|(_, label)| app.get_webview_window(&label))
        .and_then(|owner| owner.current_monitor().ok().flatten());
    let Some(monitor) = owner_monitor.or_else(|| window.primary_monitor().ok().flatten()) else {
        return;
    };
    let work_area = monitor.work_area();
    let Ok(window_size) = window.outer_size() else {
        return;
    };
    let x = work_area.position.x
        + i32::try_from(work_area.size.width.saturating_sub(window_size.width)).unwrap_or_default()
        - SCREEN_INSET;
    let y = work_area.position.y
        + i32::try_from(work_area.size.height.saturating_sub(window_size.height))
            .unwrap_or_default()
        - SCREEN_INSET;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn make_macos_transparent(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        use objc2_foundation::NSString;

        window
            .with_webview(|platform_webview| unsafe {
                let webview = platform_webview.inner() as *mut AnyObject;
                if webview.is_null() {
                    return;
                }

                let ns_window: *mut AnyObject = msg_send![&*webview, window];
                if !ns_window.is_null() {
                    let _: () = msg_send![&*ns_window, setOpaque: false];
                    if let Some(ns_color) = AnyClass::get(c"NSColor") {
                        let clear_color: *mut AnyObject = msg_send![ns_color, clearColor];
                        let _: () = msg_send![&*ns_window, setBackgroundColor: clear_color];
                    }
                }

                if let Some(ns_number) = AnyClass::get(c"NSNumber") {
                    let key = NSString::from_str("drawsBackground");
                    let no_value: *mut AnyObject = msg_send![ns_number, numberWithBool: false];
                    let _: () = msg_send![&*webview, setValue: no_value, forKey: &*key];
                }
            })
            .map_err(|error| error.to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::App("index.html?voiceBuddy=1".into()),
    )
    .title("Berd voice conversation")
    .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    let window = builder.build().map_err(|error| error.to_string())?;
    make_macos_transparent(&window)?;
    window.on_window_event(|event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
    });
    position_near_bottom_right(app, &window);
    window.show().map_err(|error| error.to_string())
}

pub fn remove(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.destroy();
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
