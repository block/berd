//! Cross-platform always-on-top controls for the process-wide voice conversation.

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

use super::{
    native_voice::{ControlsVisibilityAcknowledgement, NativeVoiceState},
    voice_capture::VoiceCaptureState,
};

pub const WINDOW_LABEL: &str = "voice-buddy";
pub const OPEN_SESSION_EVENT: &str = "voice-conversation:open-session";
const WINDOW_WIDTH: f64 = 176.0;
const WINDOW_HEIGHT: f64 = 56.0;
const SCREEN_INSET: i32 = 24;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenSessionPayload {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlsVisibilityRequest {
    session_id: String,
    expected_revision: u64,
    suppressed: bool,
    renderer_id: String,
    renderer_epoch: u64,
}

fn focus_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn require_controls_window(window_label: &str) -> Result<(), String> {
    if window_label != WINDOW_LABEL {
        return Err("Only the floating voice controls can use this command.".to_string());
    }
    Ok(())
}

fn should_restore_owner(owner_visible: bool) -> bool {
    cfg!(not(target_os = "macos")) && !owner_visible
}

pub fn restore_hidden_owner(app: &AppHandle, owner_window_label: &str) {
    if let Some(owner) = app
        .get_webview_window(owner_window_label)
        .filter(|owner| should_restore_owner(owner.is_visible().unwrap_or(false)))
    {
        focus_window(&owner);
    }
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
    let (session_id, owner_window_label, revision) = app
        .state::<NativeVoiceState>()
        .active_session_lifecycle_target()
        .ok_or_else(|| "No native voice conversation is active.".to_string())?;

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
    let fallback_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let state = fallback_app.state::<NativeVoiceState>();
        if !state.controls_ready_for(&session_id, revision) {
            log::error!(
                "Floating voice controls did not become ready; stopping the voice conversation"
            );
            if state.active_session_lifecycle_target()
                != Some((session_id.clone(), owner_window_label.clone(), revision))
            {
                return;
            }
            let capture = fallback_app.state::<VoiceCaptureState>();
            if let Err(error) = state
                .stop_active_if_lifecycle(
                    &fallback_app,
                    capture.inner(),
                    &session_id,
                    revision,
                    "Voice controls could not open, so the voice conversation was stopped.",
                )
                .await
            {
                log::error!("Failed to stop voice after controls readiness timeout: {error}");
                remove(&fallback_app);
            }
        }
    });
    Ok(())
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
pub async fn show_voice_conversation_controls(
    window: WebviewWindow,
    state: tauri::State<'_, NativeVoiceState>,
    capture: tauri::State<'_, VoiceCaptureState>,
    session_id: String,
    expected_revision: u64,
) -> Result<(), String> {
    if window.label() != WINDOW_LABEL {
        return Err("Only the floating voice controls can show this window.".to_string());
    }
    let Some((active_session_id, owner_window_label, active_revision)) =
        state.active_session_lifecycle_target()
    else {
        return Ok(());
    };
    if active_session_id != session_id || active_revision != expected_revision {
        return Ok(());
    }
    let Some(mut target) = state.controls_visibility_target(&session_id, expected_revision)? else {
        return Ok(());
    };
    loop {
        let apply_result = if target.suppressed {
            window.hide()
        } else {
            window.show()
        };
        if let Err(error) = apply_result {
            if state.active_session_lifecycle_target()
                == Some((
                    session_id.clone(),
                    owner_window_label.clone(),
                    expected_revision,
                ))
            {
                state
                    .stop_active_if_lifecycle(
                        window.app_handle(),
                        capture.inner(),
                        &session_id,
                        expected_revision,
                        "Voice controls could not open, so the voice conversation was stopped.",
                    )
                    .await
                    .map_err(|stop_error| {
                        format!(
                            "The floating voice controls could not be prepared ({error}), and the voice conversation could not be stopped: {stop_error}"
                        )
                    })?;
            }
            return Err(error.to_string());
        }
        match state.acknowledge_controls_visibility(
            &session_id,
            expected_revision,
            target.generation,
        )? {
            ControlsVisibilityAcknowledgement::Inactive
            | ControlsVisibilityAcknowledgement::Ready => return Ok(()),
            ControlsVisibilityAcknowledgement::Superseded(next_target) => {
                target = next_target;
            }
        }
    }
}

#[tauri::command]
pub fn set_voice_conversation_controls_suppressed(
    window: WebviewWindow,
    state: tauri::State<'_, NativeVoiceState>,
    capture: tauri::State<'_, VoiceCaptureState>,
    request: ControlsVisibilityRequest,
) -> Result<(), String> {
    capture.with_active_renderer(
        window.label(),
        &request.renderer_id,
        request.renderer_epoch,
        || {
            let Some((should_show, previous_suppression)) = state.set_controls_suppressed(
                window.label(),
                &request.session_id,
                request.expected_revision,
                request.suppressed,
            )?
            else {
                return Ok(());
            };
            let Some(controls) = window.app_handle().get_webview_window(WINDOW_LABEL) else {
                state.rollback_controls_suppression(
                    &request.session_id,
                    request.expected_revision,
                    request.suppressed,
                    previous_suppression,
                );
                if should_show {
                    open_active_session(window.app_handle()).map_err(|recovery_error| {
                        format!(
                            "The floating voice controls are no longer available, and the voice session could not be restored: {recovery_error}"
                        )
                    })?;
                }
                return Err("The floating voice controls are no longer available.".to_string());
            };
            let result = if should_show {
                controls.show()
            } else {
                controls.hide()
            };
            if let Err(error) = result {
                state.rollback_controls_suppression(
                    &request.session_id,
                    request.expected_revision,
                    request.suppressed,
                    previous_suppression,
                );
                if should_show {
                    open_active_session(window.app_handle()).map_err(|recovery_error| {
                        format!(
                            "The floating voice controls could not be shown ({error}), and the voice session could not be restored: {recovery_error}"
                        )
                    })?;
                }
                return Err(error.to_string());
            }
            Ok(())
        },
    )
}

#[tauri::command]
pub async fn stop_voice_conversation_from_buddy(
    app: AppHandle,
    state: tauri::State<'_, NativeVoiceState>,
    capture: tauri::State<'_, VoiceCaptureState>,
    window: WebviewWindow,
    session_id: String,
    expected_revision: u64,
) -> Result<(), String> {
    require_controls_window(window.label())?;
    state
        .stop_active_for_lifecycle(&app, capture.inner(), &session_id, expected_revision)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hang_up_accepts_only_the_floating_controls_window() {
        assert!(require_controls_window(WINDOW_LABEL).is_ok());
        assert!(require_controls_window("main").is_err());
        assert!(require_controls_window("session:other").is_err());
    }

    #[test]
    fn hidden_owner_restoration_policy_is_platform_specific() {
        assert!(!should_restore_owner(true));
        assert_eq!(should_restore_owner(false), cfg!(not(target_os = "macos")),);
    }
}
