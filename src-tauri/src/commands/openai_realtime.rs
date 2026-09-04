use berd_voice::openai_realtime_protocol::{
    accepted_handoff_tool_output, expert_session_instructions, invalid_tool_call_output,
    realtime_transcript_seed_events, RealtimeCoordinatorResult, RealtimeExpertMessage,
    RealtimeExpertSpokespersonSession, RealtimeHandoffReminder, RealtimePipeExchange,
    RealtimeSessionReduction, RealtimeSpokespersonSessionOptions, RealtimeTranscriptSeedTurn,
};
use berd_voice::openai_spokesperson::{
    OpenAiSpokespersonConfig, OpenAiSpokespersonControl, OpenAiSpokespersonRuntime,
    SpokespersonCommand, SpokespersonEvent,
};
use serde::Serialize;
use serde_json::json;
use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager, State, WebviewWindow};

use super::openai_voice_credentials::{self, OpenAiVoiceCredential};
use super::voice_capture::VoiceCaptureState;

const OPENAI_REALTIME_CLIENT_SECRETS_URL: &str =
    "https://api.openai.com/v1/realtime/client_secrets";

#[derive(Default)]
pub struct OpenAiRealtimeProtocolState {
    sessions: Mutex<HashMap<String, RealtimeExpertSpokespersonSession>>,
}

#[derive(Default)]
pub struct OpenAiRealtimeRuntimeState {
    sessions: Mutex<HashMap<String, NativeRealtimeRuntime>>,
}

