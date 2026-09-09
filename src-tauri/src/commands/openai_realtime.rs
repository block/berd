use berd_voice::openai_realtime_protocol::{
    expert_session_instructions, realtime_transcript_seed_events, RealtimeCoordinatorResult,
    RealtimeExpertDelivery, RealtimeExpertSpokespersonSession, RealtimeExpertTurnCompletion,
    RealtimePipeExchange, RealtimeSessionReduction, RealtimeSpokespersonSessionOptions,
    RealtimeTranscriptSeedTurn,
};
use berd_voice::openai_spokesperson::{OpenAiSpokespersonConfig, SpokespersonCommand};
use berd_voice::realtime_host::ManagedRealtimeHost;
use berd_voice::spokesperson_voice_update::VoiceUpdateRequest;
use berd_voice::{TtsConfigurationSnapshot, TtsSettings};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use super::openai_voice_credentials::{self, OpenAiVoiceCredential};
use super::voice_capture::VoiceCaptureState;

const OPENAI_REALTIME_CLIENT_SECRETS_URL: &str =
    "https://api.openai.com/v1/realtime/client_secrets";

#[derive(Default)]
pub struct OpenAiRealtimeRuntimeState {
    sessions: Mutex<HashMap<String, NativeRealtimeRuntime>>,
}

struct NativeRealtimeRuntime {
    owner_window: String,
    runtime: Arc<ManagedRealtimeHost>,
    status_sounds: Option<berd_voice::ManagedStatusSoundRuntime>,
    protocol: RealtimeExpertSpokespersonSession,
    semantic_revision: Arc<AtomicU64>,
}

impl NativeRealtimeRuntime {
    fn publish_semantic_context(&self) -> Result<(), String> {
        let revision = self.protocol.semantic_revision();
        if self.semantic_revision.load(Ordering::SeqCst) == revision {
            return Ok(());
        }
        self.runtime.update_semantic_context(
            revision,
            self.protocol.semantic_transcript(),
            self.protocol.has_unresolved_handoff(),
        )?;
        self.semantic_revision.store(revision, Ordering::SeqCst);
        Ok(())
    }
}

