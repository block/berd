use crate::services::kgoose;
use serde::Serialize;
use serde_json::json;

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
    Ok(OpenAiRealtimeStatus {
        configured: true,
        transcription_model: transcription_model(),
    })
}

#[tauri::command]
pub async fn create_openai_realtime_session() -> Result<OpenAiRealtimeSession, String> {
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

fn client_secret_value(value: &serde_json::Value) -> Option<&str> {
    value
        .get("value")
        .and_then(|value| value.as_str())
        .or_else(|| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::parse_client_secret;
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
}
