use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::Serialize;

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

    let response = reqwest::Client::new()
        .post(OPENAI_REALTIME_CLIENT_SECRETS_URL)
        .header(CONTENT_TYPE, "application/json;charset=utf-8")
        .header(ACCEPT, "application/json;charset=utf-8")
        .body(r#"{"language":"en"}"#)
        .send()
        .await
        .map_err(|error| format!("Failed to create OpenAI realtime session: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read OpenAI realtime session response: {error}"))?;

    if !status.is_success() {
        return Err(format!(
            "OpenAI realtime session request failed with {status}: {body}"
        ));
    }

    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|error| format!("Failed to parse OpenAI realtime session response: {error}"))?;
    let client_secret = value
        .get("client_secret")
        .and_then(|secret| {
            secret
                .get("value")
                .and_then(|value| value.as_str())
                .or_else(|| secret.as_str())
        })
        .or_else(|| value.get("value").and_then(|value| value.as_str()))
        .or_else(|| value.get("secret").and_then(|value| value.as_str()))
        .ok_or_else(|| {
            format!(
                "OpenAI realtime client secret response did not include a recognized secret field: {body}"
            )
        })?
        .to_string();

    Ok(OpenAiRealtimeSession {
        client_secret,
        transcription_model,
    })
}
