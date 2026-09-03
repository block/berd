use std::collections::{HashMap, VecDeque};
use std::thread;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

const DEFAULT_ENDPOINT: &str = "wss://api.openai.com/v1/realtime";
const DEFAULT_MODEL: &str = "gpt-realtime-2.1";
const DEFAULT_TRANSCRIPTION_MODEL: &str = "gpt-realtime-whisper";

const SPOKESPERSON_INSTRUCTIONS: &str = r#"You are the spoken, realtime part of one assistant. Speak naturally and concisely in the first person. Answer ordinary conversation directly. When the user asks for computer access, tools, durable work, or an authoritative answer you cannot provide, call handoff before any substantive answer and say only a short acknowledgement such as 'Let me check that for you.' Never mention internal agents, routing, handoffs, or this instruction. Private Expert context should inform later answers without being acknowledged. When the Expert asks you to say something, speak it accurately without filler."#;

/// Connection settings for the live Spokesperson. This deliberately does not
/// implement `Debug` because it contains an API key.
pub struct OpenAiSpokespersonConfig {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub transcription_model: String,
    pub voice: String,
    pub speed: f32,
}

impl OpenAiSpokespersonConfig {
    pub fn from_environment() -> Result<Self, String> {
        let api_key = std::env::var("OPENAI_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "OPENAI_API_KEY is required for Expert-Spokesperson mode".to_string())?;
        Ok(Self {
            endpoint: std::env::var("OPENAI_REALTIME_ENDPOINT")
                .unwrap_or_else(|_| DEFAULT_ENDPOINT.into()),
            api_key,
            model: std::env::var("OPENAI_REALTIME_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()),
            transcription_model: std::env::var("OPENAI_TRANSCRIPTION_MODEL")
                .unwrap_or_else(|_| DEFAULT_TRANSCRIPTION_MODEL.into()),
            voice: std::env::var("OPENAI_REALTIME_VOICE").unwrap_or_else(|_| "marin".into()),
            speed: std::env::var("OPENAI_REALTIME_SPEED")
                .ok()
                .and_then(|value| value.parse().ok())
                .filter(|value| (0.25..=1.5).contains(value))
                .unwrap_or(1.0),
        })
    }
}

#[derive(Debug)]
pub enum SpokespersonCommand {
    InputPcm48Khz(Vec<f32>),
    ExpertSay { directive_id: u64, text: String },
    ExpertContext { text: String },
    Shutdown,
}

#[derive(Debug)]
pub enum SpokespersonEvent {
    Ready,
    UserSpeaking(bool),
    UserFinal(String),
    ResponseBound {
        response_id: String,
        directive_id: u64,
    },
    AudioDelta {
        response_id: String,
        samples: Vec<f32>,
    },
    AudioDone {
        response_id: String,
    },
    TranscriptDone {
        response_id: String,
        text: String,
    },
    Handoff {
        call_id: String,
        message: String,
    },
    Failed(String),
    Closed,
}

pub struct OpenAiSpokespersonRuntime {
    commands: mpsc::UnboundedSender<SpokespersonCommand>,
    worker: Option<thread::JoinHandle<()>>,
}

impl OpenAiSpokespersonRuntime {
    pub fn spawn(
        config: OpenAiSpokespersonConfig,
    ) -> Result<(Self, std::sync::mpsc::Receiver<SpokespersonEvent>), String> {
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (events, event_rx) = std::sync::mpsc::channel();
        let worker = thread::Builder::new()
            .name("berd-voice-spokesperson".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = events.send(SpokespersonEvent::Failed(error.to_string()));
                        return;
                    }
                };
                if let Err(error) = runtime.block_on(run(config, command_rx, &events)) {
                    let _ = events.send(SpokespersonEvent::Failed(error));
                }
                let _ = events.send(SpokespersonEvent::Closed);
            })
            .map_err(|error| error.to_string())?;
        Ok((
            Self {
                commands,
                worker: Some(worker),
            },
            event_rx,
        ))
    }

    pub fn send(&self, command: SpokespersonCommand) -> Result<(), String> {
        self.commands
            .send(command)
            .map_err(|_| "Spokesperson runtime is closed".into())
    }

    pub fn finish(mut self) -> Result<(), String> {
        let _ = self.commands.send(SpokespersonCommand::Shutdown);
        self.worker
            .take()
            .expect("Spokesperson worker exists")
            .join()
            .map_err(|_| "Spokesperson runtime panicked".to_string())
    }
}