const OPENAI_REALTIME_RUNTIME_EVENT: &str = "openai-realtime-runtime-event";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenAiRealtimeRuntimeEvent {
    session_id: String,
    event: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiRealtimeStatus {
    configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiRealtimeSession {
    client_secret: String,
}

fn stored_openai_api_key() -> Result<Option<String>, String> {
    openai_voice_credentials::read(OpenAiVoiceCredential::Realtime)
}

#[tauri::command]
pub async fn get_openai_realtime_status() -> Result<OpenAiRealtimeStatus, String> {
    let configured = stored_openai_api_key()?.is_some();

    Ok(OpenAiRealtimeStatus { configured })
}

#[tauri::command]
pub async fn create_openai_realtime_session() -> Result<OpenAiRealtimeSession, String> {
    let api_key = openai_voice_credentials::require(OpenAiVoiceCredential::Realtime)?;
    let response = realtime_transcription_client_secret_request(&reqwest::Client::new(), &api_key)
        .send()
        .await
        .map_err(|error| {
            format!("Failed to create OpenAI Realtime transcription session: {error}")
        })?;
    parse_session_response(response, "transcription").await
}

#[tauri::command]
pub fn start_openai_realtime_spokesperson_runtime(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
    initial_cursor: u64,
    call_id: String,
    options: RealtimeSpokespersonSessionOptions,
) -> Result<(), String> {
    ensure_native_realtime_playback_supported()?;
    let session_id = non_empty_session_id(session_id)?;
    let call_id = non_empty_session_id(call_id)?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?;
    if sessions.contains_key(&session_id) {
        return Err("OpenAI Realtime runtime session is already active".into());
    }
    if sessions
        .values()
        .any(|entry| entry.owner_window == webview_window.label())
    {
        return Err("This window already owns an OpenAI Realtime runtime session".into());
    }

    let api_key = openai_voice_credentials::require(OpenAiVoiceCredential::Realtime)?;
    let config = OpenAiSpokespersonConfig::new(api_key, options, Vec::new());
    let semantic_revision = Arc::new(AtomicU64::new(0));
    let event_window = webview_window.clone();
    let event_session_id = session_id.clone();
    let runtime = Arc::new(ManagedRealtimeHost::spawn(
        config,
        Arc::clone(&semantic_revision),
        create_native_realtime_output,
        move |event| emit_runtime_provider_event(&event_window, &event_session_id, event),
    )?);
    log::info!(
        "Starting Expert-Spokesperson session {session_id} with execution_path=berd_voice_in_process transport=websocket playback=native_pcm"
    );
    let status_sounds =
        berd_voice::ManagedStatusSoundRuntime::spawn(super::pocket_voice::selected_output_device())
            .map_err(|error| log::warn!("Status sounds unavailable: {error}"))
            .ok();
    sessions.insert(
        session_id.clone(),
        NativeRealtimeRuntime {
            owner_window: webview_window.label().into(),
            runtime,
            status_sounds,
            protocol: RealtimeExpertSpokespersonSession::new(initial_cursor, call_id),
            semantic_revision,
        },
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_native_realtime_playback_supported() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn ensure_native_realtime_playback_supported() -> Result<(), String> {
    Err("Native OpenAI Realtime playback is not supported on this platform".into())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeStatusSoundUpdate {
    status: berd_voice::ConversationStatus,
    settings: berd_voice::StatusSoundSettings,
}

#[tauri::command]
pub fn update_openai_realtime_status_sounds(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
    update: RealtimeStatusSoundUpdate,
) -> Result<(), String> {
    with_runtime_entry(state, session_id, webview_window.label(), |entry| {
        entry
            .status_sounds
            .as_ref()
            .ok_or_else(|| "Status sound runtime is unavailable".to_string())?
            .update(update.status, update.settings)
    })
}

#[tauri::command]
pub fn send_openai_realtime_spokesperson_runtime_event(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
    event: serde_json::Value,
) -> Result<(), String> {
    with_runtime(state, session_id, webview_window.label(), |runtime| {
        runtime.send(SpokespersonCommand::Provider(event))
    })
}

#[tauri::command]
pub fn push_openai_realtime_spokesperson_audio(
    request: tauri::ipc::Request<'_>,
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("OpenAI Realtime audio requires a raw binary body".into());
    };
    let samples = super::native_voice::decode_voice_input_frame(bytes)?;
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?;
    let entry = sessions
        .values()
        .find(|entry| entry.owner_window == webview_window.label())
        .ok_or("This window does not own an OpenAI Realtime runtime session")?;
    entry.runtime.send(SpokespersonCommand::InputPcm48Khz(
        samples.as_samples().to_vec(),
    ))
}

#[tauri::command]
pub async fn stop_openai_realtime_spokesperson_runtime(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    let session_id = non_empty_session_id(session_id)?;
    let runtime = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?
        .get(&session_id)
        .map(|entry| {
            ensure_runtime_owner(&entry.owner_window, webview_window.label())?;
            Ok::<_, String>(Arc::clone(&entry.runtime))
        })
        .transpose()?;
    if let Some(runtime) = runtime {
        tauri::async_runtime::spawn_blocking(move || runtime.finish())
            .await
            .map_err(|error| format!("OpenAI Realtime runtime stop task failed: {error}"))??;
    }
    Ok(())
}

#[tauri::command]
pub async fn release_openai_realtime_spokesperson_runtime(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    let session_id = non_empty_session_id(session_id)?;
    let entry = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?;
        if let Some(entry) = sessions.get(&session_id) {
            ensure_runtime_owner(&entry.owner_window, webview_window.label())?;
        }
        sessions.remove(&session_id)
    };
    if let Some(entry) = entry {
        tauri::async_runtime::spawn_blocking(move || entry.runtime.finish())
            .await
            .map_err(|error| format!("OpenAI Realtime runtime release task failed: {error}"))??;
    }
    Ok(())
}

pub fn handle_owner_window_destroyed(app: &AppHandle, window_label: &str) {
    let state = app.state::<OpenAiRealtimeRuntimeState>();
    let runtimes = match state.sessions.lock() {
        Ok(mut sessions) => {
            let owned_session_ids = sessions
                .iter()
                .filter(|(_, entry)| entry.owner_window == window_label)
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            owned_session_ids
                .into_iter()
                .filter_map(|session_id| sessions.remove(&session_id))
                .map(|entry| entry.runtime)
                .collect::<Vec<_>>()
        }
        Err(_) => {
            log::error!("OpenAI Realtime runtime state is unavailable during window cleanup");
            return;
        }
    };
    for runtime in runtimes {
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = runtime.finish() {
                log::error!(
                    "Failed to stop OpenAI Realtime runtime for destroyed owner window: {error}"
                );
            }
        });
    }
}

fn with_runtime_entry<T>(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    session_id: String,
    owner_window: &str,
    operation: impl FnOnce(&NativeRealtimeRuntime) -> Result<T, String>,
) -> Result<T, String> {
    let session_id = non_empty_session_id(session_id)?;
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?;
    let entry = sessions
        .get(&session_id)
        .ok_or("OpenAI Realtime runtime session is not active")?;
    ensure_runtime_owner(&entry.owner_window, owner_window)?;
    operation(entry)
}

fn with_runtime<T>(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    session_id: String,
    owner_window: &str,
    operation: impl FnOnce(&ManagedRealtimeHost) -> Result<T, String>,
) -> Result<T, String> {
    let session_id = non_empty_session_id(session_id)?;
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?;
    let entry = sessions
        .get(&session_id)
        .ok_or("OpenAI Realtime runtime session is not active")?;
    ensure_runtime_owner(&entry.owner_window, owner_window)?;
    let runtime = entry.runtime.clone();
    drop(sessions);
    operation(&runtime)
}

#[tauri::command]
pub async fn update_openai_realtime_spokesperson_settings(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
    expected_revision: u64,
    voice: String,
    speed: f32,
) -> Result<TtsConfigurationSnapshot, String> {
    let session_id = non_empty_session_id(session_id)?;
    let (runtime, semantic_transcript, semantic_revision) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?;
        let entry = sessions
            .get(&session_id)
            .ok_or("OpenAI Realtime runtime session is not active")?;
        ensure_runtime_owner(&entry.owner_window, webview_window.label())?;
        (
            Arc::clone(&entry.runtime),
            entry.protocol.semantic_transcript(),
            entry.protocol.semantic_revision(),
        )
    };
    let current = runtime.snapshot()?;
    let model = match current.settings {
        TtsSettings::OpenAi { model, .. } => model,
        _ => return Err("Expert-Spokesperson requires OpenAI voice settings".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        runtime.update_settings(
            VoiceUpdateRequest {
                id: expected_revision,
                base_revision: expected_revision,
                settings: TtsSettings::OpenAi {
                    model,
                    voice,
                    rate: speed,
                },
                semantic_revision,
            },
            semantic_transcript,
        )
    })
    .await
    .map_err(|error| format!("Spokesperson settings task failed: {error}"))?
}

