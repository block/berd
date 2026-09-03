use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};

/// Explicit connection settings for OpenAI Realtime transcription.
///
/// This type deliberately does not implement `Debug` because it contains an
/// API key.
pub struct OpenAiRealtimeTranscriptionConfig {
    endpoint: String,
    api_key: String,
    model: String,
}

impl OpenAiRealtimeTranscriptionConfig {
    pub fn new(endpoint: String, api_key: String, model: String) -> Self {
        Self {
            endpoint,
            api_key,
            model,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenAiRealtimeTranscriptionEvent {
    Committed { item_id: String },
    Completed { item_id: String, transcript: String },
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenAiRealtimeTranscriptionError {
    TranscriptionFailed { item_id: String, message: String },
    Provider(String),
    Disconnected,
    Socket(String),
}

impl std::fmt::Display for OpenAiRealtimeTranscriptionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TranscriptionFailed { message, .. } | Self::Provider(message) => {
                formatter.write_str(message)
            }
            Self::Disconnected => {
                formatter.write_str("OpenAI realtime transcription disconnected.")
            }
            Self::Socket(message) => {
                write!(formatter, "OpenAI realtime transcription failed: {message}")
            }
        }
    }
}

impl std::error::Error for OpenAiRealtimeTranscriptionError {}

/// A connected OpenAI Realtime transcription websocket.
pub struct OpenAiRealtimeTranscriptionClient {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    model: String,
}

impl OpenAiRealtimeTranscriptionClient {
    /// Connects and authenticates without configuring the transcription session.
    pub async fn connect(config: OpenAiRealtimeTranscriptionConfig) -> Result<Self, String> {
        if let Err(existing) = rustls::crypto::aws_lc_rs::default_provider().install_default() {
            // Another dependency may have installed the same process-wide provider first.
            drop(existing);
        }
        let mut request = config
            .endpoint
            .into_client_request()
            .map_err(|error| format!("prepare OpenAI realtime connection: {error}"))?;
        let authorization = format!("Bearer {}", config.api_key)
            .parse()
            .map_err(|_| "OpenAI API key is not a valid header value".to_string())?;
        request.headers_mut().insert("Authorization", authorization);
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Self {
            socket,
            model: config.model,
        })
    }

    /// Configures 24 kHz PCM transcription with provider turn detection disabled.
    pub async fn configure(&mut self) -> Result<(), String> {
        self.send(serde_json::json!({
            "type": "session.update",
            "session": {
                "type": "transcription",
                "audio": { "input": {
                    "format": { "type": "audio/pcm", "rate": 24000 },
                    "transcription": { "model": self.model, "delay": "low" },
                    "turn_detection": null
                }}
            }
        }))
        .await?;

        loop {
            let value = self.next_json().await.map_err(|error| error.to_string())?;
            match value.get("type").and_then(|value| value.as_str()) {
                Some("session.updated") => return Ok(()),
                Some("error") => {
                    return Err(provider_message(&value).to_string());
                }
                _ => {}
            }
        }
    }

    pub async fn append_pcm16le_24khz(&mut self, pcm: &[u8]) -> Result<(), String> {
        self.send(serde_json::json!({
            "type": "input_audio_buffer.append",
            "audio": BASE64.encode(pcm),
        }))
        .await
    }

    pub async fn clear(&mut self) -> Result<(), String> {
        self.send(serde_json::json!({"type": "input_audio_buffer.clear"}))
            .await
    }

    pub async fn commit(&mut self) -> Result<(), String> {
        self.send(serde_json::json!({"type": "input_audio_buffer.commit"}))
            .await
    }