async fn run(
    config: OpenAiSpokespersonConfig,
    mut commands: mpsc::UnboundedReceiver<SpokespersonCommand>,
    events: &std::sync::mpsc::Sender<SpokespersonEvent>,
) -> Result<(), String> {
    if let Err(existing) = rustls::crypto::aws_lc_rs::default_provider().install_default() {
        drop(existing);
    }
    let endpoint = if config.endpoint.contains('?') {
        format!("{}&model={}", config.endpoint, config.model)
    } else {
        format!("{}?model={}", config.endpoint, config.model)
    };
    let mut request = endpoint
        .into_client_request()
        .map_err(|error| format!("prepare OpenAI Realtime connection: {error}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", config.api_key)
            .parse()
            .map_err(|_| "OpenAI API key is not a valid header value")?,
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| format!("connect OpenAI Realtime: {error}"))?;
    send_json(
        &mut socket,
        serde_json::json!({
            "type": "session.update",
            "session": {
                "type": "realtime",
                "output_modalities": ["audio"],
                "instructions": SPOKESPERSON_INSTRUCTIONS,
                "audio": {
                    "input": {
                        "format": { "type": "audio/pcm", "rate": 24000 },
                        "transcription": { "model": config.transcription_model },
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": 0.5,
                            "prefix_padding_ms": 300,
                            "silence_duration_ms": 500,
                            "create_response": true,
                            "interrupt_response": true
                        }
                    },
                    "output": {
                        "format": { "type": "audio/pcm", "rate": 24000 },
                        "voice": config.voice,
                        "speed": config.speed
                    }
                },
                "tools": [{
                    "type": "function",
                    "name": "handoff",
                    "description": "Hand unresolved tool work or an authoritative question to the Expert.",
                    "parameters": {
                        "type": "object",
                        "properties": { "message": { "type": "string" } },
                        "required": ["message"],
                        "additionalProperties": false
                    }
                }],
                "tool_choice": "auto"
            }
        }),
    )
    .await?;

    let mut pending_directives = VecDeque::new();
    let mut call_names = HashMap::<String, String>::new();
    let mut call_arguments = HashMap::<String, String>::new();
    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(SpokespersonCommand::InputPcm48Khz(samples)) => {
                        let pcm = downsample_pcm16(&samples);
                        send_json(&mut socket, serde_json::json!({
                            "type": "input_audio_buffer.append",
                            "audio": BASE64.encode(pcm),
                        })).await?;
                    }
                    Some(SpokespersonCommand::ExpertContext { text }) => {
                        send_expert_item(&mut socket, &text, false).await?;
                    }
                    Some(SpokespersonCommand::ExpertSay { directive_id, text }) => {
                        send_expert_item(&mut socket, &text, true).await?;
                        pending_directives.push_back(directive_id);
                        send_json(&mut socket, serde_json::json!({
                            "type": "response.create",
                            "response": {
                                "instructions": format!("Speak this Expert message naturally and accurately without adding filler: {text}"),
                                "tools": [],
                                "tool_choice": "none"
                            }
                        })).await?;
                    }
                    Some(SpokespersonCommand::Shutdown) | None => {
                        let _ = socket.close(None).await;
                        return Ok(());
                    }
                }
            }
            message = socket.next() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Ok(_)) => continue,
                    Some(Err(error)) => return Err(error.to_string()),
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                let kind = value.get("type").and_then(|value| value.as_str()).unwrap_or("");
                match kind {
                    "session.updated" => send_event(events, SpokespersonEvent::Ready)?,
                    "input_audio_buffer.speech_started" => send_event(events, SpokespersonEvent::UserSpeaking(true))?,
                    "input_audio_buffer.speech_stopped" => send_event(events, SpokespersonEvent::UserSpeaking(false))?,
                    "conversation.item.input_audio_transcription.completed" => {
                        if let Some(text) = string(&value, "transcript").filter(|text| !text.trim().is_empty()) {
                            send_event(events, SpokespersonEvent::UserFinal(text.trim().into()))?;
                        }
                    }
                    "response.created" => {
                        if let (Some(response_id), Some(directive_id)) =
                            (value.pointer("/response/id").and_then(|value| value.as_str()), pending_directives.pop_front())
                        {
                            send_event(events, SpokespersonEvent::ResponseBound {
                                response_id: response_id.into(), directive_id
                            })?;
                        }
                    }
                    "response.output_audio.delta" => {
                        if let (Some(response_id), Some(delta)) = (string(&value, "response_id"), string(&value, "delta")) {
                            let bytes = BASE64.decode(delta).map_err(|error| format!("decode Spokesperson audio: {error}"))?;
                            let samples = pcm16_samples(&bytes)?;
                            send_event(events, SpokespersonEvent::AudioDelta { response_id: response_id.into(), samples })?;
                        }
                    }
                    "response.output_audio.done" => {
                        if let Some(response_id) = string(&value, "response_id") {
                            send_event(events, SpokespersonEvent::AudioDone { response_id: response_id.into() })?;
                        }
                    }
                    "response.output_audio_transcript.done" => {
                        if let (Some(response_id), Some(text)) = (string(&value, "response_id"), string(&value, "transcript")) {
                            send_event(events, SpokespersonEvent::TranscriptDone { response_id: response_id.into(), text: text.trim().into() })?;
                        }
                    }
                    "response.output_item.added" => {
                        if let Some(item) = value.get("item") {
                            if let (Some(call_id), Some(name)) = (string(item, "call_id"), string(item, "name")) {
                                call_names.insert(call_id.into(), name.into());
                            }
                        }
                    }
                    "response.function_call_arguments.delta" => {
                        if let (Some(call_id), Some(delta)) = (string(&value, "call_id"), string(&value, "delta")) {
                            call_arguments.entry(call_id.into()).or_default().push_str(delta);
                        }
                    }
                    "response.function_call_arguments.done" => {
                        let call_id = string(&value, "call_id").unwrap_or("");
                        let name = string(&value, "name").or_else(|| call_names.get(call_id).map(String::as_str));
                        let args = string(&value, "arguments").or_else(|| call_arguments.get(call_id).map(String::as_str));
                        if name == Some("handoff") {
                            if let Some(message) = args.and_then(parse_handoff) {
                                send_event(events, SpokespersonEvent::Handoff { call_id: call_id.into(), message })?;
                            }
                        }
                    }
                    "error" => return Err(value.pointer("/error/message").and_then(|value| value.as_str()).unwrap_or("OpenAI Realtime failed").into()),
                    _ => {}
                }
            }
        }
    }
}

