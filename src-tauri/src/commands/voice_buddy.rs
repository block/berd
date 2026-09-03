//! Cross-platform always-on-top controls for the process-wide voice conversation.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

use super::{
    native_voice::{ControlsVisibilityAcknowledgement, NativeVoiceEvent, NativeVoiceState},
    voice_capture::VoiceCaptureState,
};

pub const WINDOW_LABEL: &str = "voice-buddy";
pub const OPEN_SESSION_EVENT: &str = "voice-conversation:open-session";
pub const REALTIME_CONTROL_EVENT: &str = "voice-conversation:realtime-control";
const WINDOW_WIDTH: f64 = 176.0;
const WINDOW_HEIGHT: f64 = 56.0;
const SCREEN_INSET: i32 = 24;

fn controls_url(revision: u64) -> String {
    format!("index.html?voiceBuddy=1&voiceRevision={revision}")
}

fn realtime_controls_url(revision: u64) -> String {
    format!("index.html?voiceBuddy=1&voiceMode=realtime&voiceRevision={revision}")
}

#[derive(Clone, Default)]
pub struct RealtimeVoiceControlsState {
    runtime: Arc<Mutex<RealtimeVoiceControlsRuntime>>,
}

#[derive(Default)]
struct RealtimeVoiceControlsRuntime {
    session_id: Option<String>,
    owner_window_label: Option<String>,
    revision: u64,
    microphone_muted: bool,
    controls_suppressed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeVoiceControlsStatus {
    available: bool,
    unavailable_reason: Option<String>,
    lifecycle: &'static str,
    session_id: Option<String>,
    owner_window_label: Option<String>,
    microphone_muted: bool,
    revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeControlsVisibilityRequest {
    session_id: String,
    expected_revision: u64,
    suppressed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeControlsActivityRequest {
    session_id: String,
    expected_revision: u64,
    activity: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeControlsMuteRequest {
    session_id: String,
    expected_revision: u64,
    muted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeControlsRebindRequest {
    previous_session_id: String,
    session_id: String,
    expected_revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeControlRequest {
    session_id: String,
    expected_revision: u64,
    action: String,
    muted: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RealtimeControlPayload {
    session_id: String,
    revision: u64,
    action: String,
    muted: Option<bool>,
}

impl RealtimeVoiceControlsState {
    fn status(&self) -> RealtimeVoiceControlsStatus {
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        RealtimeVoiceControlsStatus {
            available: true,
            unavailable_reason: None,
            lifecycle: if runtime.session_id.is_some() {
                "running"
            } else {
                "stopped"
            },
            session_id: runtime.session_id.clone(),
            owner_window_label: runtime.owner_window_label.clone(),
            microphone_muted: runtime.microphone_muted,
            revision: runtime.revision,
        }
    }

    pub(crate) fn active_target(&self) -> Option<(String, String, u64)> {
        let runtime = self.runtime.lock().ok()?;
        Some((
            runtime.session_id.clone()?,
            runtime.owner_window_label.clone()?,
            runtime.revision,
        ))
    }

    pub fn is_active_for_session(&self, session_id: &str) -> bool {
        self.runtime
            .lock()
            .ok()
            .and_then(|runtime| runtime.session_id.clone())
            .is_some_and(|active| active == session_id)
    }

    fn begin(&self, session_id: String, owner_window_label: String) -> Result<u64, String> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "realtime voice controls state lock was poisoned".to_string())?;
        if runtime.session_id.is_some() {
            return Err("Realtime voice controls are already active.".to_string());
        }
        runtime.revision = runtime.revision.wrapping_add(1);
        runtime.session_id = Some(session_id);
        runtime.owner_window_label = Some(owner_window_label);
        runtime.microphone_muted = false;
        runtime.controls_suppressed = true;
        Ok(runtime.revision)
    }

    fn finish(&self, session_id: &str, expected_revision: u64) -> Result<bool, String> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "realtime voice controls state lock was poisoned".to_string())?;
        if runtime.session_id.as_deref() != Some(session_id)
            || runtime.revision != expected_revision
        {
            return Ok(false);
        }
        runtime.session_id = None;
        runtime.owner_window_label = None;
        runtime.microphone_muted = false;
        runtime.controls_suppressed = false;
        runtime.revision = runtime.revision.wrapping_add(1);
        Ok(true)
    }

    fn rebind(
        &self,
        owner_window_label: &str,
        request: &RealtimeControlsRebindRequest,
    ) -> Result<bool, String> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "realtime voice controls state lock was poisoned".to_string())?;
        if runtime.session_id.as_deref() != Some(&request.previous_session_id)
            || runtime.revision != request.expected_revision
        {
            return Ok(false);
        }
        if runtime.owner_window_label.as_deref() != Some(owner_window_label) {
            return Err("Only the Realtime voice owner can move its session.".to_string());
        }
        runtime.session_id = Some(request.session_id.clone());
        runtime.revision = runtime.revision.wrapping_add(1);
        Ok(true)
    }
}

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
    let active_target = state.active_session_target().or_else(|| {
        app.state::<RealtimeVoiceControlsState>()
            .active_target()
            .map(|(session_id, owner_window_label, _)| (session_id, owner_window_label))
    });
    let Some((session_id, owner_window_label)) = active_target else {
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

fn position_near_bottom_right(app: &AppHandle, window: &WebviewWindow, owner_window_label: &str) {
    let owner_monitor = app
        .get_webview_window(owner_window_label)
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

fn show_controls_without_activation(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        window
            .with_webview(|platform_webview| unsafe {
                let webview = platform_webview.inner() as *mut AnyObject;
                if webview.is_null() {
                    return;
                }
                let ns_window: *mut AnyObject = msg_send![&*webview, window];
                if !ns_window.is_null() {
                    let _: () = msg_send![&*ns_window, orderFrontRegardless];
                }
            })
            .map_err(|error| error.to_string())?;
        if !window.is_visible().map_err(|error| error.to_string())? {
            return Err("The floating voice controls could not be shown.".to_string());
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    window.show().map_err(|error| error.to_string())
}

fn build_controls_window(
    app: &AppHandle,
    url: String,
    owner_window_label: &str,
) -> Result<WebviewWindow, String> {
    let builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App(url.into()))
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
    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    let window = builder.build().map_err(|error| error.to_string())?;
    if let Err(error) = make_macos_transparent(&window) {
        let _ = window.destroy();
        return Err(error);
    }
    window.on_window_event(|event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
    });
    position_near_bottom_right(app, &window, owner_window_label);
    Ok(window)
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<NativeVoiceState>();
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let stale_revision = state.controls_window_revision();
        window
            .destroy()
            .map_err(|error| format!("Could not replace stale floating voice controls: {error}"))?;
        if app.get_webview_window(WINDOW_LABEL).is_some() {
            return Err("Stale floating voice controls could not be replaced.".to_string());
        }
        state.clear_controls_window_if_revision(stale_revision);
    }
    let (session_id, owner_window_label, revision) = app
        .state::<NativeVoiceState>()
        .active_session_lifecycle_target()
        .ok_or_else(|| "No native voice conversation is active.".to_string())?;

    let window = build_controls_window(app, controls_url(revision), &owner_window_label)?;
    if let Err(error) = state.register_controls_window(&session_id, revision) {
        let _ = window.destroy();
        return Err(error);
    }
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
            }
        }
    });
    Ok(())
}

