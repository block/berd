use serde::Serialize;
use serde_json::json;
use tauri::{State, WebviewWindow};

use super::openai_voice_credentials::{self, OpenAiVoiceCredential};
use super::voice_capture::VoiceCaptureState;

const DEFAULT_REALTIME_MODEL: &str = "gpt-realtime-2.1";
const OPENAI_REALTIME_CLIENT_SECRETS_URL: &str =
    "https://api.openai.com/v1/realtime/client_secrets";

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
pub async fn create_openai_realtime_voice_session(
    model: Option<String>,
) -> Result<OpenAiRealtimeSession, String> {
    let api_key = openai_voice_credentials::require(OpenAiVoiceCredential::Realtime)?;
    let model = model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_REALTIME_MODEL.to_string());
    let response = realtime_client_secret_request(&reqwest::Client::new(), &api_key, &model)
        .send()
        .await
        .map_err(|error| format!("Failed to create OpenAI Realtime voice session: {error}"))?;
    parse_session_response(response, "voice").await
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

fn realtime_client_secret_request(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
) -> reqwest::RequestBuilder {
    client
        .post(OPENAI_REALTIME_CLIENT_SECRETS_URL)
        .bearer_auth(api_key)
        .json(&json!({
            "session": {
                "type": "realtime",
                "model": model,
            }
        }))
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
        parse_client_secret, realtime_client_secret_request,
        realtime_transcription_client_secret_request,
    };
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
    fn client_secret_request_uses_only_the_standard_openai_endpoint() {
        let request = realtime_client_secret_request(
            &reqwest::Client::new(),
            "sk-test-secret",
            "gpt-realtime-test",
        )
        .build()
        .expect("build request");

        assert_eq!(
            request.url().as_str(),
            "https://api.openai.com/v1/realtime/client_secrets"
        );
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer sk-test-secret")
        );
        let body: serde_json::Value = serde_json::from_slice(
            request
                .body()
                .and_then(|body| body.as_bytes())
                .expect("JSON body"),
        )
        .expect("parse request body");
        assert_eq!(
            body,
            json!({
                "session": {
                    "type": "realtime",
                    "model": "gpt-realtime-test",
                }
            })
        );
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
