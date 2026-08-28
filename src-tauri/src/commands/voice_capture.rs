//! Shared renderer and microphone ownership for voice features.

use std::{collections::HashMap, sync::Mutex};

use serde::Deserialize;
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

#[derive(Default)]
struct CaptureState {
    renderer_epoch: u64,
    pending_renderers: HashMap<String, (String, u64)>,
    current_renderers: HashMap<String, (String, u64)>,
    foreground_sessions: HashMap<String, ForegroundSessionClaim>,
    microphone_owner: Option<MicrophoneOwner>,
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

    #[cfg(test)]
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