fn emit_runtime_provider_event(
    window: &WebviewWindow,
    session_id: &str,
    event: serde_json::Value,
) -> Result<(), String> {
    window
        .emit(
            OPENAI_REALTIME_RUNTIME_EVENT,
            OpenAiRealtimeRuntimeEvent {
                session_id: session_id.into(),
                event,
            },
        )
        .map_err(|error| format!("Could not publish OpenAI Realtime event: {error}"))
}

#[cfg(target_os = "macos")]
fn create_native_realtime_output() -> Result<Box<dyn berd_voice::PcmAudioOutput>, String> {
    berd_voice::PocketAudioPlayer::new(24_000, 1.0, None)
        .map(|output| Box::new(output) as Box<dyn berd_voice::PcmAudioOutput>)
}

#[cfg(not(target_os = "macos"))]
fn create_native_realtime_output() -> Result<Box<dyn berd_voice::PcmAudioOutput>, String> {
    Err("Native OpenAI Realtime playback is not supported on this platform".into())
}

#[tauri::command]
pub fn create_openai_realtime_expert_instructions(
    session_id: String,
    initial_cursor: u64,
    call_id: String,
) -> Result<String, String> {
    Ok(expert_session_instructions(
        &non_empty_session_id(session_id)?,
        initial_cursor,
        &non_empty_session_id(call_id)?,
    ))
}