fn install_realtime(
    app: &AppHandle,
    owner_window_label: &str,
    revision: u64,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window
            .destroy()
            .map_err(|error| format!("Could not replace stale floating voice controls: {error}"))?;
        if app.get_webview_window(WINDOW_LABEL).is_some() {
            return Err("Stale floating voice controls could not be replaced.".to_string());
        }
        let native_state = app.state::<NativeVoiceState>();
        native_state.clear_controls_window_if_revision(native_state.controls_window_revision());
    }

    build_controls_window(app, realtime_controls_url(revision), owner_window_label)?;
    Ok(())
}

fn active_controls_match(active_revision: Option<u64>, controls_revision: Option<u64>) -> bool {
    active_revision.is_some() && active_revision == controls_revision
}

fn should_destroy_stale_candidate(
    candidate_revision: Option<u64>,
    active_revision: Option<u64>,
) -> bool {
    candidate_revision
        .is_some_and(|revision| !active_controls_match(active_revision, Some(revision)))
}

fn verify_stale_candidate_removed(
    candidate_revision: u64,
    current_revision: Result<Option<u64>, String>,
    destroy_result: Result<(), String>,
) -> Result<(), String> {
    let current_revision = current_revision?;
    if current_revision != Some(candidate_revision) {
        return Ok(());
    }
    destroy_result?;
    Err("Stale floating voice controls remained after removal.".to_string())
}

