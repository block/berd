use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{estimated_spoken_through_utf8, DeliveryProgress, DeliverySegment};

const PROMPT_DOCUMENT: &str = include_str!("../prompts/expert-spokesperson.md");
const ROLE_PLACEHOLDER: &str = "{{ROLE}}";

static SPOKESPERSON_INSTRUCTIONS: LazyLock<String> =
    LazyLock::new(|| realtime_role_instructions("Spokesperson"));

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeTurnDetection {
    #[default]
    ServerVad,
    SemanticVad,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeEagerness {
    Low,
    Medium,
    High,
    #[default]
    Auto,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeNoiseReduction {
    Off,
    NearField,
    FarField,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeReasoningEffort {
    Default,
    None,
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeSpokespersonSessionOptions {
    pub model: Option<String>,
    pub transcription_model: Option<String>,
    pub transcription_language: Option<String>,
    pub transcription_prompt: Option<String>,
    pub voice: Option<String>,
    pub speed: Option<f32>,
    pub turn_detection: Option<RealtimeTurnDetection>,
    pub eagerness: Option<RealtimeEagerness>,
    pub interrupt_response: Option<bool>,
    pub create_response: Option<bool>,
    pub vad_threshold: Option<f32>,
    pub prefix_padding_ms: Option<u64>,
    pub silence_duration_ms: Option<u64>,
    pub idle_timeout_ms: Option<u64>,
    pub noise_reduction: Option<RealtimeNoiseReduction>,
    pub reasoning_effort: Option<RealtimeReasoningEffort>,
    pub max_output_tokens: Option<u64>,
}

pub fn realtime_role_instructions(role: &str) -> String {
    let normalized = PROMPT_DOCUMENT.replace("\r\n", "\n");
    let normalized = normalized.trim();
    assert_eq!(
        normalized.matches(ROLE_PLACEHOLDER).count(),
        1,
        "Realtime prompt must contain exactly one {ROLE_PLACEHOLDER} placeholder"
    );
    normalized.replace(ROLE_PLACEHOLDER, role)
}

pub fn expert_session_instructions(session_id: &str, initial_cursor: u64, call_id: &str) -> String {
    let session_id = serde_json::to_string(session_id).expect("session id is serializable");
    format!(
        "{}\n\nYour send_to_spokesperson tool is the Berd CLI command below. This Realtime call is {call_id}, and its initial bridge cursor is {initial_cursor}. Always use the newest cursor from any Expert-bound transcript, handoff, reminder, or prior tool result. A stale cursor means a newer event is already queued; wait for its normal delivery rather than bypassing it. Choose --mode context to silently update the Spokesperson's context for a future natural turn. Choose --mode say only when the Spokesperson should have an opportunity to speak your message to the user now. A say may resolve several open handoffs by repeating --resolves for each handoff id. Context cannot resolve a handoff. Finishing your turn does not notify or wake the Spokesperson, so send explicitly when needed. Resolve every required handoff before ending your turn; the host may privately remind you if one remains.\n\nberdctl session send-to-spokesperson --session-id {session_id} --cursor <cursor> --mode <context|say> [--resolves <handoff-id> ...] --message <message> --json\n\nIf a handoff is obsolete, superseded, or already handled, dismiss it explicitly:\n\nberdctl session dismiss-handoffs --session-id {session_id} --cursor <cursor> --handoff-id <handoff-id> [--handoff-id <handoff-id> ...] --reason <reason> --json",
        realtime_role_instructions("Expert")
    )
}

pub fn accepted_handoff_tool_output(call_id: &str, handoff_id: &str) -> Result<Value, String> {
    let call_id = require_non_empty(call_id, "call id")?;
    let handoff_id = require_non_empty(handoff_id, "handoff id")?;
    Ok(json!({
        "type": "conversation.item.create",
        "item": {
            "type": "function_call_output",
            "call_id": call_id,
            "output": json!({ "accepted": true, "handoff_id": handoff_id }).to_string(),
        },
    }))
}

pub fn invalid_tool_call_output(
    call_id: &str,
    tool_name: &str,
    error: &str,
) -> Result<Value, String> {
    let call_id = require_non_empty(call_id, "call id")?;
    let tool_name = require_non_empty(tool_name, "tool name")?;
    let error = require_non_empty(error, "tool error")?;
    Ok(json!({
        "type": "conversation.item.create",
        "item": {
            "type": "function_call_output",
            "call_id": call_id,
            "output": json!({
                "accepted": false,
                "reason": "invalid_arguments",
                "error": format!(
                    "{tool_name} arguments were invalid: {error}. Retry this tool call with complete valid JSON. Do not speak this internal error to the user."
                ),
            }).to_string(),
        },
    }))
}

pub fn spokesperson_session_update(options: &RealtimeSpokespersonSessionOptions) -> Value {
    let create_response = options.create_response.unwrap_or(true);
    let interrupt_response = options.interrupt_response.unwrap_or(true);
    let turn_detection = match options.turn_detection.unwrap_or_default() {
        RealtimeTurnDetection::SemanticVad => json!({
            "type": "semantic_vad",
            "eagerness": options.eagerness.unwrap_or_default(),
            "create_response": create_response,
            "interrupt_response": interrupt_response,
        }),
        RealtimeTurnDetection::ServerVad => {
            let mut value = json!({
                "type": "server_vad",
                "threshold": options.vad_threshold.unwrap_or(0.5),
                "prefix_padding_ms": options.prefix_padding_ms.unwrap_or(300),
                "silence_duration_ms": options.silence_duration_ms.unwrap_or(500),
                "create_response": create_response,
                "interrupt_response": interrupt_response,
            });
            if let Some(idle_timeout_ms) = options.idle_timeout_ms.filter(|value| *value > 0) {
                value["idle_timeout_ms"] = idle_timeout_ms.into();
            }
            value
        }
    };

    let transcription_language = trimmed(&options.transcription_language);
    let transcription_prompt = trimmed(&options.transcription_prompt);
    let mut transcription = json!({
        "model": options
            .transcription_model
            .as_deref()
            .unwrap_or("gpt-realtime-whisper"),
    });
    if let Some(language) = transcription_language {
        transcription["language"] = language.into();
    }
    if let Some(prompt) = transcription_prompt {
        transcription["prompt"] = prompt.into();
    }

    let noise_reduction = match options.noise_reduction {
        Some(RealtimeNoiseReduction::NearField) => json!({ "type": "near_field" }),
        Some(RealtimeNoiseReduction::FarField) => json!({ "type": "far_field" }),
        Some(RealtimeNoiseReduction::Off) | None => Value::Null,
    };
    let max_output_tokens = options
        .max_output_tokens
        .map_or_else(|| json!("inf"), Value::from);
    let mut session = json!({
        "type": "realtime",
        "output_modalities": ["audio"],
        "max_output_tokens": max_output_tokens,
        "instructions": SPOKESPERSON_INSTRUCTIONS.as_str(),
        "audio": {
            "input": {
                "format": { "type": "audio/pcm", "rate": 24_000 },
                "transcription": transcription,
                "noise_reduction": noise_reduction,
                "turn_detection": turn_detection,
            },
            "output": {
                "format": { "type": "audio/pcm", "rate": 24_000 },
                "voice": options.voice.as_deref().unwrap_or("marin"),
                "speed": options.speed.unwrap_or(1.0),
            },
        },
        "tools": [{
            "type": "function",
            "name": "handoff",
            "description": "Hand unresolved work or an authoritative question to the Expert. Every accepted handoff must eventually be answered or explicitly dismissed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "The concise unresolved request the Expert now owns.",
                    },
                },
                "required": ["message"],
                "additionalProperties": false,
            },
        }],
        "tool_choice": "auto",
    });
    if supports_reasoning(options.model.as_deref()) {
        if let Some(effort) = options
            .reasoning_effort
            .filter(|effort| !matches!(effort, RealtimeReasoningEffort::Default))
        {
            session["reasoning"] = json!({ "effort": effort });
        }
    }
    json!({ "type": "session.update", "session": session })
}

fn trimmed(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn supports_reasoning(model: Option<&str>) -> bool {
    model.is_none_or(|model| model.starts_with("gpt-realtime-2.1"))
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum RealtimeTranscriptSeedTurn {
    User { text: String },
    Spokesperson { text: String, interrupted: bool },
    Expert { text: String },
}

pub fn realtime_transcript_seed_item(
    turn: RealtimeTranscriptSeedTurn,
    item_id: Option<&str>,
) -> Value {
    let (role, content_type, text) = match turn {
        RealtimeTranscriptSeedTurn::User { text } => ("user", "input_text", text),
        RealtimeTranscriptSeedTurn::Spokesperson { text, interrupted } => (
            "assistant",
            "output_text",
            if interrupted {
                format!("{text} [interrupted]")
            } else {
                text
            },
        ),
        RealtimeTranscriptSeedTurn::Expert { text } => (
            "system",
            "input_text",
            format!("Private Expert context; do not respond now:\n{text}"),
        ),
    };
    let mut item = json!({
        "type": "message",
        "role": role,
        "content": [{ "type": content_type, "text": text }],
    });
    if let Some(item_id) = item_id {
        item["id"] = item_id.into();
    }
    json!({ "type": "conversation.item.create", "item": item })
}

pub fn realtime_transcript_seed_events(
    turns: Vec<RealtimeTranscriptSeedTurn>,
    max_items: usize,
    session_id: Option<&str>,
) -> Vec<Value> {
    let tail_start = turns.len().saturating_sub(max_items);
    let tail = &turns[tail_start..];
    let Some(first_user_index) = tail
        .iter()
        .position(|turn| matches!(turn, RealtimeTranscriptSeedTurn::User { .. }))
    else {
        return Vec::new();
    };
    let mut events = Vec::new();
    if let Some(session_id) = session_id {
        events.push(json!({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "system",
                "content": [{
                    "type": "input_text",
                    "text": format!(
                        "This voice conversation is being resumed from Berd session {session_id}. Durable session link: berd://session/{session_id}. The following items are a compact recent transcript, not new turns. Ask the Expert to inspect the durable session when older context is needed."
                    ),
                }],
            },
        }));
    }
    events.extend(
        tail[first_user_index..]
            .iter()
            .cloned()
            .map(|turn| realtime_transcript_seed_item(turn, None)),
    );
    events
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RealtimeTranscriptSpeaker {
    User,
    Spokesperson,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeTranscriptEvidence {
    ProviderFinal,
    ProviderDelta,
    HostPlayedFrames,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RealtimeTranscriptAudioPart {
    pub text: String,
    pub total_audio_frames: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RealtimeInterruptedTranscriptInput {
    ProviderDelta {
        text: String,
    },
    HostPlayedFrames {
        text: String,
        audio_parts: Vec<RealtimeTranscriptAudioPart>,
        played_audio_frames: u64,
        total_audio_frames: u64,
        sample_rate: u32,
    },
}

/// Resolve the safest publishable transcript after Spokesperson playback is
/// interrupted. The policy is shared; each transport supplies the strongest
/// evidence it can observe.
pub fn resolve_interrupted_spokesperson_transcript(
    input: RealtimeInterruptedTranscriptInput,
) -> (String, RealtimeTranscriptEvidence) {
    match input {
        RealtimeInterruptedTranscriptInput::ProviderDelta { text } => {
            (text, RealtimeTranscriptEvidence::ProviderDelta)
        }
        RealtimeInterruptedTranscriptInput::HostPlayedFrames {
            text,
            audio_parts,
            played_audio_frames,
            total_audio_frames,
            sample_rate,
        } => {
            let text = if audio_parts.is_empty() {
                estimated_transcript_prefix(
                    &text,
                    played_audio_frames.min(total_audio_frames),
                    total_audio_frames,
                    sample_rate,
                )
            } else {
                let mut remaining_played = played_audio_frames.min(total_audio_frames);
                audio_parts
                    .into_iter()
                    .filter_map(|part| {
                        let played_frames = remaining_played.min(part.total_audio_frames);
                        remaining_played -= played_frames;
                        if part.text.is_empty() {
                            return None;
                        }
                        Some(estimated_transcript_prefix(
                            &part.text,
                            played_frames,
                            part.total_audio_frames,
                            sample_rate,
                        ))
                    })
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            (text, RealtimeTranscriptEvidence::HostPlayedFrames)
        }
    }
}

fn estimated_transcript_prefix(
    text: &str,
    played_frames: u64,
    total_frames: u64,
    sample_rate: u32,
) -> String {
    let delivery = DeliveryProgress {
        sample_rate,
        segments: vec![DeliverySegment {
            text: text.to_string(),
            played_frames,
            total_frames,
            synthesis_complete: true,
        }],
    };
    text[..estimated_spoken_through_utf8(text, &delivery)].to_string()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type")]
pub enum RealtimeProtocolEvent {
    #[serde(rename = "transcript.started", rename_all = "camelCase")]
    TranscriptStarted {
        item_id: String,
        speaker: RealtimeTranscriptSpeaker,
    },
    #[serde(rename = "transcript.updated", rename_all = "camelCase")]
    TranscriptUpdated {
        item_id: String,
        speaker: RealtimeTranscriptSpeaker,
        text: String,
    },
    #[serde(rename = "transcript.finalized", rename_all = "camelCase")]
    TranscriptFinalized {
        id: u64,
        item_id: String,
        speaker: RealtimeTranscriptSpeaker,
        text: String,
        interrupted: bool,
        evidence: RealtimeTranscriptEvidence,
        expert_message: String,
    },
    #[serde(rename = "handoff", rename_all = "camelCase")]
    Handoff {
        #[serde(skip_serializing_if = "Option::is_none")]
        response_id: Option<String>,
        call_id: String,
        message: String,
    },
    #[serde(rename = "tool_call.invalid", rename_all = "camelCase")]
    InvalidToolCall {
        call_id: String,
        tool_name: String,
        error: String,
    },
    #[serde(rename = "spokesperson.playback_interrupted", rename_all = "camelCase")]
    PlaybackInterrupted { response_id: String },
}

#[derive(Debug, Default)]
struct PendingSpokespersonTranscriptItem {
    streamed_text: String,
    final_text: Option<String>,
}

#[derive(Debug)]
struct PendingSpokespersonTranscript {
    display_item_id: String,
    item_order: Vec<String>,
    items: HashMap<String, PendingSpokespersonTranscriptItem>,
}

#[derive(Debug)]
pub struct RealtimeProtocolReducer {
    next_transcript_id: u64,
    finalized_item_ids: HashSet<String>,
    completed_call_ids: HashSet<String>,
    call_names: HashMap<String, String>,
    argument_deltas: HashMap<String, String>,
    pending_user_transcripts: HashMap<String, String>,
    pending_spokesperson_transcripts: HashMap<String, PendingSpokespersonTranscript>,
    interrupted_response_ids: HashSet<String>,
}

impl Default for RealtimeProtocolReducer {
    fn default() -> Self {
        Self {
            next_transcript_id: 1,
            finalized_item_ids: HashSet::new(),
            completed_call_ids: HashSet::new(),
            call_names: HashMap::new(),
            argument_deltas: HashMap::new(),
            pending_user_transcripts: HashMap::new(),
            pending_spokesperson_transcripts: HashMap::new(),
            interrupted_response_ids: HashSet::new(),
        }
    }
}

impl RealtimeProtocolReducer {
    pub fn handle(&mut self, event: &Value) -> Result<Vec<RealtimeProtocolEvent>, String> {
        let kind = string_at(event, "/type").unwrap_or_default();
        match kind {
            "error" | "conversation.item.input_audio_transcription.failed" => {
                Err(realtime_error_message(event))
            }
            "response.output_item.added" => {
                if string_at(event, "/item/type") == Some("function_call") {
                    if let (Some(call_id), Some(name)) = (
                        string_at(event, "/item/call_id"),
                        string_at(event, "/item/name"),
                    ) {
                        self.call_names.insert(call_id.into(), name.into());
                    }
                }
                Ok(Vec::new())
            }
            "response.function_call_arguments.delta" => {
                if let (Some(call_id), Some(delta)) =
                    (string_at(event, "/call_id"), string_at(event, "/delta"))
                {
                    self.argument_deltas
                        .entry(call_id.into())
                        .or_default()
                        .push_str(delta);
                }
                Ok(Vec::new())
            }
            "response.function_call_arguments.done" => self.finish_function_call(event),
            "input_audio_buffer.speech_started" => {
                let Some(item_id) = string_at(event, "/item_id") else {
                    return Ok(Vec::new());
                };
                if self.finalized_item_ids.contains(item_id) {
                    return Ok(Vec::new());
                }
                Ok(vec![RealtimeProtocolEvent::TranscriptStarted {
                    item_id: item_id.into(),
                    speaker: RealtimeTranscriptSpeaker::User,
                }])
            }
            "conversation.item.input_audio_transcription.delta" => {
                self.capture_user_transcript_delta(event)
            }
            "conversation.item.input_audio_transcription.completed" => {
                self.finish_user_transcript(event)
            }
            "response.output_audio_transcript.delta" => {
                self.capture_spokesperson_transcript_delta(event)
            }
            "response.output_audio_transcript.done" => {
                self.capture_spokesperson_transcript_final(event);
                Ok(Vec::new())
            }
            "output_audio_buffer.stopped" => self.finish_spokesperson_playback(event, false),
            "output_audio_buffer.cleared" => self.finish_spokesperson_playback(event, true),
            _ => Ok(Vec::new()),
        }
    }

    fn capture_user_transcript_delta(
        &mut self,
        event: &Value,
    ) -> Result<Vec<RealtimeProtocolEvent>, String> {
        let (Some(item_id), Some(delta)) =
            (string_at(event, "/item_id"), string_at(event, "/delta"))
        else {
            return Ok(Vec::new());
        };
        if self.finalized_item_ids.contains(item_id) {
            return Ok(Vec::new());
        }
        let text = self
            .pending_user_transcripts
            .entry(item_id.into())
            .or_default();
        text.push_str(delta);
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![RealtimeProtocolEvent::TranscriptUpdated {
            item_id: item_id.into(),
            speaker: RealtimeTranscriptSpeaker::User,
            text: text.clone(),
        }])
    }

    fn finish_user_transcript(
        &mut self,
        event: &Value,
    ) -> Result<Vec<RealtimeProtocolEvent>, String> {
        let (Some(item_id), Some(text)) = (
            string_at(event, "/item_id"),
            string_at(event, "/transcript").map(str::trim),
        ) else {
            return Ok(Vec::new());
        };
        if text.is_empty() || self.finalized_item_ids.contains(item_id) {
            return Ok(Vec::new());
        }
        self.pending_user_transcripts.remove(item_id);
        self.finalized_item_ids.insert(item_id.into());
        Ok(vec![self.finalized_transcript(
            item_id,
            RealtimeTranscriptSpeaker::User,
            text,
            false,
            RealtimeTranscriptEvidence::ProviderFinal,
        )])
    }

    fn capture_spokesperson_transcript_delta(
        &mut self,
        event: &Value,
    ) -> Result<Vec<RealtimeProtocolEvent>, String> {
        let (Some(response_id), Some(item_id), Some(delta)) = (
            string_at(event, "/response_id"),
            string_at(event, "/item_id"),
            string_at(event, "/delta"),
        ) else {
            return Ok(Vec::new());
        };
        if self.interrupted_response_ids.contains(response_id) {
            return Ok(Vec::new());
        }
        let pending = self.pending_spokesperson_transcript(response_id, item_id);
        pending
            .items
            .get_mut(item_id)
            .expect("new item was inserted")
            .streamed_text
            .push_str(delta);
        let text = combined_spokesperson_transcript(pending, false);
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![RealtimeProtocolEvent::TranscriptUpdated {
            item_id: pending.display_item_id.clone(),
            speaker: RealtimeTranscriptSpeaker::Spokesperson,
            text,
        }])
    }

    fn capture_spokesperson_transcript_final(&mut self, event: &Value) {
        let (Some(response_id), Some(item_id), Some(text)) = (
            string_at(event, "/response_id"),
            string_at(event, "/item_id"),
            string_at(event, "/transcript").map(str::trim),
        ) else {
            return;
        };
        if text.is_empty()
            || self.finalized_item_ids.contains(item_id)
            || self.interrupted_response_ids.contains(response_id)
        {
            return;
        }
        self.pending_spokesperson_transcript(response_id, item_id)
            .items
            .get_mut(item_id)
            .expect("new item was inserted")
            .final_text = Some(text.into());
    }

    fn finish_spokesperson_playback(
        &mut self,
        event: &Value,
        interrupted: bool,
    ) -> Result<Vec<RealtimeProtocolEvent>, String> {
        let Some(response_id) = string_at(event, "/response_id") else {
            return Ok(Vec::new());
        };
        if interrupted {
            self.interrupted_response_ids.insert(response_id.into());
        } else if self.interrupted_response_ids.remove(response_id) {
            return Ok(Vec::new());
        }
        let pending = self.pending_spokesperson_transcripts.remove(response_id);
        let mut events = Vec::new();
        if let Some(pending) = pending {
            let mut text = combined_spokesperson_transcript(&pending, !interrupted);
            let evidence = if interrupted {
                let played_audio_frames = event.get("played_audio_frames").and_then(Value::as_u64);
                let total_audio_frames = event.get("total_audio_frames").and_then(Value::as_u64);
                let sample_rate = event
                    .get("sample_rate")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok());
                let input = match (played_audio_frames, total_audio_frames, sample_rate) {
                    (Some(played_audio_frames), Some(total_audio_frames), Some(sample_rate)) => {
                        RealtimeInterruptedTranscriptInput::HostPlayedFrames {
                            text,
                            audio_parts: Vec::new(),
                            played_audio_frames,
                            total_audio_frames,
                            sample_rate,
                        }
                    }
                    _ => RealtimeInterruptedTranscriptInput::ProviderDelta { text },
                };
                let resolved = resolve_interrupted_spokesperson_transcript(input);
                text = resolved.0;
                resolved.1
            } else {
                RealtimeTranscriptEvidence::ProviderFinal
            };
            if !text.trim().is_empty()
                && !self.finalized_item_ids.contains(&pending.display_item_id)
            {
                for item_id in &pending.item_order {
                    self.finalized_item_ids.insert(item_id.clone());
                }
                events.push(self.finalized_transcript(
                    &pending.display_item_id,
                    RealtimeTranscriptSpeaker::Spokesperson,
                    text.trim(),
                    interrupted,
                    evidence,
                ));
            }
        }
        if interrupted {
            events.push(RealtimeProtocolEvent::PlaybackInterrupted {
                response_id: response_id.into(),
            });
        }
        Ok(events)
    }

    fn finish_function_call(
        &mut self,
        event: &Value,
    ) -> Result<Vec<RealtimeProtocolEvent>, String> {
        let Some(call_id) = string_at(event, "/call_id") else {
            return Ok(Vec::new());
        };
        if self.completed_call_ids.contains(call_id) {
            return Ok(Vec::new());
        }
        let name =
            string_at(event, "/name").or_else(|| self.call_names.get(call_id).map(String::as_str));
        if name != Some("handoff") {
            return Ok(Vec::new());
        }
        let result = (|| {
            let arguments = string_at(event, "/arguments")
                .or_else(|| self.argument_deltas.get(call_id).map(String::as_str))
                .ok_or_else(|| "handoff arguments are incomplete".to_string())?;
            let parsed: Value = serde_json::from_str(arguments)
                .map_err(|error| format!("handoff arguments are invalid JSON: {error}"))?;
            let object = parsed
                .as_object()
                .ok_or_else(|| "handoff arguments must be an object".to_string())?;
            if object.len() != 1 || !object.contains_key("message") {
                return Err("handoff accepts only a message argument".into());
            }
            let message = object
                .get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|message| !message.is_empty())
                .ok_or_else(|| "handoff message cannot be empty".to_string())?;
            Ok(message.to_string())
        })();
        self.completed_call_ids.insert(call_id.into());
        self.argument_deltas.remove(call_id);
        self.call_names.remove(call_id);
        Ok(vec![match result {
            Ok(message) => RealtimeProtocolEvent::Handoff {
                response_id: string_at(event, "/response_id").map(str::to_string),
                call_id: call_id.into(),
                message,
            },
            Err(error) => RealtimeProtocolEvent::InvalidToolCall {
                call_id: call_id.into(),
                tool_name: "handoff".into(),
                error,
            },
        }])
    }

    fn pending_spokesperson_transcript(
        &mut self,
        response_id: &str,
        item_id: &str,
    ) -> &mut PendingSpokespersonTranscript {
        let pending = self
            .pending_spokesperson_transcripts
            .entry(response_id.into())
            .or_insert_with(|| PendingSpokespersonTranscript {
                display_item_id: item_id.into(),
                item_order: Vec::new(),
                items: HashMap::new(),
            });
        if !pending.items.contains_key(item_id) {
            pending.item_order.push(item_id.into());
            pending.items.insert(item_id.into(), Default::default());
        }
        pending
    }

    fn finalized_transcript(
        &mut self,
        item_id: &str,
        speaker: RealtimeTranscriptSpeaker,
        text: &str,
        interrupted: bool,
        evidence: RealtimeTranscriptEvidence,
    ) -> RealtimeProtocolEvent {
        let id = self.next_transcript_id;
        self.next_transcript_id = self.next_transcript_id.saturating_add(1);
        RealtimeProtocolEvent::TranscriptFinalized {
            id,
            item_id: item_id.into(),
            speaker,
            text: text.into(),
            interrupted,
            evidence,
            expert_message: expert_transcript_message(speaker, text, interrupted),
        }
    }
}

pub fn expert_transcript_message(
    speaker: RealtimeTranscriptSpeaker,
    text: &str,
    interrupted: bool,
) -> String {
    match (speaker, interrupted) {
        (RealtimeTranscriptSpeaker::User, _) => {
            format!("[Voice transcript] User said: {text}")
        }
        (RealtimeTranscriptSpeaker::Spokesperson, false) => {
            format!("[Voice transcript] Spokesperson said: {text}")
        }
        (RealtimeTranscriptSpeaker::Spokesperson, true) => {
            format!("[Voice transcript] Spokesperson said (interrupted; best effort): {text}")
        }
    }
}

pub fn expert_handoff_message(handoff_id: &str, cursor: u64, message: &str) -> String {
    format!("[Handoff {handoff_id} from spokesperson; cursor {cursor}] {message}")
}

fn combined_spokesperson_transcript(
    pending: &PendingSpokespersonTranscript,
    prefer_final_text: bool,
) -> String {
    pending
        .item_order
        .iter()
        .filter_map(|item_id| pending.items.get(item_id))
        .map(|item| {
            if prefer_final_text {
                item.final_text.as_deref().unwrap_or(&item.streamed_text)
            } else {
                &item.streamed_text
            }
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn string_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

fn realtime_error_message(event: &Value) -> String {
    string_at(event, "/error/message")
        .or_else(|| string_at(event, "/message"))
        .unwrap_or("OpenAI Realtime reported an error")
        .to_string()
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum RealtimePipePeer {
    #[serde(rename = "master")]
    Expert,
    #[serde(rename = "emissary")]
    Spokesperson,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePipeMessage {
    pub id: u64,
    pub sender: RealtimePipePeer,
    pub recipient: RealtimePipePeer,
    pub sender_cursor: u64,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RealtimePipeExchange {
    Accepted(RealtimePipeAccepted),
    Rejected(RealtimePipeRejected),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePipeAccepted {
    pub accepted: bool,
    pub outbound: RealtimePipeMessage,
    pub cursor: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePipeRejected {
    pub accepted: bool,
    pub reason: RealtimePipeRejection,
    pub cursor: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RealtimePipeRejection {
    PipeBusy,
    StaleCursor,
}

#[derive(Debug)]
pub struct RealtimeMessagePipe {
    next_message_id: u64,
    pending: Vec<RealtimePipeMessage>,
    expert_cursor: u64,
    spokesperson_cursor: u64,
}

impl RealtimeMessagePipe {
    pub fn new(initial_cursor: u64) -> Self {
        Self {
            next_message_id: initial_cursor.saturating_add(1),
            pending: Vec::new(),
            expert_cursor: initial_cursor,
            spokesperson_cursor: initial_cursor,
        }
    }

    pub fn send(
        &mut self,
        sender: RealtimePipePeer,
        cursor: u64,
        message: &str,
    ) -> Result<RealtimePipeExchange, String> {
        let message = require_non_empty(message, "direct message")?;
        if self
            .pending
            .first()
            .is_some_and(|active| active.sender != sender)
        {
            let latest = self.pending.last().expect("pending batch is nonempty");
            if cursor != latest.id {
                return Ok(RealtimePipeExchange::Rejected(RealtimePipeRejected {
                    accepted: false,
                    reason: RealtimePipeRejection::PipeBusy,
                    cursor: self.cursor(sender),
                }));
            }
            *self.cursor_mut(sender) = latest.id;
            self.pending.clear();
        }
        let confirmed_cursor = self.cursor(sender);
        if cursor != confirmed_cursor {
            return Ok(RealtimePipeExchange::Rejected(RealtimePipeRejected {
                accepted: false,
                reason: RealtimePipeRejection::StaleCursor,
                cursor: confirmed_cursor,
            }));
        }
        let outbound = RealtimePipeMessage {
            id: self.next_message_id,
            sender,
            recipient: other_pipe_peer(sender),
            sender_cursor: confirmed_cursor,
            message,
        };
        self.next_message_id = self.next_message_id.saturating_add(1);
        self.pending.push(outbound.clone());
        Ok(RealtimePipeExchange::Accepted(RealtimePipeAccepted {
            accepted: true,
            outbound,
            cursor: confirmed_cursor,
        }))
    }

    pub fn cursor(&self, peer: RealtimePipePeer) -> u64 {
        match peer {
            RealtimePipePeer::Expert => self.expert_cursor,
            RealtimePipePeer::Spokesperson => self.spokesperson_cursor,
        }
    }

    pub fn delivery_cursor(&self, peer: RealtimePipePeer) -> u64 {
        self.pending
            .last()
            .filter(|message| message.recipient == peer)
            .map_or_else(|| self.cursor(peer), |message| message.id)
    }

    fn cursor_mut(&mut self, peer: RealtimePipePeer) -> &mut u64 {
        match peer {
            RealtimePipePeer::Expert => &mut self.expert_cursor,
            RealtimePipePeer::Spokesperson => &mut self.spokesperson_cursor,
        }
    }
}

fn other_pipe_peer(peer: RealtimePipePeer) -> RealtimePipePeer {
    match peer {
        RealtimePipePeer::Expert => RealtimePipePeer::Spokesperson,
        RealtimePipePeer::Spokesperson => RealtimePipePeer::Expert,
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RealtimeExpertMessageMode {
    Context,
    Say,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeExpertMessage {
    pub message: String,
    pub mode: RealtimeExpertMessageMode,
    pub event_id: Option<String>,
    #[serde(default)]
    pub resolved_handoff_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RealtimeRequestStatus {
    Sent,
    Interrupting,
    Queued,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeCoordinatorResult {
    pub status: RealtimeRequestStatus,
    pub events: Vec<Value>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeCoordinatorUpdate {
    pub events: Vec<Value>,
    pub completed_handoff_ids: Vec<String>,
    pub failed_handoff_ids: Vec<String>,
}

#[derive(Debug)]
struct ActiveResponse {
    id: Option<String>,
    generation_done: bool,
    output_active: bool,
    output_produced: bool,
    succeeded: bool,
    say: Option<RealtimeExpertMessage>,
}

#[derive(Debug)]
enum PendingResponse {
    Default,
    Say(RealtimeExpertMessage),
}

#[derive(Debug, Default)]
pub struct RealtimeResponseCoordinator {
    active_response: Option<ActiveResponse>,
    pending_responses: Vec<PendingResponse>,
    completed_handoff_ids: Vec<String>,
    failed_handoff_ids: Vec<String>,
}

impl RealtimeResponseCoordinator {
    pub fn request_expert_message(
        &mut self,
        mut message: RealtimeExpertMessage,
    ) -> Result<RealtimeCoordinatorResult, String> {
        message.message = require_non_empty(&message.message, "Expert message")?;
        let item = realtime_expert_message_item(&message);
        if matches!(message.mode, RealtimeExpertMessageMode::Context) {
            return Ok(RealtimeCoordinatorResult {
                status: RealtimeRequestStatus::Sent,
                events: vec![item],
            });
        }
        if self.active_response.is_none() {
            let response = realtime_expert_say_response(&message.message, None)?;
            self.active_response = Some(awaiting_created_response(Some(message)));
            return Ok(RealtimeCoordinatorResult {
                status: RealtimeRequestStatus::Sent,
                events: vec![item, response],
            });
        }
        self.pending_responses.push(PendingResponse::Say(message));
        Ok(RealtimeCoordinatorResult {
            status: RealtimeRequestStatus::Queued,
            events: vec![item],
        })
    }

    pub fn request_tool_output(
        &mut self,
        event: Value,
        request_response: bool,
    ) -> RealtimeCoordinatorResult {
        if !request_response {
            return RealtimeCoordinatorResult {
                status: RealtimeRequestStatus::Sent,
                events: vec![event],
            };
        }
        if self.active_response.is_none() {
            self.active_response = Some(awaiting_created_response(None));
            return RealtimeCoordinatorResult {
                status: RealtimeRequestStatus::Sent,
                events: vec![event, json!({ "type": "response.create" })],
            };
        }
        if !self
            .pending_responses
            .iter()
            .any(|pending| matches!(pending, PendingResponse::Default))
        {
            self.pending_responses.push(PendingResponse::Default);
        }
        RealtimeCoordinatorResult {
            status: RealtimeRequestStatus::Queued,
            events: vec![event],
        }
    }

    pub fn request_typed_user_message(
        &mut self,
        text: &str,
    ) -> Result<RealtimeCoordinatorResult, String> {
        let text = require_non_empty(text, "user text")?;
        let item = json!({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": text }],
            },
        });
        if self.active_response.is_none() {
            self.active_response = Some(awaiting_created_response(None));
            return Ok(RealtimeCoordinatorResult {
                status: RealtimeRequestStatus::Sent,
                events: vec![
                    json!({ "type": "input_audio_buffer.clear" }),
                    item,
                    json!({ "type": "response.create" }),
                ],
            });
        }
        if !self
            .pending_responses
            .iter()
            .any(|pending| matches!(pending, PendingResponse::Default))
        {
            self.pending_responses.push(PendingResponse::Default);
        }
        let mut events = Vec::new();
        let active = self.active_response.as_ref().expect("active response");
        if let Some(response_id) = active.id.as_deref().filter(|_| !active.generation_done) {
            events.push(json!({ "type": "response.cancel", "response_id": response_id }));
        }
        if active.output_active {
            events.push(json!({ "type": "output_audio_buffer.clear" }));
        }
        events.push(json!({ "type": "input_audio_buffer.clear" }));
        events.push(item);
        Ok(RealtimeCoordinatorResult {
            status: if active.id.is_some() {
                RealtimeRequestStatus::Interrupting
            } else {
                RealtimeRequestStatus::Queued
            },
            events,
        })
    }

    pub fn handle(&mut self, event: &Value) -> Result<RealtimeCoordinatorUpdate, String> {
        match string_at(event, "/type").unwrap_or_default() {
            "response.created" => {
                let response_id = string_at(event, "/response/id")
                    .ok_or_else(|| "response.created is missing response.id".to_string())?;
                let requested_say = self
                    .active_response
                    .as_mut()
                    .and_then(|active| active.say.take());
                if self
                    .active_response
                    .as_ref()
                    .and_then(|active| active.id.as_ref())
                    .is_some()
                {
                    if let Some(message) = requested_say.as_ref() {
                        self.failed_handoff_ids
                            .extend(message.resolved_handoff_ids.iter().cloned());
                    }
                    self.pending_responses
                        .retain(|pending| matches!(pending, PendingResponse::Say(_)));
                }
                self.active_response = Some(ActiveResponse {
                    id: Some(response_id.into()),
                    generation_done: false,
                    output_active: false,
                    output_produced: false,
                    succeeded: false,
                    say: requested_say,
                });
            }
            "output_audio_buffer.started" => {
                if let Some(active) = self.match_active_response(event) {
                    active.output_active = true;
                    active.output_produced = true;
                }
            }
            "response.done" => {
                if let Some(active) = self.match_active_response(event) {
                    active.generation_done = true;
                    active.succeeded = string_at(event, "/response/status") == Some("completed");
                    if !active.output_active {
                        let events = self.finish_active_response()?;
                        return Ok(self.take_update(events));
                    }
                }
            }
            "output_audio_buffer.stopped" | "output_audio_buffer.cleared" => {
                if let Some(active) = self.match_active_response(event) {
                    active.output_active = false;
                    if active.generation_done {
                        let events = self.finish_active_response()?;
                        return Ok(self.take_update(events));
                    }
                }
            }
            _ => {}
        }
        Ok(self.take_update(Vec::new()))
    }

    fn match_active_response(&mut self, event: &Value) -> Option<&mut ActiveResponse> {
        let response_id =
            string_at(event, "/response_id").or_else(|| string_at(event, "/response/id"));
        let active = self.active_response.as_mut()?;
        if response_id.is_none() || active.id.is_none() || response_id == active.id.as_deref() {
            Some(active)
        } else {
            None
        }
    }

    fn finish_active_response(&mut self) -> Result<Vec<Value>, String> {
        if let Some(completed) = self.active_response.take() {
            if let Some(message) = completed.say {
                let target = if completed.succeeded && completed.output_produced {
                    &mut self.completed_handoff_ids
                } else {
                    &mut self.failed_handoff_ids
                };
                target.extend(message.resolved_handoff_ids);
            }
        }
        let Some(pending) = self.pending_responses.first() else {
            return Ok(Vec::new());
        };
        let event = match pending {
            PendingResponse::Default => json!({ "type": "response.create" }),
            PendingResponse::Say(message) => realtime_expert_say_response(&message.message, None)?,
        };
        let pending = self.pending_responses.remove(0);
        self.active_response = Some(awaiting_created_response(match pending {
            PendingResponse::Default => None,
            PendingResponse::Say(message) => Some(message),
        }));
        Ok(vec![event])
    }

    fn take_update(&mut self, events: Vec<Value>) -> RealtimeCoordinatorUpdate {
        RealtimeCoordinatorUpdate {
            events,
            completed_handoff_ids: std::mem::take(&mut self.completed_handoff_ids),
            failed_handoff_ids: std::mem::take(&mut self.failed_handoff_ids),
        }
    }
}

/// Complete transport-independent Expert-Spokesperson protocol state for one
/// OpenAI Realtime session. Native Berd and external adapters should own only
/// their transport and presentation concerns around this core.
#[derive(Debug)]
pub struct RealtimeExpertSpokespersonSession {
    reducer: RealtimeProtocolReducer,
    responses: RealtimeResponseCoordinator,
    pipe: RealtimeMessagePipe,
    open_handoffs: HashMap<String, RealtimeOpenHandoff>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RealtimeOpenHandoff {
    message: String,
    reminder_attempts: u8,
    resolving: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RealtimeHandoffReminder {
    None,
    Reminder {
        handoff_ids: Vec<String>,
        attempt: u8,
        requests: String,
        message: String,
    },
    Exhausted {
        handoff_ids: Vec<String>,
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeSessionReduction {
    pub protocol_events: Vec<RealtimeProtocolEvent>,
    pub client_events: Vec<Value>,
    pub completed_handoff_ids: Vec<String>,
    pub failed_handoff_ids: Vec<String>,
}

impl RealtimeExpertSpokespersonSession {
    pub fn new(initial_cursor: u64) -> Self {
        Self {
            reducer: RealtimeProtocolReducer::default(),
            responses: RealtimeResponseCoordinator::default(),
            pipe: RealtimeMessagePipe::new(initial_cursor),
            open_handoffs: HashMap::new(),
        }
    }

    pub fn handle_provider_event(
        &mut self,
        event: &Value,
    ) -> Result<RealtimeSessionReduction, String> {
        let response_update = self.responses.handle(event)?;
        for handoff_id in &response_update.completed_handoff_ids {
            self.open_handoffs.remove(handoff_id);
        }
        for handoff_id in &response_update.failed_handoff_ids {
            if let Some(handoff) = self.open_handoffs.get_mut(handoff_id) {
                handoff.resolving = false;
            }
        }
        Ok(RealtimeSessionReduction {
            protocol_events: self.reducer.handle(event)?,
            client_events: response_update.events,
            completed_handoff_ids: response_update.completed_handoff_ids,
            failed_handoff_ids: response_update.failed_handoff_ids,
        })
    }

    pub fn enqueue_spokesperson_message(
        &mut self,
        message: &str,
    ) -> Result<RealtimePipeExchange, String> {
        let cursor = self.pipe.delivery_cursor(RealtimePipePeer::Spokesperson);
        self.pipe
            .send(RealtimePipePeer::Spokesperson, cursor, message)
    }

    pub fn send_expert_pipe_message(
        &mut self,
        cursor: u64,
        message: &str,
    ) -> Result<RealtimePipeExchange, String> {
        self.pipe.send(RealtimePipePeer::Expert, cursor, message)
    }

    pub fn expert_pipe_cursor(&self) -> u64 {
        self.pipe.cursor(RealtimePipePeer::Expert)
    }

    pub fn request_expert_message(
        &mut self,
        message: RealtimeExpertMessage,
    ) -> Result<RealtimeCoordinatorResult, String> {
        self.responses.request_expert_message(message)
    }

    pub fn request_tool_output(
        &mut self,
        event: Value,
        request_response: bool,
    ) -> RealtimeCoordinatorResult {
        self.responses.request_tool_output(event, request_response)
    }

    pub fn request_typed_user_message(
        &mut self,
        text: &str,
    ) -> Result<RealtimeCoordinatorResult, String> {
        self.responses.request_typed_user_message(text)
    }

    pub fn register_handoff(
        &mut self,
        handoff_id: &str,
        cursor: u64,
        message: &str,
    ) -> Result<String, String> {
        let handoff_id = require_non_empty(handoff_id, "handoff id")?;
        let message = require_non_empty(message, "handoff message")?;
        let expert_message = expert_handoff_message(&handoff_id, cursor, &message);
        self.open_handoffs.insert(
            handoff_id,
            RealtimeOpenHandoff {
                message,
                reminder_attempts: 0,
                resolving: false,
            },
        );
        Ok(expert_message)
    }

    pub fn unknown_handoff_ids(&self, handoff_ids: &[String]) -> Vec<String> {
        handoff_ids
            .iter()
            .filter(|handoff_id| !self.open_handoffs.contains_key(*handoff_id))
            .cloned()
            .collect()
    }

    pub fn mark_handoffs_resolving(&mut self, handoff_ids: &[String]) -> Result<(), String> {
        let unknown = self.unknown_handoff_ids(handoff_ids);
        if !unknown.is_empty() {
            return Err(format!("unknown handoff: {}", unknown.join(", ")));
        }
        for handoff_id in handoff_ids {
            self.open_handoffs
                .get_mut(handoff_id)
                .expect("handoff was validated")
                .resolving = true;
        }
        Ok(())
    }

    pub fn dismiss_handoffs(&mut self, handoff_ids: &[String]) -> Result<(), String> {
        let unknown = self.unknown_handoff_ids(handoff_ids);
        if !unknown.is_empty() {
            return Err(format!("unknown handoff: {}", unknown.join(", ")));
        }
        for handoff_id in handoff_ids {
            self.open_handoffs.remove(handoff_id);
        }
        Ok(())
    }

    pub fn complete_expert_turn(
        &mut self,
        retrying_handoff_ids: &[String],
        max_attempts: u8,
    ) -> RealtimeHandoffReminder {
        let retrying = retrying_handoff_ids.iter().collect::<HashSet<_>>();
        let mut pending = self
            .open_handoffs
            .iter_mut()
            .filter(|(handoff_id, handoff)| {
                !handoff.resolving
                    && (handoff.reminder_attempts == 0 || retrying.contains(handoff_id))
            })
            .collect::<Vec<_>>();
        pending.sort_by(|(left, _), (right, _)| left.cmp(right));
        if pending.is_empty() {
            return RealtimeHandoffReminder::None;
        }
        let exhausted = pending
            .iter()
            .filter(|(_, handoff)| handoff.reminder_attempts >= max_attempts)
            .map(|(handoff_id, _)| (*handoff_id).clone())
            .collect::<Vec<_>>();
        if !exhausted.is_empty() {
            return RealtimeHandoffReminder::Exhausted {
                message: format!(
                    "The Expert left required {} unresolved after {max_attempts} reminder attempts.",
                    exhausted.join(", ")
                ),
                handoff_ids: exhausted,
            };
        }
        let requests = pending
            .iter()
            .map(|(handoff_id, handoff)| format!("- {handoff_id}: {}", handoff.message))
            .collect::<Vec<_>>()
            .join("\n");
        for (_, handoff) in &mut pending {
            handoff.reminder_attempts = handoff.reminder_attempts.saturating_add(1);
        }
        let attempt = pending
            .iter()
            .map(|(_, handoff)| handoff.reminder_attempts)
            .max()
            .unwrap_or(1);
        let handoff_ids = pending
            .iter()
            .map(|(handoff_id, _)| (*handoff_id).clone())
            .collect::<Vec<_>>();
        RealtimeHandoffReminder::Reminder {
            message: format!(
                "[Private handoff reminder]\nYou ended your turn without resolving the required handoffs below. Resolve them now with one or more send-to-spokesperson --mode say calls that name every answered handoff in --resolves, or dismiss obsolete handoffs explicitly. Berd will retry this reminder up to {max_attempts} times. Do not redo completed work.\n{requests}"
            ),
            handoff_ids,
            attempt,
            requests,
        }
    }
}

fn awaiting_created_response(say: Option<RealtimeExpertMessage>) -> ActiveResponse {
    ActiveResponse {
        id: None,
        generation_done: false,
        output_active: false,
        output_produced: false,
        succeeded: false,
        say,
    }
}

pub fn realtime_expert_message_item(message: &RealtimeExpertMessage) -> Value {
    let text = match message.mode {
        RealtimeExpertMessageMode::Say => format!(
            "The Expert offers the following information for a response opportunity. Speak it naturally and accurately if a response is useful now; silence remains valid. Do not add filler or offer more help:\n{}",
            message.message
        ),
        RealtimeExpertMessageMode::Context => format!(
            "Private context from the Expert for a future natural turn. Do not respond to this item now:\n{}",
            message.message
        ),
    };
    let mut event = json!({
        "type": "conversation.item.create",
        "item": {
            "type": "message",
            "role": "system",
            "content": [{ "type": "input_text", "text": text }],
        },
    });
    if let Some(event_id) = message.event_id.as_deref() {
        event["event_id"] = event_id.into();
    }
    event
}

pub fn realtime_expert_say_response(
    message: &str,
    directive_id: Option<u64>,
) -> Result<Value, String> {
    let message = require_non_empty(message, "Expert message")?;
    let mut response = json!({
        "type": "response.create",
        "response": {
            "instructions": format!(
                "Consider this Expert message for the user: {message} If a response is useful now, speak naturally, concisely, and accurately while preserving its meaning. Silence is valid. Do not call tools."
            ),
            "tools": [],
            "tool_choice": "none",
        },
    });
    if let Some(directive_id) = directive_id {
        response["response"]["metadata"] = json!({
            "berd_expert_directive_id": directive_id.to_string(),
        });
    }
    Ok(response)
}

fn require_non_empty(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{field} cannot be empty"))
    } else {
        Ok(value.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_default_shared_spokesperson_session() {
        let update = spokesperson_session_update(&RealtimeSpokespersonSessionOptions::default());
        assert_eq!(update["type"], "session.update");
        assert_eq!(update["session"]["audio"]["output"]["voice"], "marin");
        assert_eq!(update["session"]["audio"]["output"]["speed"], 1.0);
        assert_eq!(
            update["session"]["audio"]["input"]["turn_detection"],
            json!({
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 500,
                "create_response": true,
                "interrupt_response": true,
            })
        );
        assert_eq!(update["session"]["tools"][0]["name"], "handoff");
    }

    #[test]
    fn shared_prompt_renders_exactly_one_role_placeholder() {
        let normalized = PROMPT_DOCUMENT.replace("\r\n", "\n");
        let normalized = normalized.trim();
        assert_eq!(normalized.matches(ROLE_PLACEHOLDER).count(), 1);
        assert_eq!(
            realtime_role_instructions("Spokesperson"),
            normalized.replace(ROLE_PLACEHOLDER, "Spokesperson")
        );
        assert_eq!(
            realtime_role_instructions("Expert"),
            normalized.replace(ROLE_PLACEHOLDER, "Expert")
        );
        for required in [
            "response text land in the durable transcript",
            "produce visible progress and result text",
            "Expert → Spokesperson delivery intents",
            "`SAY` asks the Spokesperson to speak useful information now",
            "finishing an Expert turn does not wake it",
            "entire turn is an empty, zero-token success",
            "interrupted Spokesperson transcripts as best-effort",
            "The host delivers relevant conversation events to the Expert",
            "there is no fixed timer or retry count",
            "two parts of one brain",
        ] {
            assert!(
                normalized.contains(required),
                "missing prompt rule: {required}"
            );
        }
        assert!(!normalized.contains("up to three times"));
    }

    #[test]
    fn expert_session_instructions_describe_say_as_an_opportunity() {
        let instructions = expert_session_instructions("session-a", 42, "call-a");
        assert!(instructions.contains("opportunity to speak"));
        assert!(instructions.contains("--session-id \"session-a\""));
        assert!(instructions.contains("initial bridge cursor is 42"));
        assert!(instructions.contains("Realtime call is call-a"));
    }

    #[test]
    fn expert_say_payload_offers_speech_without_requiring_it() {
        let message = RealtimeExpertMessage {
            message: "The build is green.".into(),
            mode: RealtimeExpertMessageMode::Say,
            event_id: Some("event-1".into()),
            resolved_handoff_ids: Vec::new(),
        };
        let item = realtime_expert_message_item(&message);
        let item_text = item
            .pointer("/item/content/0/text")
            .unwrap()
            .as_str()
            .unwrap();
        assert!(item_text.contains("response opportunity"));
        assert!(item_text.contains("silence remains valid"));
        assert_eq!(item["event_id"], "event-1");

        let response = realtime_expert_say_response(&message.message, Some(41)).unwrap();
        let instructions = response["response"]["instructions"].as_str().unwrap();
        assert!(instructions.contains("If a response is useful"));
        assert!(instructions.contains("Silence is valid"));
        assert_eq!(
            response["response"]["metadata"]["berd_expert_directive_id"],
            "41"
        );
    }

    #[test]
    fn shared_tool_outputs_encode_handoff_acceptance_and_silent_retry() {
        let accepted = accepted_handoff_tool_output("call-1", "handoff-1").unwrap();
        assert_eq!(accepted.pointer("/item/call_id"), Some(&json!("call-1")));
        assert_eq!(
            accepted
                .pointer("/item/output")
                .and_then(Value::as_str)
                .map(|output| serde_json::from_str::<Value>(output).unwrap()),
            Some(json!({ "accepted": true, "handoff_id": "handoff-1" }))
        );

        let rejected = invalid_tool_call_output("call-2", "handoff", "bad JSON").unwrap();
        let output = rejected
            .pointer("/item/output")
            .and_then(Value::as_str)
            .and_then(|output| serde_json::from_str::<Value>(output).ok())
            .unwrap();
        assert_eq!(output["accepted"], false);
        assert_eq!(output["reason"], "invalid_arguments");
        assert!(output["error"]
            .as_str()
            .is_some_and(|error| error.contains("Do not speak")));
    }

    #[test]
    fn maps_semantic_vad_and_advanced_controls() {
        let update = spokesperson_session_update(&RealtimeSpokespersonSessionOptions {
            model: Some("gpt-realtime-2.1-test".into()),
            transcription_model: Some("gpt-live-transcribe".into()),
            transcription_language: Some(" en ".into()),
            transcription_prompt: Some(" Berd, Tauri ".into()),
            turn_detection: Some(RealtimeTurnDetection::SemanticVad),
            eagerness: Some(RealtimeEagerness::High),
            create_response: Some(false),
            interrupt_response: Some(false),
            noise_reduction: Some(RealtimeNoiseReduction::FarField),
            reasoning_effort: Some(RealtimeReasoningEffort::Low),
            max_output_tokens: Some(512),
            ..Default::default()
        });
        assert_eq!(update["session"]["reasoning"], json!({ "effort": "low" }));
        assert_eq!(update["session"]["max_output_tokens"], 512);
        assert_eq!(
            update["session"]["audio"]["input"]["turn_detection"],
            json!({
                "type": "semantic_vad",
                "eagerness": "high",
                "create_response": false,
                "interrupt_response": false,
            })
        );
    }

    #[test]
    fn omits_reasoning_for_older_models() {
        let update = spokesperson_session_update(&RealtimeSpokespersonSessionOptions {
            model: Some("gpt-realtime-1.5".into()),
            reasoning_effort: Some(RealtimeReasoningEffort::High),
            ..Default::default()
        });
        assert!(update["session"].get("reasoning").is_none());
    }

    #[test]
    fn reduces_interrupted_spokesperson_to_an_explicit_best_effort_transcript() {
        let mut reducer = RealtimeProtocolReducer::default();
        assert_eq!(
            reducer
                .handle(&json!({
                    "type": "response.output_audio_transcript.delta",
                    "response_id": "response-1",
                    "item_id": "assistant-1",
                    "delta": "The heard prefix",
                }))
                .unwrap(),
            vec![RealtimeProtocolEvent::TranscriptUpdated {
                item_id: "assistant-1".into(),
                speaker: RealtimeTranscriptSpeaker::Spokesperson,
                text: "The heard prefix".into(),
            }]
        );
        assert_eq!(
            reducer
                .handle(&json!({
                    "type": "output_audio_buffer.cleared",
                    "response_id": "response-1",
                }))
                .unwrap(),
            vec![
                RealtimeProtocolEvent::TranscriptFinalized {
                    id: 1,
                    item_id: "assistant-1".into(),
                    speaker: RealtimeTranscriptSpeaker::Spokesperson,
                    text: "The heard prefix".into(),
                    interrupted: true,
                    evidence: RealtimeTranscriptEvidence::ProviderDelta,
                    expert_message: "[Voice transcript] Spokesperson said (interrupted; best effort): The heard prefix".into(),
                },
                RealtimeProtocolEvent::PlaybackInterrupted {
                    response_id: "response-1".into(),
                },
            ]
        );
    }

    #[test]
    fn native_playback_frames_bound_the_interrupted_spokesperson_transcript() {
        let mut reducer = RealtimeProtocolReducer::default();
        reducer
            .handle(&json!({
                "type": "response.output_audio_transcript.delta",
                "response_id": "response-1",
                "item_id": "assistant-1",
                "delta": "One two three four",
            }))
            .unwrap();

        assert!(matches!(
            reducer
                .handle(&json!({
                    "type": "output_audio_buffer.cleared",
                    "response_id": "response-1",
                    "played_audio_frames": 12_000,
                    "total_audio_frames": 24_000,
                    "sample_rate": 24_000,
                }))
                .unwrap()
                .as_slice(),
            [RealtimeProtocolEvent::TranscriptFinalized {
                text,
                evidence: RealtimeTranscriptEvidence::HostPlayedFrames,
                ..
            }, RealtimeProtocolEvent::PlaybackInterrupted { .. }] if text == "One two"
        ));
    }

    #[test]
    fn combines_multiple_spokesperson_audio_items_in_provider_order() {
        let mut reducer = RealtimeProtocolReducer::default();
        for (item_id, text) in [("assistant-1", "First."), ("assistant-2", "Second.")] {
            reducer
                .handle(&json!({
                    "type": "response.output_audio_transcript.delta",
                    "response_id": "response-1",
                    "item_id": item_id,
                    "delta": text,
                }))
                .unwrap();
            reducer
                .handle(&json!({
                    "type": "response.output_audio_transcript.done",
                    "response_id": "response-1",
                    "item_id": item_id,
                    "transcript": text,
                }))
                .unwrap();
        }
        assert_eq!(
            reducer
                .handle(&json!({
                    "type": "output_audio_buffer.stopped",
                    "response_id": "response-1",
                }))
                .unwrap(),
            vec![RealtimeProtocolEvent::TranscriptFinalized {
                id: 1,
                item_id: "assistant-1".into(),
                speaker: RealtimeTranscriptSpeaker::Spokesperson,
                text: "First. Second.".into(),
                interrupted: false,
                evidence: RealtimeTranscriptEvidence::ProviderFinal,
                expert_message: "[Voice transcript] Spokesperson said: First. Second.".into(),
            }]
        );
    }

    #[test]
    fn assembles_and_validates_handoff_function_calls_once() {
        let mut reducer = RealtimeProtocolReducer::default();
        reducer
            .handle(&json!({
                "type": "response.output_item.added",
                "item": { "type": "function_call", "call_id": "call-1", "name": "handoff" },
            }))
            .unwrap();
        reducer
            .handle(&json!({
                "type": "response.function_call_arguments.delta",
                "call_id": "call-1",
                "delta": "{\"message\":\"Inspect ",
            }))
            .unwrap();
        reducer
            .handle(&json!({
                "type": "response.function_call_arguments.delta",
                "call_id": "call-1",
                "delta": "the project\"}",
            }))
            .unwrap();
        let done = json!({
            "type": "response.function_call_arguments.done",
            "call_id": "call-1",
        });
        assert_eq!(
            reducer.handle(&done).unwrap(),
            vec![RealtimeProtocolEvent::Handoff {
                response_id: None,
                call_id: "call-1".into(),
                message: "Inspect the project".into(),
            }]
        );
        assert!(reducer.handle(&done).unwrap().is_empty());
    }

    #[test]
    fn queues_expert_say_until_the_active_response_and_playback_finish() {
        let mut coordinator = RealtimeResponseCoordinator::default();
        coordinator
            .handle(&json!({ "type": "response.created", "response": { "id": "routine" } }))
            .unwrap();
        coordinator
            .handle(&json!({ "type": "output_audio_buffer.started", "response_id": "routine" }))
            .unwrap();
        let request = coordinator
            .request_expert_message(RealtimeExpertMessage {
                message: "The answer is 21.".into(),
                mode: RealtimeExpertMessageMode::Say,
                event_id: Some("expert-1".into()),
                resolved_handoff_ids: vec!["handoff-1".into()],
            })
            .unwrap();
        assert_eq!(request.status, RealtimeRequestStatus::Queued);
        assert_eq!(request.events.len(), 1);
        assert!(coordinator
            .handle(&json!({ "type": "response.done", "response": { "id": "routine", "status": "completed" } }))
            .unwrap()
            .events
            .is_empty());
        let update = coordinator
            .handle(&json!({ "type": "output_audio_buffer.stopped", "response_id": "routine" }))
            .unwrap();
        assert_eq!(update.events[0]["type"], "response.create");
    }

    #[test]
    fn reports_resolved_handoff_only_after_successful_say_playback() {
        let mut coordinator = RealtimeResponseCoordinator::default();
        coordinator
            .request_expert_message(RealtimeExpertMessage {
                message: "Done.".into(),
                mode: RealtimeExpertMessageMode::Say,
                event_id: None,
                resolved_handoff_ids: vec!["handoff-1".into()],
            })
            .unwrap();
        coordinator
            .handle(&json!({ "type": "response.created", "response": { "id": "expert" } }))
            .unwrap();
        coordinator
            .handle(&json!({ "type": "output_audio_buffer.started", "response_id": "expert" }))
            .unwrap();
        assert!(coordinator
            .handle(&json!({ "type": "response.done", "response": { "id": "expert", "status": "completed" } }))
            .unwrap()
            .completed_handoff_ids
            .is_empty());
        let update = coordinator
            .handle(&json!({ "type": "output_audio_buffer.stopped", "response_id": "expert" }))
            .unwrap();
        assert_eq!(update.completed_handoff_ids, vec!["handoff-1"]);
    }

    #[test]
    fn reduces_user_transcript_lifecycle_once() {
        let mut reducer = RealtimeProtocolReducer::default();
        assert_eq!(
            reducer
                .handle(&json!({
                    "type": "input_audio_buffer.speech_started",
                    "item_id": "user-1",
                }))
                .unwrap(),
            vec![RealtimeProtocolEvent::TranscriptStarted {
                item_id: "user-1".into(),
                speaker: RealtimeTranscriptSpeaker::User,
            }]
        );
        reducer
            .handle(&json!({
                "type": "conversation.item.input_audio_transcription.delta",
                "item_id": "user-1",
                "delta": "Hello",
            }))
            .unwrap();
        let completed = json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "user-1",
            "transcript": "Hello there",
        });
        assert!(matches!(
            reducer.handle(&completed).unwrap().as_slice(),
            [RealtimeProtocolEvent::TranscriptFinalized {
                speaker: RealtimeTranscriptSpeaker::User,
                text,
                evidence: RealtimeTranscriptEvidence::ProviderFinal,
                ..
            }] if text == "Hello there"
        ));
        assert!(reducer.handle(&completed).unwrap().is_empty());
    }

    #[test]
    fn surfaces_provider_and_transcription_errors() {
        let mut reducer = RealtimeProtocolReducer::default();
        assert_eq!(
            reducer
                .handle(&json!({ "type": "error", "error": { "message": "bad session" } }))
                .unwrap_err(),
            "bad session"
        );
        assert_eq!(
            reducer
                .handle(&json!({
                    "type": "conversation.item.input_audio_transcription.failed",
                    "message": "bad transcript",
                }))
                .unwrap_err(),
            "bad transcript"
        );
    }

    #[test]
    fn typed_user_message_interrupts_active_generation_and_playback() {
        let mut coordinator = RealtimeResponseCoordinator::default();
        coordinator
            .request_expert_message(RealtimeExpertMessage {
                message: "Answer.".into(),
                mode: RealtimeExpertMessageMode::Say,
                event_id: None,
                resolved_handoff_ids: Vec::new(),
            })
            .unwrap();
        coordinator
            .handle(&json!({ "type": "response.created", "response": { "id": "response-1" } }))
            .unwrap();
        coordinator
            .handle(&json!({ "type": "output_audio_buffer.started", "response_id": "response-1" }))
            .unwrap();

        let request = coordinator
            .request_typed_user_message("New direction")
            .unwrap();
        assert_eq!(request.status, RealtimeRequestStatus::Interrupting);
        assert_eq!(
            request
                .events
                .iter()
                .filter_map(|event| event["type"].as_str())
                .collect::<Vec<_>>(),
            vec![
                "response.cancel",
                "output_audio_buffer.clear",
                "input_audio_buffer.clear",
                "conversation.item.create",
            ]
        );
    }

    #[test]
    fn server_created_response_supersedes_the_active_response() {
        let mut coordinator = RealtimeResponseCoordinator::default();
        coordinator
            .request_expert_message(RealtimeExpertMessage {
                message: "Answer.".into(),
                mode: RealtimeExpertMessageMode::Say,
                event_id: None,
                resolved_handoff_ids: vec!["handoff-1".into()],
            })
            .unwrap();
        coordinator
            .handle(&json!({ "type": "response.created", "response": { "id": "response-1" } }))
            .unwrap();
        let update = coordinator
            .handle(&json!({ "type": "response.created", "response": { "id": "response-2" } }))
            .unwrap();
        assert_eq!(update.failed_handoff_ids, vec!["handoff-1"]);
    }

    #[test]
    fn successful_generation_without_played_audio_does_not_resolve_handoff() {
        let mut coordinator = RealtimeResponseCoordinator::default();
        coordinator
            .request_expert_message(RealtimeExpertMessage {
                message: "Answer.".into(),
                mode: RealtimeExpertMessageMode::Say,
                event_id: None,
                resolved_handoff_ids: vec!["handoff-1".into()],
            })
            .unwrap();
        coordinator
            .handle(&json!({ "type": "response.created", "response": { "id": "response-1" } }))
            .unwrap();
        let update = coordinator
            .handle(&json!({
                "type": "response.done",
                "response": { "id": "response-1", "status": "completed" },
            }))
            .unwrap();
        assert!(update.completed_handoff_ids.is_empty());
        assert_eq!(update.failed_handoff_ids, vec!["handoff-1"]);
    }

    #[test]
    fn tool_output_response_waits_for_active_playback() {
        let mut coordinator = RealtimeResponseCoordinator::default();
        coordinator
            .handle(&json!({ "type": "response.created", "response": { "id": "response-1" } }))
            .unwrap();
        coordinator
            .handle(&json!({ "type": "output_audio_buffer.started", "response_id": "response-1" }))
            .unwrap();
        let request = coordinator.request_tool_output(
            json!({ "type": "conversation.item.create", "item": { "type": "function_call_output" } }),
            true,
        );
        assert_eq!(request.status, RealtimeRequestStatus::Queued);
        assert!(coordinator
            .handle(&json!({
                "type": "response.done",
                "response": { "id": "response-1", "status": "completed" },
            }))
            .unwrap()
            .events
            .is_empty());
        assert_eq!(
            coordinator
                .handle(
                    &json!({ "type": "output_audio_buffer.stopped", "response_id": "response-1" })
                )
                .unwrap()
                .events,
            vec![json!({ "type": "response.create" })]
        );
    }

    #[test]
    fn message_pipe_preserves_half_duplex_causal_batches() {
        let mut pipe = RealtimeMessagePipe::new(12_000_000);
        let first = pipe
            .send(RealtimePipePeer::Spokesperson, 12_000_000, "First detail.")
            .unwrap();
        let second = pipe
            .send(RealtimePipePeer::Spokesperson, 12_000_000, "Second detail.")
            .unwrap();
        assert!(matches!(
            first,
            RealtimePipeExchange::Accepted(RealtimePipeAccepted {
                outbound: RealtimePipeMessage { id: 12_000_001, .. },
                ..
            })
        ));
        assert!(matches!(
            pipe.send(RealtimePipePeer::Expert, 12_000_001, "Too soon.")
                .unwrap(),
            RealtimePipeExchange::Rejected(RealtimePipeRejected {
                reason: RealtimePipeRejection::PipeBusy,
                cursor: 12_000_000,
                ..
            })
        ));
        let latest_id = match second {
            RealtimePipeExchange::Accepted(accepted) => accepted.outbound.id,
            RealtimePipeExchange::Rejected(_) => panic!("second message was rejected"),
        };
        assert!(matches!(
            pipe.send(RealtimePipePeer::Expert, latest_id, "Reply.")
                .unwrap(),
            RealtimePipeExchange::Accepted(RealtimePipeAccepted {
                cursor: 12_000_002,
                outbound: RealtimePipeMessage {
                    sender_cursor: 12_000_002,
                    ..
                },
                ..
            })
        ));
        assert_eq!(
            pipe.delivery_cursor(RealtimePipePeer::Spokesperson),
            12_000_003
        );
    }

    #[test]
    fn interrupted_transcript_preserves_provider_delta_when_playback_is_remote() {
        assert_eq!(
            resolve_interrupted_spokesperson_transcript(
                RealtimeInterruptedTranscriptInput::ProviderDelta {
                    text: "Words generated before cancellation".into(),
                },
            ),
            (
                "Words generated before cancellation".into(),
                RealtimeTranscriptEvidence::ProviderDelta,
            )
        );
    }

    #[test]
    fn interrupted_transcript_uses_host_playback_across_ordered_audio_parts() {
        assert_eq!(
            resolve_interrupted_spokesperson_transcript(
                RealtimeInterruptedTranscriptInput::HostPlayedFrames {
                    text: "First complete part. Second partial part.".into(),
                    audio_parts: vec![
                        RealtimeTranscriptAudioPart {
                            text: "First complete part.".into(),
                            total_audio_frames: 12_000,
                        },
                        RealtimeTranscriptAudioPart {
                            text: "Second partial part.".into(),
                            total_audio_frames: 12_000,
                        },
                    ],
                    played_audio_frames: 18_000,
                    total_audio_frames: 24_000,
                    sample_rate: 24_000,
                },
            ),
            (
                "First complete part. Second".into(),
                RealtimeTranscriptEvidence::HostPlayedFrames,
            )
        );
    }

    #[test]
    fn shared_session_owns_handoff_reminders_and_exhaustion() {
        let mut session = RealtimeExpertSpokespersonSession::new(0);
        session
            .register_handoff("handoff-1", 7, "Inspect the project state")
            .unwrap();

        let first = session.complete_expert_turn(&[], 3);
        assert!(matches!(
            first,
            RealtimeHandoffReminder::Reminder {
                attempt: 1,
                ref handoff_ids,
                ref requests,
                ..
            } if handoff_ids == &["handoff-1"] && requests.contains("Inspect the project state")
        ));
        assert!(matches!(
            session.complete_expert_turn(&["handoff-1".into()], 3),
            RealtimeHandoffReminder::Reminder { attempt: 2, .. }
        ));
        assert!(matches!(
            session.complete_expert_turn(&["handoff-1".into()], 3),
            RealtimeHandoffReminder::Reminder { attempt: 3, .. }
        ));
        assert!(matches!(
            session.complete_expert_turn(&["handoff-1".into()], 3),
            RealtimeHandoffReminder::Exhausted { ref handoff_ids, .. }
                if handoff_ids == &["handoff-1"]
        ));
    }

    #[test]
    fn transcript_seed_is_bounded_to_a_user_led_tail_and_marks_interruptions() {
        let events = realtime_transcript_seed_events(
            vec![
                RealtimeTranscriptSeedTurn::Spokesperson {
                    text: "orphan".into(),
                    interrupted: false,
                },
                RealtimeTranscriptSeedTurn::User {
                    text: "question".into(),
                },
                RealtimeTranscriptSeedTurn::Spokesperson {
                    text: "partial answer".into(),
                    interrupted: true,
                },
                RealtimeTranscriptSeedTurn::Expert {
                    text: "private result".into(),
                },
            ],
            3,
            Some("session-1"),
        );

        assert_eq!(events.len(), 4);
        assert_eq!(events[0].pointer("/item/role"), Some(&json!("system")));
        assert_eq!(events[1].pointer("/item/role"), Some(&json!("user")));
        assert_eq!(
            events[2].pointer("/item/content/0/text"),
            Some(&json!("partial answer [interrupted]"))
        );
        assert_eq!(events[3].pointer("/item/role"), Some(&json!("system")));
        assert!(events[3]
            .pointer("/item/content/0/text")
            .and_then(Value::as_str)
            .is_some_and(|text| text.contains("Private Expert context")));
    }

    #[test]
    fn resolving_handoff_is_silent_until_playback_succeeds_or_fails() {
        let mut session = RealtimeExpertSpokespersonSession::new(0);
        session
            .register_handoff("handoff-1", 1, "Question")
            .unwrap();
        session
            .mark_handoffs_resolving(&["handoff-1".into()])
            .unwrap();
        assert_eq!(
            session.complete_expert_turn(&[], 3),
            RealtimeHandoffReminder::None
        );

        session
            .request_expert_message(RealtimeExpertMessage {
                message: "Answer".into(),
                mode: RealtimeExpertMessageMode::Say,
                event_id: None,
                resolved_handoff_ids: vec!["handoff-1".into()],
            })
            .unwrap();
        session
            .handle_provider_event(
                &json!({ "type": "response.created", "response": { "id": "response-1" } }),
            )
            .unwrap();
        session
            .handle_provider_event(
                &json!({ "type": "output_audio_buffer.started", "response_id": "response-1" }),
            )
            .unwrap();
        session
            .handle_provider_event(&json!({
                "type": "response.done",
                "response": { "id": "response-1", "status": "completed" },
            }))
            .unwrap();
        let reduction = session
            .handle_provider_event(
                &json!({ "type": "output_audio_buffer.stopped", "response_id": "response-1" }),
            )
            .unwrap();
        assert_eq!(reduction.completed_handoff_ids, ["handoff-1"]);
        assert_eq!(
            session.unknown_handoff_ids(&["handoff-1".into()]),
            ["handoff-1"]
        );
    }
}