    /// Returns the next recognized provider event, ignoring unrelated or
    /// malformed messages while preserving terminal provider/socket failures.
    pub async fn next_event(
        &mut self,
    ) -> Result<OpenAiRealtimeTranscriptionEvent, OpenAiRealtimeTranscriptionError> {
        loop {
            let value = self.next_json().await?;
            match value.get("type").and_then(|value| value.as_str()) {
                Some("input_audio_buffer.committed") => {
                    if let Some(item_id) = value.get("item_id").and_then(|value| value.as_str()) {
                        return Ok(OpenAiRealtimeTranscriptionEvent::Committed {
                            item_id: item_id.to_string(),
                        });
                    }
                }
                Some("conversation.item.input_audio_transcription.completed") => {
                    if let (Some(item_id), Some(transcript)) = (
                        value.get("item_id").and_then(|value| value.as_str()),
                        value.get("transcript").and_then(|value| value.as_str()),
                    ) {
                        return Ok(OpenAiRealtimeTranscriptionEvent::Completed {
                            item_id: item_id.to_string(),
                            transcript: transcript.trim().to_string(),
                        });
                    }
                }
                Some("conversation.item.input_audio_transcription.failed") => {
                    if let Some(item_id) = value.get("item_id").and_then(|value| value.as_str()) {
                        return Err(OpenAiRealtimeTranscriptionError::TranscriptionFailed {
                            item_id: item_id.to_string(),
                            message: provider_message(&value).to_string(),
                        });
                    }
                }
                Some("error") => {
                    return Err(OpenAiRealtimeTranscriptionError::Provider(
                        provider_message(&value).to_string(),
                    ));
                }
                _ => {}
            }
        }
    }

    async fn next_json(&mut self) -> RealtimeJsonResult {
        loop {
            let message = match self.socket.next().await {
                Some(Ok(Message::Text(text))) => text,
                Some(Ok(Message::Close(_))) | None => {
                    return Err(OpenAiRealtimeTranscriptionError::Disconnected);
                }
                Some(Ok(_)) => continue,
                Some(Err(error)) => {
                    return Err(OpenAiRealtimeTranscriptionError::Socket(error.to_string()));
                }
            };
            if let Ok(value) = serde_json::from_str(&message) {
                return Ok(value);
            }
        }
    }

    async fn send(&mut self, value: serde_json::Value) -> Result<(), String> {
        self.socket
            .send(Message::Text(value.to_string().into()))
            .await
            .map_err(|error| error.to_string())
    }
}

type RealtimeJson = serde_json::Value;
type RealtimeJsonResult = Result<RealtimeJson, OpenAiRealtimeTranscriptionError>;

fn provider_message(value: &serde_json::Value) -> &str {
    value
        .pointer("/error/message")
        .and_then(|value| value.as_str())
        .unwrap_or("OpenAI realtime transcription failed.")
}