pub fn matches_active_lifecycle(app: &AppHandle) -> bool {
    app.get_webview_window(WINDOW_LABEL).is_some()
        && (app
            .state::<NativeVoiceState>()
            .controls_window_matches_active_lifecycle()
            || app
                .state::<RealtimeVoiceControlsState>()
                .active_target()
                .is_some())
}

pub fn should_preserve_main_for_voice(
    active_owner_window_label: Option<&str>,
    controls_match_active_voice: bool,
) -> bool {
    active_owner_window_label == Some("main") || controls_match_active_voice
}

pub fn destroy_stale_for_main_close(app: &AppHandle) -> Result<(), String> {
    if app
        .state::<RealtimeVoiceControlsState>()
        .active_target()
        .is_some()
    {
        return Ok(());
    }
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Ok(());
    };
    let state = app.state::<NativeVoiceState>();
    let candidate_revision = state.controls_window_revision();
    let active_revision = state
        .active_session_lifecycle_target()
        .map(|(_, _, revision)| revision);
    if !should_destroy_stale_candidate(candidate_revision, active_revision) {
        return Ok(());
    }
    let destroy_result = window
        .destroy()
        .map_err(|error| format!("Could not remove stale floating voice controls: {error}"));
    let current_revision = Ok(app
        .get_webview_window(WINDOW_LABEL)
        .and_then(|_| state.controls_window_revision()));
    let result = verify_stale_candidate_removed(
        candidate_revision.expect("stale candidates have a registered revision"),
        current_revision,
        destroy_result,
    );
    if result.is_ok() {
        state.clear_controls_window_if_revision(candidate_revision);
    }
    result
}

pub fn handle_realtime_voice_owner_window_destroyed(app: &AppHandle, window_label: &str) {
    let state = app.state::<RealtimeVoiceControlsState>();
    let Some((session_id, owner_window_label, revision)) = state.active_target() else {
        return;
    };
    if owner_window_label != window_label {
        return;
    }
    if state.finish(&session_id, revision).unwrap_or(false) {
        if let Some(controls) = app.get_webview_window(WINDOW_LABEL) {
            let _ = controls.destroy();
        }
    }
}

fn reconcile_terminal_controls(
    emit_terminal: impl FnOnce(),
    destroy: impl FnOnce() -> Result<(), String>,
    hide: impl FnOnce() -> Result<(), String>,
) {
    emit_terminal();
    if let Err(error) = destroy() {
        log::error!("Failed to remove stopped floating voice controls: {error}");
        if let Err(hide_error) = hide() {
            log::error!("Failed to hide stopped floating voice controls: {hide_error}");
        }
    }
}