#[tauri::command]
pub fn create_openai_realtime_transcript_seed(
    turns: Vec<RealtimeTranscriptSeedTurn>,
    max_items: usize,
    session_id: Option<String>,
) -> Vec<serde_json::Value> {
    realtime_transcript_seed_events(turns, max_items, session_id.as_deref())
}

#[tauri::command]
pub fn deliver_openai_realtime_expert_message(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
    cursor: u64,
    message: String,
    mode: berd_voice::openai_realtime_protocol::RealtimeExpertMessageMode,
    resolved_handoff_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let session_id = non_empty_session_id(session_id)?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?;
    let entry = sessions
        .get_mut(&session_id)
        .ok_or("OpenAI Realtime runtime session is not active")?;
    ensure_runtime_owner(&entry.owner_window, webview_window.label())?;
    let unknown = entry.protocol.unknown_handoff_ids(&resolved_handoff_ids);
    let submission =
        match entry
            .protocol
            .submit_expert_message(cursor, &message, mode, &resolved_handoff_ids)
        {
            Ok(submission) => submission,
            Err(error) if error == "context cannot resolve handoffs" => {
                return Ok(json!({
                    "accepted": false,
                    "reason": "context_cannot_resolve",
                    "cursor": entry.protocol.expert_pipe_cursor(),
                    "handoffIds": resolved_handoff_ids,
                }));
            }
            Err(_error) if !unknown.is_empty() => {
                return Ok(json!({
                    "accepted": false,
                    "reason": "unknown_handoff",
                    "cursor": entry.protocol.expert_pipe_cursor(),
                    "handoffIds": unknown,
                }));
            }
            Err(error) => return Err(error),
        };
    let accepted = match submission.exchange {
        RealtimePipeExchange::Accepted(accepted) => accepted,
        rejected => {
            return serde_json::to_value(rejected)
                .map_err(|error| format!("Could not serialize Expert delivery rejection: {error}"))
        }
    };
    let request = submission
        .request
        .ok_or("Accepted Expert delivery did not produce a provider request")?;
    for event in request.events {
        entry.runtime.send(SpokespersonCommand::Provider(event))?;
    }
    entry.publish_semantic_context()?;
    Ok(json!({
        "accepted": true,
        "cursor": accepted.cursor,
        "outbound": accepted.outbound,
        "deliveryStatus": request.status,
    }))
}