struct NativeRealtimeRuntime {
    owner_window: String,
    runtime: OpenAiSpokespersonRuntime,
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
    options: RealtimeSpokespersonSessionOptions,
) -> Result<(), String> {
    let session_id = non_empty_session_id(session_id)?;
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
    let (runtime, events) = OpenAiSpokespersonRuntime::spawn_observed(config)?;
    let control = runtime.control();
    log::info!(
        "Starting Expert-Spokesperson session {session_id} with execution_path=berd_voice_in_process transport=websocket playback=native_pcm"
    );
    sessions.insert(
        session_id.clone(),
        NativeRealtimeRuntime {
            owner_window: webview_window.label().into(),
            runtime,
        },
    );
    drop(sessions);

    let pump_session_id = session_id.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("berd-realtime-native-host".into())
        .spawn(move || {
            pump_native_realtime_events(webview_window, pump_session_id, control, events)
        })
    {
        let entry = state
            .sessions
            .lock()
            .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?
            .remove(&session_id);
        if let Some(entry) = entry {
            let _ = entry.runtime.finish();
        }
        return Err(format!("Could not start native Realtime host: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub fn send_openai_realtime_spokesperson_runtime_event(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    session_id: String,
    event: serde_json::Value,
) -> Result<(), String> {
    with_runtime(state, session_id, |runtime| {
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
    let samples = bytes
        .chunks_exact(std::mem::size_of::<f32>())
        .map(|bytes| f32::from_le_bytes(bytes.try_into().expect("four-byte chunk")))
        .collect::<Vec<_>>();
    if samples.len() * std::mem::size_of::<f32>() != bytes.len()
        || samples.iter().any(|sample| !sample.is_finite())
    {
        return Err("OpenAI Realtime audio must contain finite 32-bit PCM samples".into());
    }
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?;
    let entry = sessions
        .values()
        .find(|entry| entry.owner_window == webview_window.label())
        .ok_or("This window does not own an OpenAI Realtime runtime session")?;
    entry
        .runtime
        .send(SpokespersonCommand::InputPcm48Khz(samples))
}

#[tauri::command]
pub fn stop_openai_realtime_spokesperson_runtime(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    session_id: String,
) -> Result<(), String> {
    let session_id = non_empty_session_id(session_id)?;
    let entry = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?
        .remove(&session_id);
    if let Some(entry) = entry {
        entry.runtime.finish()?;
    }
    Ok(())
}

fn with_runtime<T>(
    state: State<'_, OpenAiRealtimeRuntimeState>,
    session_id: String,
    operation: impl FnOnce(&OpenAiSpokespersonRuntime) -> Result<T, String>,
) -> Result<T, String> {
    let session_id = non_empty_session_id(session_id)?;
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime runtime state is unavailable".to_string())?;
    operation(
        &sessions
            .get(&session_id)
            .ok_or("OpenAI Realtime runtime session is not active")?
            .runtime,
    )
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

fn pump_native_realtime_events(
    window: WebviewWindow,
    session_id: String,
    control: OpenAiSpokespersonControl,
    events: std::sync::mpsc::Receiver<SpokespersonEvent>,
) {
    let result = berd_voice::realtime_host::run_realtime_host(
        events,
        |command| control.send(command),
        create_native_realtime_output,
        |event| emit_runtime_provider_event(&window, &session_id, event),
    );
    if let Err(error) = result {
        let _ = emit_runtime_provider_event(
            &window,
            &session_id,
            json!({ "type": "berd.realtime.failed", "message": error }),
        );
    }
    let entry = window
        .state::<OpenAiRealtimeRuntimeState>()
        .sessions
        .lock()
        .ok()
        .and_then(|mut sessions| sessions.remove(&session_id));
    if let Some(entry) = entry {
        if let Err(error) = entry.runtime.finish() {
            let _ = emit_runtime_provider_event(
                &window,
                &session_id,
                json!({ "type": "berd.realtime.failed", "message": error }),
            );
        }
    }
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
pub fn create_openai_realtime_handoff_tool_output(
    call_id: String,
    handoff_id: String,
) -> Result<serde_json::Value, String> {
    accepted_handoff_tool_output(&call_id, &handoff_id)
}

#[tauri::command]
pub fn create_openai_realtime_invalid_tool_output(
    call_id: String,
    tool_name: String,
    error: String,
) -> Result<serde_json::Value, String> {
    invalid_tool_call_output(&call_id, &tool_name, &error)
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
pub fn start_openai_realtime_spokesperson_protocol(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    initial_cursor: u64,
) -> Result<(), String> {
    let session_id = non_empty_session_id(session_id)?;
    state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime protocol state is unavailable".to_string())?
        .insert(
            session_id,
            RealtimeExpertSpokespersonSession::new(initial_cursor),
        );
    Ok(())
}

#[tauri::command]
pub fn enqueue_openai_realtime_spokesperson_message(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    message: String,
) -> Result<RealtimePipeExchange, String> {
    with_protocol_session(state, session_id, |session| {
        session.enqueue_spokesperson_message(&message)
    })
}

#[tauri::command]
pub fn send_openai_realtime_expert_pipe_message(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    cursor: u64,
    message: String,
) -> Result<RealtimePipeExchange, String> {
    with_protocol_session(state, session_id, |session| {
        session.send_expert_pipe_message(cursor, &message)
    })
}

#[tauri::command]
pub fn get_openai_realtime_expert_pipe_cursor(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
) -> Result<u64, String> {
    with_protocol_session(
        state,
        session_id,
        |session| Ok(session.expert_pipe_cursor()),
    )
}

#[tauri::command]
pub fn register_openai_realtime_handoff(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    handoff_id: String,
    cursor: u64,
    message: String,
) -> Result<String, String> {
    with_protocol_session(state, session_id, |session| {
        session.register_handoff(&handoff_id, cursor, &message)
    })
}

#[tauri::command]
pub fn unknown_openai_realtime_handoff_ids(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    handoff_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    with_protocol_session(state, session_id, |session| {
        Ok(session.unknown_handoff_ids(&handoff_ids))
    })
}

#[tauri::command]
pub fn mark_openai_realtime_handoffs_resolving(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    handoff_ids: Vec<String>,
) -> Result<(), String> {
    with_protocol_session(state, session_id, |session| {
        session.mark_handoffs_resolving(&handoff_ids)
    })
}

#[tauri::command]
pub fn dismiss_openai_realtime_handoffs(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    handoff_ids: Vec<String>,
) -> Result<(), String> {
    with_protocol_session(state, session_id, |session| {
        session.dismiss_handoffs(&handoff_ids)
    })
}

#[tauri::command]
pub fn complete_openai_realtime_expert_turn(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    retrying_handoff_ids: Vec<String>,
    max_attempts: u8,
) -> Result<RealtimeHandoffReminder, String> {
    with_protocol_session(state, session_id, |session| {
        Ok(session.complete_expert_turn(&retrying_handoff_ids, max_attempts))
    })
}

#[tauri::command]
pub fn reduce_openai_realtime_spokesperson_event(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    event: serde_json::Value,
) -> Result<RealtimeSessionReduction, String> {
    let session_id = non_empty_session_id(session_id)?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime protocol state is unavailable".to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "OpenAI Realtime protocol session is not active".to_string())?;
    session.handle_provider_event(&event)
}

#[tauri::command]
pub fn request_openai_realtime_expert_message(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    message: RealtimeExpertMessage,
) -> Result<RealtimeCoordinatorResult, String> {
    with_protocol_session(state, session_id, |session| {
        session.request_expert_message(message)
    })
}

#[tauri::command]
pub fn request_openai_realtime_tool_output(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    event: serde_json::Value,
    request_response: bool,
) -> Result<RealtimeCoordinatorResult, String> {
    with_protocol_session(state, session_id, |session| {
        Ok(session.request_tool_output(event, request_response))
    })
}

#[tauri::command]
pub fn request_openai_realtime_typed_user_message(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    text: String,
) -> Result<RealtimeCoordinatorResult, String> {
    with_protocol_session(state, session_id, |session| {
        session.request_typed_user_message(&text)
    })
}

#[tauri::command]
pub fn stop_openai_realtime_spokesperson_protocol(
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
) -> Result<(), String> {
    let session_id = non_empty_session_id(session_id)?;
    state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime protocol state is unavailable".to_string())?
        .remove(&session_id);
    Ok(())
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
    state: State<'_, OpenAiRealtimeProtocolState>,
    session_id: String,
    operation: impl FnOnce(&mut RealtimeExpertSpokespersonSession) -> Result<T, String>,
) -> Result<T, String> {
    let session_id = non_empty_session_id(session_id)?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "OpenAI Realtime protocol state is unavailable".to_string())?;
    operation(
        sessions
            .get_mut(&session_id)
            .ok_or_else(|| "OpenAI Realtime protocol session is not active".to_string())?,
    )
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
    use super::{parse_client_secret, realtime_transcription_client_secret_request};
    use serde_json::json;

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