pub fn dismiss_after_terminal_event<T: Clone + Serialize>(
    app: &AppHandle,
    controls_revision: u64,
    payload: T,
) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let state = app.state::<NativeVoiceState>();
    let window_matches_lifecycle = state.controls_window_revision() == Some(controls_revision);
    reconcile_terminal_controls(
        || {
            let _ = window.emit(super::native_voice::EVENT_NAME, payload);
        },
        || {
            if window_matches_lifecycle {
                window.destroy().map_err(|error| error.to_string())?;
                state.clear_controls_window_if_revision(Some(controls_revision));
            } else {
                return Ok(());
            }
            Ok(())
        },
        || {
            if window_matches_lifecycle {
                window.hide().map_err(|error| error.to_string())
            } else {
                Ok(())
            }
        },
    );
}

pub fn dismiss_stale_after_terminal(app: &AppHandle, terminal_revision: u64) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let state = app.state::<NativeVoiceState>();
    let candidate_revision = state.controls_window_revision();
    reconcile_terminal_controls(
        || {
            let _ = window.emit(
                super::native_voice::EVENT_NAME,
                NativeVoiceEvent::ControlsDismissed {
                    revision: terminal_revision,
                },
            );
        },
        || {
            window.destroy().map_err(|error| error.to_string())?;
            state.clear_controls_window_if_revision(candidate_revision);
            Ok(())
        },
        || window.hide().map_err(|error| error.to_string()),
    );
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
            window.hide().map_err(|error| error.to_string())
        } else {
            show_controls_without_activation(&window)
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
                show_controls_without_activation(&controls)
            } else {
                controls.hide().map_err(|error| error.to_string())
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

#[tauri::command]
pub fn start_openai_realtime_voice_controls(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, RealtimeVoiceControlsState>,
    native_state: tauri::State<'_, NativeVoiceState>,
    session_id: String,
) -> Result<RealtimeVoiceControlsStatus, String> {
    if window.label() == WINDOW_LABEL {
        return Err("Floating controls cannot own a Realtime voice conversation.".to_string());
    }
    if native_state.active_session_target().is_some() {
        return Err("A chained voice conversation is already active.".to_string());
    }
    let owner_window_label = window.label().to_string();
    let revision = state.begin(session_id.clone(), owner_window_label.clone())?;
    if let Err(error) = install_realtime(&app, &owner_window_label, revision) {
        let _ = state.finish(&session_id, revision);
        return Err(error);
    }
    Ok(state.status())
}

#[tauri::command]
pub fn get_openai_realtime_voice_controls_status(
    state: tauri::State<'_, RealtimeVoiceControlsState>,
) -> RealtimeVoiceControlsStatus {
    state.status()
}

#[tauri::command]
pub fn rebind_openai_realtime_voice_controls(
    window: WebviewWindow,
    state: tauri::State<'_, RealtimeVoiceControlsState>,
    request: RealtimeControlsRebindRequest,
) -> Result<RealtimeVoiceControlsStatus, String> {
    if state.rebind(window.label(), &request)? {
        let status = state.status();
        emit(
            window.app_handle(),
            NativeVoiceEvent::Startup {
                session_id: request.session_id,
                owner_window_label: window.label().to_string(),
                line: "Voice conversation resumed".to_string(),
                revision: status.revision,
            },
        );
        return Ok(status);
    }
    Err("The Realtime voice session changed before it could be moved.".to_string())
}

#[tauri::command]
pub fn show_openai_realtime_voice_controls(
    window: WebviewWindow,
    state: tauri::State<'_, RealtimeVoiceControlsState>,
    session_id: String,
    expected_revision: u64,
) -> Result<(), String> {
    require_controls_window(window.label())?;
    let suppressed = {
        let runtime = state
            .runtime
            .lock()
            .map_err(|_| "realtime voice controls state lock was poisoned".to_string())?;
        if runtime.session_id.as_deref() != Some(&session_id)
            || runtime.revision != expected_revision
        {
            return Ok(());
        }
        runtime.controls_suppressed
    };
    if suppressed {
        window.hide().map_err(|error| error.to_string())
    } else {
        show_controls_without_activation(&window)
    }
}

#[tauri::command]
pub fn set_openai_realtime_voice_controls_suppressed(
    window: WebviewWindow,
    state: tauri::State<'_, RealtimeVoiceControlsState>,
    request: RealtimeControlsVisibilityRequest,
) -> Result<(), String> {
    let should_show = {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| "realtime voice controls state lock was poisoned".to_string())?;
        if runtime.session_id.as_deref() != Some(&request.session_id)
            || runtime.revision != request.expected_revision
        {
            return Ok(());
        }
        if runtime.owner_window_label.as_deref() != Some(window.label()) {
            return Err("Only the Realtime voice owner can change control visibility.".to_string());
        }
        runtime.controls_suppressed = request.suppressed;
        !request.suppressed
    };
    let Some(controls) = window.app_handle().get_webview_window(WINDOW_LABEL) else {
        return Err("The floating voice controls are no longer available.".to_string());
    };
    if should_show {
        show_controls_without_activation(&controls)
    } else {
        controls.hide().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn publish_openai_realtime_voice_activity(
    window: WebviewWindow,
    state: tauri::State<'_, RealtimeVoiceControlsState>,
    request: RealtimeControlsActivityRequest,
) -> Result<(), String> {
    if !matches!(
        request.activity.as_str(),
        "user-speaking" | "user-idle" | "assistant-speaking" | "assistant-idle"
    ) {
        return Err("Unknown Realtime voice activity.".to_string());
    }
    let active = state.active_target();
    if active.as_ref()
        != Some(&(
            request.session_id.clone(),
            window.label().to_string(),
            request.expected_revision,
        ))
    {
        return Ok(());
    }
    emit(
        window.app_handle(),
        NativeVoiceEvent::Activity {
            session_id: request.session_id,
            activity: match request.activity.as_str() {
                "user-speaking" => "user-speaking",
                "user-idle" => "user-idle",
                "assistant-speaking" => "assistant-speaking",
                _ => "assistant-idle",
            },
            revision: request.expected_revision,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn publish_openai_realtime_voice_microphone_muted(
    window: WebviewWindow,
    state: tauri::State<'_, RealtimeVoiceControlsState>,
    request: RealtimeControlsMuteRequest,
) -> Result<(), String> {
    {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| "realtime voice controls state lock was poisoned".to_string())?;
        if runtime.session_id.as_deref() != Some(&request.session_id)
            || runtime.owner_window_label.as_deref() != Some(window.label())
            || runtime.revision != request.expected_revision
        {
            return Ok(());
        }
        runtime.microphone_muted = request.muted;
    }
    emit(
        window.app_handle(),
        NativeVoiceEvent::MicrophoneMute {
            session_id: request.session_id,
            muted: request.muted,
            revision: request.expected_revision,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn request_openai_realtime_voice_control(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, RealtimeVoiceControlsState>,
    request: RealtimeControlRequest,
) -> Result<(), String> {
    require_controls_window(window.label())?;
    if request.action != "stop" && request.action != "mute" {
        return Err("Unknown Realtime voice control action.".to_string());
    }
    if request.action == "mute" && request.muted.is_none() {
        return Err("Realtime mute controls require the requested state.".to_string());
    }
    let Some((session_id, owner_window_label, revision)) = state.active_target() else {
        return Ok(());
    };
    if session_id != request.session_id || revision != request.expected_revision {
        return Ok(());
    }
    let owner = app
        .get_webview_window(&owner_window_label)
        .ok_or_else(|| "The Realtime voice owner is no longer available.".to_string())?;
    owner
        .emit(
            REALTIME_CONTROL_EVENT,
            RealtimeControlPayload {
                session_id,
                revision,
                action: request.action,
                muted: request.muted,
            },
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stop_openai_realtime_voice_controls(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, RealtimeVoiceControlsState>,
    session_id: String,
    expected_revision: u64,
) -> Result<(), String> {
    let active = state.active_target();
    if active.as_ref()
        != Some(&(
            session_id.clone(),
            window.label().to_string(),
            expected_revision,
        ))
    {
        return Ok(());
    }
    let owner_window_label = active
        .as_ref()
        .map(|(_, owner_window_label, _)| owner_window_label.clone())
        .unwrap_or_default();
    if !state.finish(&session_id, expected_revision)? {
        return Ok(());
    }
    restore_hidden_owner(&app, &owner_window_label);
    if let Some(controls) = app.get_webview_window(WINDOW_LABEL) {
        let _ = controls.emit(
            super::native_voice::EVENT_NAME,
            NativeVoiceEvent::CleanShutdown {
                session_id,
                revision: expected_revision,
            },
        );
        controls.destroy().map_err(|error| error.to_string())?;
    }
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
    fn stale_controls_do_not_match_an_inactive_or_replacement_lifecycle() {
        assert!(active_controls_match(Some(4), Some(4)));
        assert!(!active_controls_match(None, Some(4)));
        assert!(!active_controls_match(Some(6), Some(4)));
        assert!(!active_controls_match(Some(4), None));
    }

    #[test]
    fn stale_cleanup_never_targets_controls_created_after_candidate_capture() {
        assert!(!should_destroy_stale_candidate(None, Some(4)));
        assert!(!should_destroy_stale_candidate(None, None));
        assert!(should_destroy_stale_candidate(Some(3), Some(4)));
        assert!(verify_stale_candidate_removed(
            3,
            Ok(Some(4)),
            Err("old handle is gone".to_string()),
        )
        .is_ok());
        assert!(verify_stale_candidate_removed(
            3,
            Ok(Some(3)),
            Err("old handle is stuck".to_string()),
        )
        .is_err());
        assert!(verify_stale_candidate_removed(
            3,
            Err("could not inspect current controls".to_string()),
            Err("old handle is stuck".to_string()),
        )
        .is_err());
    }

    #[test]
    fn main_is_preserved_during_owner_startup_without_controls() {
        assert!(should_preserve_main_for_voice(Some("main"), false));
        assert!(should_preserve_main_for_voice(Some("session:1"), true));
        assert!(!should_preserve_main_for_voice(Some("session:1"), false));
        assert!(!should_preserve_main_for_voice(None, false));
    }

    #[test]
    fn hidden_owner_restoration_policy_is_platform_specific() {
        assert!(!should_restore_owner(true));
        assert_eq!(should_restore_owner(false), cfg!(not(target_os = "macos")),);
    }

    #[test]
    fn terminal_controls_emit_before_destroy_and_hide_on_failure() {
        let emitted = std::cell::Cell::new(false);
        let hidden = std::cell::Cell::new(false);

        reconcile_terminal_controls(
            || emitted.set(true),
            || Err("destroy failed".to_string()),
            || {
                hidden.set(true);
                Ok(())
            },
        );

        assert!(emitted.get());
        assert!(hidden.get());
    }

    #[test]
    fn realtime_voice_presence_follows_start_rebind_and_stop() {
        let state = RealtimeVoiceControlsState::default();
        let revision = state
            .begin("draft-session".to_string(), "main".to_string())
            .expect("start realtime controls");
        assert!(state.is_active_for_session("draft-session"));
        assert!(!state.is_active_for_session("backend-session"));

        assert!(state
            .rebind(
                "main",
                &RealtimeControlsRebindRequest {
                    previous_session_id: "draft-session".to_string(),
                    session_id: "backend-session".to_string(),
                    expected_revision: revision,
                },
            )
            .expect("rebind realtime controls"));
        assert!(!state.is_active_for_session("draft-session"));
        assert!(state.is_active_for_session("backend-session"));
        let rebound_revision = state.status().revision;
        assert!(rebound_revision > revision);

        assert!(state
            .finish("backend-session", rebound_revision)
            .expect("stop realtime controls"));
        assert!(!state.is_active_for_session("backend-session"));
    }
}