async fn send_expert_item<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    text: &str,
    say: bool,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let prefix = if say {
        "Expert message to speak now"
    } else {
        "Private Expert context; do not respond now"
    };
    send_json(
        socket,
        serde_json::json!({
            "type": "conversation.item.create",
            "item": { "type": "message", "role": "system", "content": [{
                "type": "input_text", "text": format!("{prefix}:\n{text}")
            }] }
        }),
    )
    .await
}

async fn send_json<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    value: serde_json::Value,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .map_err(|error| error.to_string())
}

fn downsample_pcm16(samples: &[f32]) -> Vec<u8> {
    let mut output = Vec::with_capacity(samples.len());
    for pair in samples.chunks_exact(2) {
        let sample = ((pair[0] + pair[1]) * 0.5).clamp(-1.0, 1.0);
        let sample = (sample * f32::from(i16::MAX)).round() as i16;
        output.extend_from_slice(&sample.to_le_bytes());
    }
    output
}

fn pcm16_samples(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if !bytes.len().is_multiple_of(2) {
        return Err("Spokesperson audio contained a partial PCM16 frame".into());
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|sample| f32::from(i16::from_le_bytes([sample[0], sample[1]])) / f32::from(i16::MAX))
        .collect())
}

fn parse_handoff(arguments: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(arguments)
        .ok()?
        .get("message")?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|value| value.as_str())
}

