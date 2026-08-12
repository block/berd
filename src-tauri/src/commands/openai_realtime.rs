#[cfg(not(feature = "no-voice-dictation"))]
use crate::services::kgoose::KgooseContext;
use crate::{
    commands::runtime_config::RuntimeConfigState,
    services::{distro_bundle::DistroBundleState, kgoose},
};
use serde::Serialize;
#[cfg(not(feature = "no-voice-dictation"))]
use serde_json::json;
use tauri::{State, WebviewWindow};

use super::voice_capture::VoiceCaptureState;

#[cfg(not(feature = "no-voice-dictation"))]
const OPENAI_REALTIME_CLIENT_SECRETS_ENDPOINT: &str = "transcribe/v1/realtime-client-secret";
const DEFAULT_TRANSCRIPTION_MODEL: &str = "gpt-realtime-whisper";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiRealtimeStatus {
    configured: bool,
    transcription_model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiRealtimeSession {
    client_secret: String,
    transcription_model: String,
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn transcription_model() -> String {
    non_empty_env("OPENAI_REALTIME_TRANSCRIPTION_MODEL")
        .unwrap_or_else(|| DEFAULT_TRANSCRIPTION_MODEL.to_string())
}

fn openai_realtime_configured(
    runtime_config: &crate::commands::runtime_config::RuntimeConfig,
    distro_state: &DistroBundleState,
) -> bool {
    cfg!(not(feature = "no-voice-dictation"))
        && kgoose::is_configured(runtime_config.kgoose.as_ref(), distro_state.kgoose_config())
}

#[tauri::command]
pub async fn get_openai_realtime_status(
    distro_state: State<'_, DistroBundleState>,
    runtime_config_state: State<'_, RuntimeConfigState>,
) -> Result<OpenAiRealtimeStatus, String> {
    let runtime_config = runtime_config_state
        .ready_config(distro_state.inner())
        .await?;

    Ok(OpenAiRealtimeStatus {
        configured: openai_realtime_configured(&runtime_config, distro_state.inner()),
        transcription_model: transcription_model(),
    })
}

#[tauri::command]
pub async fn create_openai_realtime_session(
    _distro_state: State<'_, DistroBundleState>,
    _runtime_config_state: State<'_, RuntimeConfigState>,
) -> Result<OpenAiRealtimeSession, String> {
    #[cfg(feature = "no-voice-dictation")]
    {
        Err("OpenAI realtime sessions are unsupported because voice dictation is disabled in this build.".to_string())
    }

    #[cfg(not(feature = "no-voice-dictation"))]
    {
        let transcription_model = transcription_model();
        let runtime_config = _runtime_config_state
            .ready_config(_distro_state.inner())
            .await?;
        let kgoose = KgooseContext::new(_distro_state.inner(), &runtime_config);
        let value = kgoose
            .post_json(
                OPENAI_REALTIME_CLIENT_SECRETS_ENDPOINT,
                json!({ "language": "en" }),
            )
            .await
            .map_err(|error| format!("Failed to create OpenAI realtime session: {error}"))?;
        let client_secret = parse_client_secret(&value)?;

        Ok(OpenAiRealtimeSession {
            client_secret,
            transcription_model,
        })
    }
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

#[cfg(not(feature = "no-voice-dictation"))]
fn parse_client_secret(value: &serde_json::Value) -> Result<String, String> {
    let client_secret = value.get("client_secret").and_then(client_secret_value);
    let top_level_value = value.get("value").and_then(|value| value.as_str());
    let top_level_secret = value.get("secret").and_then(|value| value.as_str());

    client_secret
        .or(top_level_value)
        .or(top_level_secret)
        .map(ToString::to_string)
        .ok_or_else(|| {
            format!(
                "OpenAI realtime client secret response did not include a recognized secret field: {value}"
            )
        })
}

#[cfg(not(feature = "no-voice-dictation"))]
fn client_secret_value(value: &serde_json::Value) -> Option<&str> {
    value
        .get("value")
        .and_then(|value| value.as_str())
        .or_else(|| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::openai_realtime_configured;
    #[cfg(not(feature = "no-voice-dictation"))]
    use super::parse_client_secret;
    use crate::{
        commands::runtime_config::{default_runtime_config, RuntimeConfig, RuntimeKgooseConfig},
        services::distro_bundle::{DistroBundleState, KgooseDistroConfig},
        test_support::env_lock,
    };
    #[cfg(not(feature = "no-voice-dictation"))]
    use serde_json::json;
    use std::env;

    #[test]
    fn status_is_unconfigured_without_explicit_kgoose_endpoint() {
        let _guard = env_lock().lock().expect("env lock");
        env::remove_var("KGOOSE_BASE_URL");
        let runtime_config = default_runtime_config();

        assert!(!openai_realtime_configured(
            &runtime_config,
            &DistroBundleState::empty_for_tests(),
        ));
    }

    #[test]
    fn status_tracks_explicit_runtime_endpoint() {
        let _guard = env_lock().lock().expect("env lock");
        env::remove_var("KGOOSE_BASE_URL");
        let mut runtime_config = default_runtime_config();
        runtime_config.kgoose = Some(RuntimeKgooseConfig {
            base_url: Some("https://kgoose.example.test/".to_string()),
            path: None,
        });

        assert_eq!(
            openai_realtime_configured(&runtime_config, &DistroBundleState::empty_for_tests(),),
            cfg!(not(feature = "no-voice-dictation")),
        );
    }

    #[test]
    fn status_tracks_explicit_distro_endpoint() {
        let _guard = env_lock().lock().expect("env lock");
        env::remove_var("KGOOSE_BASE_URL");
        let runtime_config: RuntimeConfig = default_runtime_config();
        let distro_state = DistroBundleState::with_kgoose_for_tests(KgooseDistroConfig {
            base_url: Some("https://kgoose.example.test/".to_string()),
            path: None,
        });

        assert_eq!(
            openai_realtime_configured(&runtime_config, &distro_state),
            cfg!(not(feature = "no-voice-dictation")),
        );
    }

    #[test]
    fn status_tracks_explicit_environment_endpoint() {
        let _guard = env_lock().lock().expect("env lock");
        env::set_var("KGOOSE_BASE_URL", "https://kgoose.example.test/");
        let runtime_config = default_runtime_config();

        assert_eq!(
            openai_realtime_configured(&runtime_config, &DistroBundleState::empty_for_tests(),),
            cfg!(not(feature = "no-voice-dictation")),
        );
        env::remove_var("KGOOSE_BASE_URL");
    }

    #[cfg(not(feature = "no-voice-dictation"))]
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

    #[cfg(not(feature = "no-voice-dictation"))]
    #[test]
    fn rejects_missing_client_secret() {
        assert!(parse_client_secret(&json!({ "ok": true })).is_err());
    }
}
