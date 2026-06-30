#[cfg(not(feature = "no-voice-dictation"))]
use crate::services::kgoose;
use serde::Serialize;
#[cfg(not(feature = "no-voice-dictation"))]
use serde_json::json;

#[cfg(not(feature = "no-voice-dictation"))]
const OPENAI_REALTIME_CLIENT_SECRETS_URL: &str =
    "https://kgoose.sqprod.co/cash-app/goose/transcribe/v1/realtime-client-secret";
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

#[tauri::command]
pub async fn get_openai_realtime_status() -> Result<OpenAiRealtimeStatus, String> {
    // Defense in depth: a restricted build compiled with the
    // `no-voice-dictation` feature reports "not configured" so the renderer
    // never requests a realtime client secret. The frontend `voiceDictation`
    // capability is the primary gate.
    Ok(OpenAiRealtimeStatus {
        configured: cfg!(not(feature = "no-voice-dictation")),
        transcription_model: transcription_model(),
    })
}

#[tauri::command]
pub async fn create_openai_realtime_session() -> Result<OpenAiRealtimeSession, String> {
    #[cfg(feature = "no-voice-dictation")]
    {
        Err("OpenAI realtime sessions are unsupported because voice dictation is disabled in this build.".to_string())
    }

    #[cfg(not(feature = "no-voice-dictation"))]
    {
        let transcription_model = transcription_model();

        let value = kgoose::post_json_external_url(
            OPENAI_REALTIME_CLIENT_SECRETS_URL,
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
    #[cfg(feature = "no-voice-dictation")]
    use super::create_openai_realtime_session;
    use super::get_openai_realtime_status;
    #[cfg(not(feature = "no-voice-dictation"))]
    use super::parse_client_secret;
    #[cfg(not(feature = "no-voice-dictation"))]
    use serde_json::json;

    #[tokio::test]
    async fn status_configured_tracks_voice_dictation_feature() {
        let status = get_openai_realtime_status().await.unwrap();
        // Configured unless the additive `no-voice-dictation` disable feature is
        // compiled in.
        assert_eq!(status.configured, cfg!(not(feature = "no-voice-dictation")));
    }

    #[cfg(feature = "no-voice-dictation")]
    #[tokio::test]
    async fn create_session_is_unsupported_when_voice_dictation_is_disabled() {
        let result = create_openai_realtime_session().await;

        assert!(matches!(result, Err(error) if error.contains("unsupported")));
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