#[cfg(test)]
mod tests {
    use super::{
        OpenAiRealtimeTranscriptionClient, OpenAiRealtimeTranscriptionConfig,
        OpenAiRealtimeTranscriptionError, OpenAiRealtimeTranscriptionEvent,
    };
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::{
            handshake::server::{ErrorResponse, Request, Response},
            Message,
        },
        WebSocketStream,
    };

    #[allow(clippy::result_large_err)] // Signature is fixed by tungstenite's handshake callback.
    fn require_test_authorization(
        request: &Request,
        response: Response,
    ) -> Result<Response, ErrorResponse> {
        assert_eq!(
            request
                .headers()
                .get("Authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer test-key")
        );
        Ok(response)
    }

    async fn receive_json(socket: &mut WebSocketStream<tokio::net::TcpStream>) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected JSON text")
        };
        serde_json::from_str(&text).unwrap()
    }

    async fn fake_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, require_test_authorization)
                .await
                .unwrap();

            let configured = receive_json(&mut socket).await;
            assert_eq!(configured["type"], "session.update");
            assert_eq!(
                configured.pointer("/session/audio/input/transcription/model"),
                Some(&json!("test-model"))
            );
            assert_eq!(
                configured.pointer("/session/audio/input/format/rate"),
                Some(&json!(24_000))
            );
            assert_eq!(
                configured.pointer("/session/audio/input/turn_detection"),
                Some(&Value::Null)
            );
            socket
                .send(Message::Text(
                    json!({"type":"session.updated"}).to_string().into(),
                ))
                .await
                .unwrap();

            let appended = receive_json(&mut socket).await;
            assert_eq!(
                appended,
                json!({"type":"input_audio_buffer.append","audio":"AQID"})
            );
            assert_eq!(
                receive_json(&mut socket).await,
                json!({"type":"input_audio_buffer.clear"})
            );
            assert_eq!(
                receive_json(&mut socket).await,
                json!({"type":"input_audio_buffer.commit"})
            );

            socket.send(Message::Text("not json".into())).await.unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"input_audio_buffer.committed","item_id":"item-1"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    json!({
                        "type":"conversation.item.input_audio_transcription.completed",
                        "item_id":"item-1",
                        "transcript":" hello "
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    json!({
                        "type":"conversation.item.input_audio_transcription.failed",
                        "item_id":"item-1",
                        "error":{"message":"turn failed"}
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
        });
        (endpoint, server)
    }

    #[tokio::test]
    async fn client_owns_auth_configuration_framing_and_provider_events() {
        let (endpoint, server) = fake_server().await;
        let config = OpenAiRealtimeTranscriptionConfig::new(
            endpoint,
            "test-key".into(),
            "test-model".into(),
        );
        let mut client = OpenAiRealtimeTranscriptionClient::connect(config)
            .await
            .unwrap();
        client.configure().await.unwrap();
        client.append_pcm16le_24khz(&[1, 2, 3]).await.unwrap();
        client.clear().await.unwrap();
        client.commit().await.unwrap();
        assert_eq!(
            client.next_event().await.unwrap(),
            OpenAiRealtimeTranscriptionEvent::Committed {
                item_id: "item-1".into()
            }
        );
        assert_eq!(
            client.next_event().await.unwrap(),
            OpenAiRealtimeTranscriptionEvent::Completed {
                item_id: "item-1".into(),
                transcript: "hello".into()
            }
        );
        assert_eq!(
            client.next_event().await.unwrap_err(),
            OpenAiRealtimeTranscriptionError::TranscriptionFailed {
                item_id: "item-1".into(),
                message: "turn failed".into(),
            }
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn configure_waits_for_provider_acknowledgement() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let (acknowledge, acknowledged) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            assert_eq!(receive_json(&mut socket).await["type"], "session.update");
            acknowledged.await.unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"session.updated"}).to_string().into(),
                ))
                .await
                .unwrap();
        });
        let config = OpenAiRealtimeTranscriptionConfig::new(
            endpoint,
            "test-key".into(),
            "test-model".into(),
        );
        let mut client = OpenAiRealtimeTranscriptionClient::connect(config)
            .await
            .unwrap();
        let configuring = client.configure();
        tokio::pin!(configuring);
        let deadline = std::time::Duration::from_millis(20);
        let early = tokio::time::timeout(deadline, &mut configuring).await;
        assert!(early.is_err());
        acknowledge.send(()).unwrap();
        configuring.await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn close_is_a_terminal_disconnect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket.close(None).await.unwrap();
        });
        let config = OpenAiRealtimeTranscriptionConfig::new(
            endpoint,
            "test-key".into(),
            "test-model".into(),
        );
        let mut client = OpenAiRealtimeTranscriptionClient::connect(config)
            .await
            .unwrap();
        assert_eq!(
            client.next_event().await.unwrap_err(),
            OpenAiRealtimeTranscriptionError::Disconnected
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn eof_is_a_terminal_socket_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            drop(socket);
        });
        let config = OpenAiRealtimeTranscriptionConfig::new(
            endpoint,
            "test-key".into(),
            "test-model".into(),
        );
        let mut client = OpenAiRealtimeTranscriptionClient::connect(config)
            .await
            .unwrap();
        let error = client.next_event().await.unwrap_err();
        assert!(matches!(error, OpenAiRealtimeTranscriptionError::Socket(_)));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn invalid_api_key_error_does_not_echo_the_secret() {
        let config = OpenAiRealtimeTranscriptionConfig::new(
            "ws://127.0.0.1:1".into(),
            "secret\nvalue".into(),
            "test-model".into(),
        );
        let error = OpenAiRealtimeTranscriptionClient::connect(config)
            .await
            .err()
            .expect("invalid header must fail before connecting");
        assert_eq!(error, "OpenAI API key is not a valid header value");
        assert!(!error.contains("secret"));
    }
}