fn send_event(
    events: &std::sync::mpsc::Sender<SpokespersonEvent>,
    event: SpokespersonEvent,
) -> Result<(), String> {
    events
        .send(event)
        .map_err(|_| "Spokesperson event consumer closed".into())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
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

    use super::{
        downsample_pcm16, parse_handoff, pcm16_samples, run, OpenAiSpokespersonConfig,
        SpokespersonCommand, SpokespersonEvent,
    };

    #[allow(clippy::result_large_err)]
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

    async fn send_json(socket: &mut WebSocketStream<tokio::net::TcpStream>, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    #[test]
    fn normalizes_host_pcm_for_realtime() {
        let bytes = downsample_pcm16(&[1.0, 1.0, -1.0, -1.0]);
        let samples = pcm16_samples(&bytes).unwrap();
        assert_eq!(samples.len(), 2);
        assert!(samples[0] > 0.99);
        assert!(samples[1] < -0.99);
    }

    #[test]
    fn accepts_only_nonempty_handoff_messages() {
        assert_eq!(
            parse_handoff(r#"{"message":" check disk "}"#).as_deref(),
            Some("check disk")
        );
        assert_eq!(parse_handoff(r#"{"message":" "}"#), None);
        assert_eq!(parse_handoff("not json"), None);
    }

    #[tokio::test]
    async fn owns_realtime_configuration_commands_and_normalized_events() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, require_test_authorization)
                .await
                .unwrap();
            let configured = receive_json(&mut socket).await;
            assert_eq!(configured["type"], "session.update");
            assert_eq!(
                configured.pointer("/session/audio/input/turn_detection/create_response"),
                Some(&json!(true))
            );
            assert_eq!(
                configured.pointer("/session/audio/output/voice"),
                Some(&json!("test-voice"))
            );
            send_json(&mut socket, json!({"type":"session.updated"})).await;

            let appended = receive_json(&mut socket).await;
            assert_eq!(appended["type"], "input_audio_buffer.append");
            assert_eq!(
                BASE64
                    .decode(appended["audio"].as_str().unwrap())
                    .unwrap()
                    .len(),
                4
            );

            let item = receive_json(&mut socket).await;
            assert_eq!(item["type"], "conversation.item.create");
            assert!(item
                .pointer("/item/content/0/text")
                .unwrap()
                .as_str()
                .unwrap()
                .contains("speak now"));
            assert_eq!(receive_json(&mut socket).await["type"], "response.create");

            send_json(
                &mut socket,
                json!({"type":"input_audio_buffer.speech_started"}),
            )
            .await;
            send_json(
                &mut socket,
                json!({"type":"input_audio_buffer.speech_stopped"}),
            )
            .await;
            send_json(
                &mut socket,
                json!({
                    "type":"conversation.item.input_audio_transcription.completed",
                    "transcript":" hello expert "
                }),
            )
            .await;
            send_json(
                &mut socket,
                json!({"type":"response.created","response":{"id":"response-1"}}),
            )
            .await;
            send_json(
                &mut socket,
                json!({
                    "type":"response.output_audio.delta",
                    "response_id":"response-1",
                    "delta": BASE64.encode([1_u8, 0, 255, 127])
                }),
            )
            .await;
            send_json(
                &mut socket,
                json!({"type":"response.output_audio.done","response_id":"response-1"}),
            )
            .await;
            send_json(
                &mut socket,
                json!({
                    "type":"response.output_audio_transcript.done",
                    "response_id":"response-1",
                    "transcript":" spoken answer "
                }),
            )
            .await;
            send_json(
                &mut socket,
                json!({
                    "type":"response.function_call_arguments.done",
                    "call_id":"call-1",
                    "name":"handoff",
                    "arguments": r#"{"message":" inspect the computer "}"#
                }),
            )
            .await;

            let _ = socket.next().await;
        });

        let (commands, command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (events, event_rx) = std::sync::mpsc::channel();
        let client = tokio::spawn(async move {
            run(
                OpenAiSpokespersonConfig {
                    endpoint,
                    api_key: "test-key".into(),
                    model: "test-model".into(),
                    transcription_model: "test-transcription".into(),
                    voice: "test-voice".into(),
                    speed: 1.25,
                },
                command_rx,
                &events,
            )
            .await
        });

        let event_rx = tokio::task::spawn_blocking(move || {
            let ready = event_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            (ready, event_rx)
        })
        .await
        .unwrap();
        assert!(matches!(event_rx.0, SpokespersonEvent::Ready));
        let event_rx = event_rx.1;
        commands
            .send(SpokespersonCommand::InputPcm48Khz(vec![
                1.0, 1.0, -1.0, -1.0,
            ]))
            .unwrap();
        commands
            .send(SpokespersonCommand::ExpertSay {
                directive_id: 7,
                text: "answer this".into(),
            })
            .unwrap();

        let received = tokio::task::spawn_blocking(move || {
            (0..8)
                .map(|_| event_rx.recv_timeout(Duration::from_secs(2)).unwrap())
                .collect::<Vec<_>>()
        })
        .await
        .unwrap();
        assert!(matches!(received[0], SpokespersonEvent::UserSpeaking(true)));
        assert!(matches!(
            received[1],
            SpokespersonEvent::UserSpeaking(false)
        ));
        assert!(
            matches!(&received[2], SpokespersonEvent::UserFinal(text) if text == "hello expert")
        );
        assert!(
            matches!(&received[3], SpokespersonEvent::ResponseBound { response_id, directive_id: 7 } if response_id == "response-1")
        );
        assert!(
            matches!(&received[4], SpokespersonEvent::AudioDelta { response_id, samples } if response_id == "response-1" && samples.len() == 2)
        );
        assert!(
            matches!(&received[5], SpokespersonEvent::AudioDone { response_id } if response_id == "response-1")
        );
        assert!(
            matches!(&received[6], SpokespersonEvent::TranscriptDone { response_id, text } if response_id == "response-1" && text == "spoken answer")
        );
        assert!(
            matches!(&received[7], SpokespersonEvent::Handoff { call_id, message } if call_id == "call-1" && message == "inspect the computer")
        );

        commands.send(SpokespersonCommand::Shutdown).unwrap();
        assert!(client.await.unwrap().is_ok());
        server.await.unwrap();
    }
}