#[tauri::command]
pub fn dismiss_openai_realtime_handoffs_with_context(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
    cursor: u64,
    handoff_ids: Vec<String>,
    reason: String,
) -> Result<serde_json::Value, String> {
    let session_id = non_empty_session_id(session_id)?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?;
    let entry = sessions
        .get_mut(&session_id)
        .ok_or("OpenAI Realtime runtime session is not active")?;
    ensure_runtime_owner(&entry.owner_window, webview_window.label())?;
    let unknown = entry.protocol.unknown_handoff_ids(&handoff_ids);
    let dismissal =
        match entry
            .protocol
            .dismiss_handoffs_with_context(cursor, &handoff_ids, &reason)
        {
            Ok(dismissal) => dismissal,
            Err(_error) if !unknown.is_empty() => {
                return Ok(json!({
                    "accepted": false,
                    "reason": "unknown_handoff",
                    "cursor": entry.protocol.expert_pipe_cursor(),
                    "handoffIds": unknown,
                }));
            }
            Err(error) => return Err(error),
        };
    let accepted = match dismissal.exchange {
        RealtimePipeExchange::Accepted(accepted) => accepted,
        rejected => {
            return serde_json::to_value(rejected).map_err(|error| {
                format!("Could not serialize handoff dismissal rejection: {error}")
            })
        }
    };
    let request = dismissal
        .request
        .ok_or("Accepted handoff dismissal did not produce a provider request")?;
    let delivery_status = request.status;
    for event in request.events {
        entry.runtime.send(SpokespersonCommand::Provider(event))?;
    }
    entry.publish_semantic_context()?;
    Ok(json!({
        "accepted": true,
        "cursor": accepted.cursor,
        "dismissedHandoffIds": dismissal.dismissed_handoff_ids,
        "deliveryStatus": delivery_status,
    }))
}

#[tauri::command]
pub fn complete_openai_realtime_expert_turn(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
    retrying_handoff_ids: Vec<String>,
    max_attempts: u8,
) -> Result<RealtimeExpertTurnCompletion, String> {
    with_protocol_session(state, session_id, webview_window.label(), |session| {
        session.complete_expert_turn_with_delivery(&retrying_handoff_ids, max_attempts)
    })
}

#[tauri::command]
pub fn flush_openai_realtime_expert_events(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
) -> Result<Option<RealtimeExpertDelivery>, String> {
    with_protocol_session(state, session_id, webview_window.label(), |session| {
        Ok(session.flush_expert_events("Final voice transcript"))
    })
}

#[tauri::command]
pub fn reduce_openai_realtime_spokesperson_event(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
    event: serde_json::Value,
) -> Result<RealtimeSessionReduction, String> {
    let session_id = non_empty_session_id(session_id)?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime protocol state is unavailable".to_string())?;
    let entry = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "OpenAI Realtime protocol session is not active".to_string())?;
    ensure_runtime_owner(&entry.owner_window, webview_window.label())?;
    let result = entry.protocol.handle_provider_event(&event)?;
    entry.publish_semantic_context()?;
    Ok(result)
}

#[tauri::command]
pub fn request_openai_realtime_typed_user_message(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    webview_window: WebviewWindow,
    session_id: String,
    text: String,
) -> Result<RealtimeCoordinatorResult, String> {
    with_protocol_session(state, session_id, webview_window.label(), |session| {
        session.request_typed_user_message(&text)
    })
}

fn non_empty_session_id(session_id: String) -> Result<String, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        Err("OpenAI Realtime protocol session id cannot be empty".into())
    } else {
        Ok(session_id.into())
    }
}

fn with_protocol_session<T>(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    session_id: String,
    owner_window: &str,
    operation: impl FnOnce(&mut RealtimeExpertSpokespersonSession) -> Result<T, String>,
) -> Result<T, String> {
    let session_id = non_empty_session_id(session_id)?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime protocol state is unavailable".to_string())?;
    let entry = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "OpenAI Realtime protocol session is not active".to_string())?;
    ensure_runtime_owner(&entry.owner_window, owner_window)?;
    let result = operation(&mut entry.protocol)?;
    entry.publish_semantic_context()?;
    Ok(result)
}

fn ensure_runtime_owner(owner_window: &str, caller_window: &str) -> Result<(), String> {
    if owner_window != caller_window {
        return Err("This window does not own the OpenAI Realtime runtime session".into());
    }
    Ok(())
}

fn realtime_transcription_client_secret_request(
    client: &reqwest::Client,
    api_key: &str,
) -> reqwest::RequestBuilder {
    client
        .post(OPENAI_REALTIME_CLIENT_SECRETS_URL)
        .bearer_auth(api_key)
        .json(&json!({
            "session": {
                "type": "transcription",
                "audio": {
                    "input": {
                        "format": { "type": "audio/pcm", "rate": 24_000 },
                        "transcription": { "model": "gpt-realtime-whisper" },
                        "turn_detection": { "type": "server_vad" }
                    }
                }
            }
        }))
}

