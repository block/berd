//! Shared renderer and microphone ownership for voice features.

use std::{collections::HashMap, sync::Mutex, time::Instant};

use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};

const MAX_ID_LEN: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
struct MicrophoneOwner {
    window_label: String,
    renderer_id: String,
    renderer_epoch: u64,
    owner_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ForegroundSessionClaim {
    renderer_id: String,
    renderer_epoch: u64,
    generation: u64,
    session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundSessionRequest {
    renderer_id: String,
    renderer_epoch: u64,
    generation: u64,
    session_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceTelemetryBackend {
    Parakeet,
    Macos,
    Pocket,
    Siri,
    Openai,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceTelemetryMode {
    Chained,
    OpenaiRealtime,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceTelemetryEndReason {
    User,
    Replacement,
    ControlsDismissed,
    CleanShutdown,
    Error,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTelemetryStartRequest {
    renderer_id: String,
    renderer_epoch: u64,
    input_backend: VoiceTelemetryBackend,
    output_backend: VoiceTelemetryBackend,
    voice_mode: VoiceTelemetryMode,
    tts_rate: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTelemetryOwnerRequest {
    renderer_id: String,
    renderer_epoch: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTelemetryEndRequest {
    fallback_reason: VoiceTelemetryEndReason,
}

struct ActiveVoiceTelemetry {
    owner_window_label: String,
    owner_renderer_id: String,
    owner_renderer_epoch: u64,
    input_backend: VoiceTelemetryBackend,
    output_backend: VoiceTelemetryBackend,
    voice_mode: VoiceTelemetryMode,
    tts_rate: Option<f64>,
    started_at: Instant,
    user_utterance_count: u64,
    assistant_response_count: u64,
    requested_end_reason: Option<VoiceTelemetryEndReason>,
    reportable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedVoiceTelemetry {
    input_backend: VoiceTelemetryBackend,
    output_backend: VoiceTelemetryBackend,
    voice_mode: VoiceTelemetryMode,
    tts_rate: Option<f64>,
    duration_ms: u64,
    user_utterance_count: u64,
    assistant_response_count: u64,
    end_reason: VoiceTelemetryEndReason,
    reportable: bool,
}

#[derive(Default)]
struct CaptureState {
    renderer_epoch: u64,
    pending_renderers: HashMap<String, (String, u64)>,
    current_renderers: HashMap<String, (String, u64)>,
    foreground_sessions: HashMap<String, ForegroundSessionClaim>,
    microphone_owner: Option<MicrophoneOwner>,
    active_voice_telemetry: Option<ActiveVoiceTelemetry>,
}

#[derive(Default)]
pub struct VoiceCaptureState {
    state: Mutex<CaptureState>,
}

impl CaptureState {
    fn register_renderer(
        &mut self,
        window_label: String,
        renderer_id: String,
    ) -> Result<u64, String> {
        self.renderer_epoch = self
            .renderer_epoch
            .checked_add(1)
            .ok_or_else(|| "Voice renderer epoch was exhausted".to_string())?;
        let renderer_epoch = self.renderer_epoch;
        self.pending_renderers
            .insert(window_label, (renderer_id, renderer_epoch));
        Ok(renderer_epoch)
    }

    fn activate_renderer(
        &mut self,
        window_label: &str,
        renderer_id: &str,
        renderer_epoch: u64,
    ) -> Result<(), String> {
        match self.current_renderers.get(window_label) {
            Some((active_renderer, active_epoch))
                if active_renderer == renderer_id && *active_epoch == renderer_epoch =>
            {
                return Ok(());
            }
            Some((_, active_epoch)) if *active_epoch >= renderer_epoch => {
                return Err("Voice renderer instance is no longer active".to_string());
            }
            _ => {}
        }

        match self.pending_renderers.get(window_label) {
            Some((pending_renderer, pending_epoch))
                if pending_renderer == renderer_id && *pending_epoch == renderer_epoch => {}
            _ => return Err("Voice renderer instance is not registered".to_string()),
        }

        let replaced_renderer = self
            .current_renderers
            .insert(
                window_label.to_string(),
                (renderer_id.to_string(), renderer_epoch),
            )
            .is_some_and(|(active_renderer, active_epoch)| {
                active_renderer != renderer_id || active_epoch != renderer_epoch
            });
        if replaced_renderer {
            self.foreground_sessions.remove(window_label);
        }
        if self
            .microphone_owner
            .as_ref()
            .is_some_and(|owner| owner.window_label == window_label)
        {
            if let Some(owner) = self
                .microphone_owner
                .as_mut()
                .filter(|owner| owner.owner_id.starts_with("native-voice:"))
            {
                owner.renderer_id = renderer_id.to_string();
                owner.renderer_epoch = renderer_epoch;
            } else {
                self.microphone_owner = None;
            }
        }
        if let Some(active) = self
            .active_voice_telemetry
            .as_mut()
            .filter(|active| active.owner_window_label == window_label)
        {
            active.owner_renderer_id = renderer_id.to_string();
            active.owner_renderer_epoch = renderer_epoch;
        }
        self.pending_renderers.remove(window_label);
        Ok(())
    }
}

impl VoiceCaptureState {
    #[cfg(test)]
    pub(crate) fn register_renderer_for_test(&self, window_label: &str, renderer_id: &str) -> u64 {
        self.state
            .lock()
            .expect("capture lock")
            .register_renderer(window_label.to_string(), renderer_id.to_string())
            .expect("register renderer")
    }

    pub(crate) fn with_active_renderer<T>(
        &self,
        window_label: &str,
        renderer_id: &str,
        renderer_epoch: u64,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        validate_id("renderer", renderer_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Voice capture state lock was poisoned".to_string())?;
        state.activate_renderer(window_label, renderer_id, renderer_epoch)?;
        operation()
    }

    pub fn activate_renderer(
        &self,
        window_label: &str,
        renderer_id: &str,
        renderer_epoch: u64,
    ) -> Result<(), String> {
        validate_id("renderer", renderer_id)?;
        self.state
            .lock()
            .map_err(|_| "Voice capture state lock was poisoned".to_string())?
            .activate_renderer(window_label, renderer_id, renderer_epoch)
    }

    pub fn set_foreground_session(
        &self,
        window_label: &str,
        renderer_id: &str,
        renderer_epoch: u64,
        generation: u64,
        session_id: Option<&str>,
    ) -> Result<(), String> {
        validate_id("renderer", renderer_id)?;
        if let Some(session_id) = session_id {
            validate_id("session", session_id)?;
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Voice capture state lock was poisoned".to_string())?;
        state.activate_renderer(window_label, renderer_id, renderer_epoch)?;
        if state
            .foreground_sessions
            .get(window_label)
            .is_some_and(|claim| {
                claim.renderer_id == renderer_id
                    && claim.renderer_epoch == renderer_epoch
                    && claim.generation >= generation
            })
        {
            return Ok(());
        }
        state.foreground_sessions.insert(
            window_label.to_string(),
            ForegroundSessionClaim {
                renderer_id: renderer_id.to_string(),
                renderer_epoch,
                generation,
                session_id: session_id.map(ToString::to_string),
            },
        );
        Ok(())
    }

    #[cfg(test)]
    fn foreground_session_matches(
        &self,
        window_label: &str,
        renderer_id: &str,
        renderer_epoch: u64,
        session_id: &str,
    ) -> Result<bool, String> {
        self.foreground_session_matches_generation(
            window_label,
            renderer_id,
            renderer_epoch,
            session_id,
            None,
        )
    }

    pub fn foreground_session_matches_generation(
        &self,
        window_label: &str,
        renderer_id: &str,
        renderer_epoch: u64,
        session_id: &str,
        expected_generation: Option<u64>,
    ) -> Result<bool, String> {
        validate_id("renderer", renderer_id)?;
        validate_id("session", session_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Voice capture state lock was poisoned".to_string())?;
        state.activate_renderer(window_label, renderer_id, renderer_epoch)?;
        Ok(state
            .foreground_sessions
            .get(window_label)
            .is_some_and(|claim| {
                claim.renderer_id == renderer_id
                    && claim.renderer_epoch == renderer_epoch
                    && claim.session_id.as_deref() == Some(session_id)
                    && expected_generation.is_none_or(|generation| claim.generation == generation)
            }))
    }

    pub fn claim_microphone(
        &self,
        window_label: String,
        renderer_id: String,
        renderer_epoch: u64,
        owner_id: String,
    ) -> Result<bool, String> {
        validate_id("renderer", &renderer_id)?;
        validate_id("owner", &owner_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Voice capture state lock was poisoned".to_string())?;
        state.activate_renderer(&window_label, &renderer_id, renderer_epoch)?;
        let requested = MicrophoneOwner {
            window_label,
            renderer_id,
            renderer_epoch,
            owner_id,
        };
        match state.microphone_owner.as_ref() {
            None => {
                state.microphone_owner = Some(requested);
                Ok(true)
            }
            Some(active) if active == &requested => Ok(false),
            Some(_) => Err("Another voice feature is already using the microphone".to_string()),
        }
    }

    pub fn release_microphone(
        &self,
        window_label: &str,
        renderer_id: &str,
        renderer_epoch: u64,
        owner_id: &str,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let matches = state.microphone_owner.as_ref().is_some_and(|active| {
            active.window_label == window_label
                && active.renderer_id == renderer_id
                && active.renderer_epoch == renderer_epoch
                && active.owner_id == owner_id
        });
        if matches {
            state.microphone_owner = None;
        }
        matches
    }

    pub fn release_owner(&self, window_label: &str, owner_id: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let matches = state.microphone_owner.as_ref().is_some_and(|active| {
            active.window_label == window_label && active.owner_id == owner_id
        });
        if matches {
            state.microphone_owner = None;
        }
        matches
    }

    fn start_voice_telemetry(
        &self,
        window_label: &str,
        request: VoiceTelemetryStartRequest,
    ) -> Result<bool, String> {
        validate_id("renderer", &request.renderer_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Voice capture state lock was poisoned".to_string())?;
        state.activate_renderer(window_label, &request.renderer_id, request.renderer_epoch)?;
        if state.active_voice_telemetry.is_some() {
            return Ok(false);
        }
        state.active_voice_telemetry = Some(ActiveVoiceTelemetry {
            owner_window_label: window_label.to_string(),
            owner_renderer_id: request.renderer_id,
            owner_renderer_epoch: request.renderer_epoch,
            input_backend: request.input_backend,
            output_backend: request.output_backend,
            voice_mode: request.voice_mode,
            tts_rate: request.tts_rate,
            started_at: Instant::now(),
            user_utterance_count: 0,
            assistant_response_count: 0,
            requested_end_reason: None,
            reportable: false,
        });
        Ok(true)
    }

    fn update_voice_telemetry(
        &self,
        request: &VoiceTelemetryOwnerRequest,
        update: impl FnOnce(&mut ActiveVoiceTelemetry),
    ) -> Result<(), String> {
        validate_id("renderer", &request.renderer_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Voice capture state lock was poisoned".to_string())?;
        if let Some(active) = state.active_voice_telemetry.as_mut().filter(|active| {
            active.owner_renderer_id == request.renderer_id
                && active.owner_renderer_epoch == request.renderer_epoch
        }) {
            update(active);
        }
        Ok(())
    }

    fn end_voice_telemetry(
        &self,
        fallback_reason: VoiceTelemetryEndReason,
    ) -> Result<Option<CompletedVoiceTelemetry>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Voice capture state lock was poisoned".to_string())?;
        Ok(state
            .active_voice_telemetry
            .take()
            .map(|active| CompletedVoiceTelemetry {
                input_backend: active.input_backend,
                output_backend: active.output_backend,
                voice_mode: active.voice_mode,
                tts_rate: active.tts_rate,
                duration_ms: u64::try_from(active.started_at.elapsed().as_millis())
                    .unwrap_or(u64::MAX),
                user_utterance_count: active.user_utterance_count,
                assistant_response_count: active.assistant_response_count,
                end_reason: active.requested_end_reason.unwrap_or(fallback_reason),
                reportable: active.reportable,
            }))
    }

    pub fn release_window(&self, window_label: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state
            .microphone_owner
            .as_ref()
            .is_some_and(|owner| owner.window_label == window_label)
        {
            state.microphone_owner = None;
        }
        state.current_renderers.remove(window_label);
        state.pending_renderers.remove(window_label);
        state.foreground_sessions.remove(window_label);
    }
}

#[tauri::command]
pub fn start_voice_conversation_telemetry(
    state: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    request: VoiceTelemetryStartRequest,
) -> Result<bool, String> {
    state.start_voice_telemetry(webview_window.label(), request)
}

#[tauri::command]
pub fn set_voice_conversation_telemetry_reportable(
    state: State<'_, VoiceCaptureState>,
    request: VoiceTelemetryOwnerRequest,
    reportable: bool,
) -> Result<(), String> {
    state.update_voice_telemetry(&request, |active| active.reportable = reportable)
}

#[tauri::command]
pub fn increment_voice_conversation_user_utterances(
    state: State<'_, VoiceCaptureState>,
    request: VoiceTelemetryOwnerRequest,
) -> Result<(), String> {
    state.update_voice_telemetry(&request, |active| active.user_utterance_count += 1)
}

#[tauri::command]
pub fn increment_voice_conversation_assistant_responses(
    state: State<'_, VoiceCaptureState>,
    request: VoiceTelemetryOwnerRequest,
) -> Result<(), String> {
    state.update_voice_telemetry(&request, |active| active.assistant_response_count += 1)
}

#[tauri::command]
pub fn request_voice_conversation_telemetry_end(
    state: State<'_, VoiceCaptureState>,
    request: VoiceTelemetryOwnerRequest,
    reason: VoiceTelemetryEndReason,
) -> Result<(), String> {
    state.update_voice_telemetry(&request, |active| {
        active.requested_end_reason = Some(reason)
    })
}

#[tauri::command]
pub fn clear_voice_conversation_telemetry_end(
    state: State<'_, VoiceCaptureState>,
    request: VoiceTelemetryOwnerRequest,
) -> Result<(), String> {
    state.update_voice_telemetry(&request, |active| active.requested_end_reason = None)
}

#[tauri::command]
pub fn end_voice_conversation_telemetry(
    state: State<'_, VoiceCaptureState>,
    request: VoiceTelemetryEndRequest,
) -> Result<Option<CompletedVoiceTelemetry>, String> {
    state.end_voice_telemetry(request.fallback_reason)
}

#[tauri::command]
pub fn set_voice_renderer_foreground_session(
    state: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    request: ForegroundSessionRequest,
) -> Result<(), String> {
    state.set_foreground_session(
        webview_window.label(),
        &request.renderer_id,
        request.renderer_epoch,
        request.generation,
        request.session_id.as_deref(),
    )
}

#[tauri::command]
pub fn register_voice_renderer_instance(
    state: State<'_, VoiceCaptureState>,
    native_voice: State<'_, super::native_voice::NativeVoiceState>,
    webview_window: WebviewWindow,
    renderer_id: String,
) -> Result<u64, String> {
    validate_id("renderer", &renderer_id)?;
    let window_label = webview_window.label().to_string();
    let mut capture_state = state
        .state
        .lock()
        .map_err(|_| "Voice capture state lock was poisoned".to_string())?;
    let epoch = capture_state.register_renderer(window_label.clone(), renderer_id.clone())?;
    native_voice.release_start_blocks_for_replaced_renderer(&window_label, &renderer_id, epoch);
    drop(capture_state);
    Ok(epoch)
}

fn validate_id(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_ID_LEN {
        return Err(format!(
            "Voice {label} id must be between 1 and {MAX_ID_LEN} bytes"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_telemetry_end_claim_is_atomic() {
        let capture = VoiceCaptureState::default();
        let epoch = capture.register_renderer_for_test("main", "renderer-1");
        capture
            .start_voice_telemetry(
                "main",
                VoiceTelemetryStartRequest {
                    renderer_id: "renderer-1".into(),
                    renderer_epoch: epoch,
                    input_backend: VoiceTelemetryBackend::Macos,
                    output_backend: VoiceTelemetryBackend::Siri,
                    voice_mode: VoiceTelemetryMode::Chained,
                    tts_rate: Some(1.25),
                },
            )
            .expect("start telemetry");

        let first = capture
            .end_voice_telemetry(VoiceTelemetryEndReason::User)
            .expect("first claim");
        let second = capture
            .end_voice_telemetry(VoiceTelemetryEndReason::Error)
            .expect("second claim");

        assert!(first.is_some());
        assert!(second.is_none());
        assert_eq!(first.expect("completed telemetry").duration_ms, 0);
    }

    #[test]
    fn voice_telemetry_updates_require_the_owner_renderer() {
        let capture = VoiceCaptureState::default();
        let owner_epoch = capture.register_renderer_for_test("main", "renderer-1");
        capture
            .start_voice_telemetry(
                "main",
                VoiceTelemetryStartRequest {
                    renderer_id: "renderer-1".into(),
                    renderer_epoch: owner_epoch,
                    input_backend: VoiceTelemetryBackend::Macos,
                    output_backend: VoiceTelemetryBackend::Siri,
                    voice_mode: VoiceTelemetryMode::Chained,
                    tts_rate: Some(1.25),
                },
            )
            .expect("start telemetry");
        let other_epoch = capture.register_renderer_for_test("other", "renderer-2");
        capture
            .update_voice_telemetry(
                &VoiceTelemetryOwnerRequest {
                    renderer_id: "renderer-2".into(),
                    renderer_epoch: other_epoch,
                },
                |active| active.user_utterance_count += 1,
            )
            .expect("ignore non-owner update");

        let completed = capture
            .end_voice_telemetry(VoiceTelemetryEndReason::User)
            .expect("claim end")
            .expect("completed telemetry");
        assert_eq!(completed.user_utterance_count, 0);
    }

    #[test]
    fn voice_telemetry_follows_replacement_renderer_and_rejects_stale_updates() {
        let capture = VoiceCaptureState::default();
        let first_epoch = capture.register_renderer_for_test("main", "renderer-1");
        capture
            .start_voice_telemetry(
                "main",
                VoiceTelemetryStartRequest {
                    renderer_id: "renderer-1".into(),
                    renderer_epoch: first_epoch,
                    input_backend: VoiceTelemetryBackend::Macos,
                    output_backend: VoiceTelemetryBackend::Siri,
                    voice_mode: VoiceTelemetryMode::Chained,
                    tts_rate: Some(1.25),
                },
            )
            .expect("start telemetry");
        let first = VoiceTelemetryOwnerRequest {
            renderer_id: "renderer-1".into(),
            renderer_epoch: first_epoch,
        };
        capture
            .update_voice_telemetry(&first, |active| {
                active.user_utterance_count += 1;
                active.reportable = true;
            })
            .expect("first utterance");
        let second_epoch = capture.register_renderer_for_test("main", "renderer-2");
        capture
            .activate_renderer("main", "renderer-2", second_epoch)
            .expect("reload");
        capture
            .update_voice_telemetry(
                &VoiceTelemetryOwnerRequest {
                    renderer_id: "renderer-2".into(),
                    renderer_epoch: second_epoch,
                },
                |active| active.user_utterance_count += 1,
            )
            .expect("resumed utterance");
        capture
            .update_voice_telemetry(&first, |active| active.user_utterance_count += 1)
            .expect("ignore stale renderer");
        let completed = capture
            .end_voice_telemetry(VoiceTelemetryEndReason::User)
            .expect("end")
            .expect("aggregate");
        assert_eq!(completed.user_utterance_count, 2);
        assert!(completed.reportable);
        assert_eq!(completed.tts_rate, Some(1.25));
    }

    #[test]
    fn renderer_ownership_is_exclusive_and_releasable() {
        let capture = VoiceCaptureState::default();
        let epoch = capture
            .state
            .lock()
            .expect("capture lock")
            .register_renderer("main".into(), "renderer-1".into())
            .expect("register renderer");
        assert!(capture
            .claim_microphone(
                "main".into(),
                "renderer-1".into(),
                epoch,
                "dictation".into(),
            )
            .expect("claim microphone"));
        assert!(!capture
            .claim_microphone(
                "main".into(),
                "renderer-1".into(),
                epoch,
                "dictation".into(),
            )
            .expect("repeat microphone claim"));
        assert!(capture
            .claim_microphone(
                "main".into(),
                "renderer-1".into(),
                epoch,
                "native-voice".into(),
            )
            .is_err());
        assert!(capture.release_microphone("main", "renderer-1", epoch, "dictation"));
        assert!(capture
            .claim_microphone(
                "main".into(),
                "renderer-1".into(),
                epoch,
                "native-voice".into(),
            )
            .expect("reclaim microphone"));
    }

    #[test]
    fn renderer_reload_rebinds_microphone_owner_without_releasing_it() {
        let capture = VoiceCaptureState::default();
        let first_epoch = capture
            .state
            .lock()
            .expect("capture lock")
            .register_renderer("main".into(), "renderer-1".into())
            .expect("register first renderer");
        assert!(capture
            .claim_microphone(
                "main".into(),
                "renderer-1".into(),
                first_epoch,
                "native-voice:session".into(),
            )
            .expect("claim microphone"));

        let second_epoch = capture
            .state
            .lock()
            .expect("capture lock")
            .register_renderer("main".into(), "renderer-2".into())
            .expect("register replacement renderer");
        capture
            .activate_renderer("main", "renderer-2", second_epoch)
            .expect("activate replacement renderer");

        assert!(capture
            .claim_microphone(
                "main".into(),
                "renderer-2".into(),
                second_epoch,
                "dictation".into(),
            )
            .is_err());
        assert!(capture.release_microphone(
            "main",
            "renderer-2",
            second_epoch,
            "native-voice:session",
        ));
    }

    #[test]
    fn renderer_reload_clears_non_resumable_microphone_owner() {
        let capture = VoiceCaptureState::default();
        let first_epoch = capture
            .state
            .lock()
            .expect("capture lock")
            .register_renderer("main".into(), "renderer-1".into())
            .expect("register first renderer");
        assert!(capture
            .claim_microphone(
                "main".into(),
                "renderer-1".into(),
                first_epoch,
                "dictation".into(),
            )
            .expect("claim microphone"));

        let second_epoch = capture
            .state
            .lock()
            .expect("capture lock")
            .register_renderer("main".into(), "renderer-2".into())
            .expect("register replacement renderer");
        assert!(capture
            .claim_microphone(
                "main".into(),
                "renderer-2".into(),
                second_epoch,
                "dictation-reloaded".into(),
            )
            .expect("replacement renderer reclaims microphone"));
    }

    #[test]
    fn replaced_renderer_cannot_run_a_late_voice_operation() {
        let capture = VoiceCaptureState::default();
        let first_epoch = capture
            .state
            .lock()
            .expect("capture lock")
            .register_renderer("main".into(), "renderer-1".into())
            .expect("register first renderer");
        capture
            .activate_renderer("main", "renderer-1", first_epoch)
            .expect("activate first renderer");
        let second_epoch = capture
            .state
            .lock()
            .expect("capture lock")
            .register_renderer("main".into(), "renderer-2".into())
            .expect("register replacement renderer");
        capture
            .activate_renderer("main", "renderer-2", second_epoch)
            .expect("activate replacement renderer");
        let operation_ran = std::cell::Cell::new(false);

        assert!(capture
            .with_active_renderer("main", "renderer-1", first_epoch, || {
                operation_ran.set(true);
                Ok(())
            })
            .is_err());
        assert!(!operation_ran.get());
    }

    #[test]
    fn foreground_session_claim_rejects_a_stale_navigation_target() {
        let capture = VoiceCaptureState::default();
        let epoch = capture.register_renderer_for_test("main", "renderer-1");
        capture
            .set_foreground_session("main", "renderer-1", epoch, 1, Some("session-b"))
            .expect("claim session B");
        assert!(capture
            .foreground_session_matches("main", "renderer-1", epoch, "session-b")
            .expect("authorize session B"));

        capture
            .set_foreground_session("main", "renderer-1", epoch, 2, Some("session-c"))
            .expect("navigate to session C");
        assert!(!capture
            .foreground_session_matches("main", "renderer-1", epoch, "session-b")
            .expect("reject stale session B"));
        assert!(capture
            .foreground_session_matches("main", "renderer-1", epoch, "session-c")
            .expect("authorize session C"));
        assert!(!capture
            .foreground_session_matches_generation(
                "main",
                "renderer-1",
                epoch,
                "session-c",
                Some(1),
            )
            .expect("reject superseded generation"));
        assert!(capture
            .foreground_session_matches_generation(
                "main",
                "renderer-1",
                epoch,
                "session-c",
                Some(2),
            )
            .expect("authorize current generation"));
    }

    #[test]
    fn foreground_session_claim_ignores_out_of_order_updates() {
        let capture = VoiceCaptureState::default();
        let epoch = capture.register_renderer_for_test("main", "renderer-1");
        capture
            .set_foreground_session("main", "renderer-1", epoch, 2, Some("session-c"))
            .expect("claim newest session");
        capture
            .set_foreground_session("main", "renderer-1", epoch, 1, Some("session-b"))
            .expect("ignore stale claim");

        assert!(capture
            .foreground_session_matches("main", "renderer-1", epoch, "session-c")
            .expect("retain newest session"));
    }
}