async fn parse_session_response(
    response: reqwest::Response,
    kind: &str,
) -> Result<OpenAiRealtimeSession, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read OpenAI Realtime response: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "OpenAI Realtime {kind} session creation failed ({status}): {body}"
        ));
    }
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("OpenAI Realtime returned invalid JSON: {error}"))?;
    Ok(OpenAiRealtimeSession {
        client_secret: parse_client_secret(&value)?,
    })
}

#[tauri::command]
pub fn claim_voice_dictation_microphone(
    state: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    renderer_id: String,
    renderer_epoch: u64,
    owner_id: String,
) -> Result<(), String> {
    state
        .claim_microphone(
            webview_window.label().to_string(),
            renderer_id,
            renderer_epoch,
            owner_id,
        )
        .map(|_| ())
}

#[tauri::command]
pub fn release_voice_dictation_microphone(
    state: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    renderer_id: String,
    renderer_epoch: u64,
    owner_id: String,
) -> Result<(), String> {
    state.release_microphone(
        webview_window.label(),
        &renderer_id,
        renderer_epoch,
        &owner_id,
    );
    Ok(())
}

fn parse_client_secret(value: &serde_json::Value) -> Result<String, String> {
    let client_secret = value.get("client_secret").and_then(client_secret_value);
    let top_level_value = value.get("value").and_then(|value| value.as_str());
    let top_level_secret = value.get("secret").and_then(|value| value.as_str());

    client_secret
        .or(top_level_value)
        .or(top_level_secret)
        .map(ToString::to_string)
        .ok_or_else(|| {
            "OpenAI realtime client secret response did not include a recognized secret field."
                .to_string()
        })
}

fn client_secret_value(value: &serde_json::Value) -> Option<&str> {
    value
        .get("value")
        .and_then(|value| value.as_str())
        .or_else(|| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_runtime_owner, parse_client_secret, realtime_transcription_client_secret_request,
    };
    use serde_json::json;

    #[test]
    fn runtime_ownership_requires_the_exact_invoking_window() {
        assert!(ensure_runtime_owner("owner", "owner").is_ok());
        for caller in ["other", "", "owner-other", "Owner"] {
            assert_eq!(
                ensure_runtime_owner("owner", caller).unwrap_err(),
                "This window does not own the OpenAI Realtime runtime session"
            );
        }
    }

    #[test]
    fn parses_supported_client_secret_shapes() {
        assert_eq!(
            parse_client_secret(&json!({ "client_secret": { "value": "nested" } })).unwrap(),
            "nested"
        );
        assert_eq!(
            parse_client_secret(&json!({ "client_secret": "direct" })).unwrap(),
            "direct"
        );
        assert_eq!(
            parse_client_secret(&json!({ "value": "value" })).unwrap(),
            "value"
        );
        assert_eq!(
            parse_client_secret(&json!({ "secret": "secret" })).unwrap(),
            "secret"
        );
    }

    #[test]
    fn rejects_missing_client_secret() {
        assert!(parse_client_secret(&json!({ "ok": true })).is_err());
    }

    #[test]
    fn dictation_client_secret_enables_input_transcription() {
        let request =
            realtime_transcription_client_secret_request(&reqwest::Client::new(), "sk-test-secret")
                .build()
                .expect("build request");
        let body: serde_json::Value = serde_json::from_slice(
            request
                .body()
                .and_then(|body| body.as_bytes())
                .expect("JSON body"),
        )
        .expect("parse request body");

        assert_eq!(body["session"]["type"], "transcription");
        assert_eq!(
            body["session"]["audio"]["input"]["transcription"]["model"],
            "gpt-realtime-whisper"
        );
    }
}
