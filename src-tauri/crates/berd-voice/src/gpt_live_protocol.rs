use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::gpt_live_bridge::{
    BackendDirective, BackendDirectiveOutcome, BackendGptLiveCore, LiveSideEvent, SemanticTurn,
};
pub use crate::realtime_pipe::{
    RealtimeMessagePipe, RealtimePipeAccepted, RealtimePipeExchange, RealtimePipeMessage,
    RealtimePipePeer, RealtimePipeRejected, RealtimePipeRejection,
};
use crate::{estimated_spoken_through_utf8, DeliveryProgress, DeliverySegment};

const CLIENT_DELEGATION_MESSAGE: &str =
    "GPT Live delegated at this point. Handle the unresolved user need using the preceding transcript and durable context.";

pub const OPENAI_REALTIME_VOICE_IDS: &[&str] = &[
    "alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse",
];

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeGptLiveSessionOptions {
    pub voice: Option<String>,
}

pub fn backend_session_instructions(session_id: &str, initial_cursor: u64, call_id: &str) -> String {
    let session_id = serde_json::to_string(session_id).expect("session id is serializable");
    format!(
        "This session has a GPT Live voice conversation. GPT Live handles the conversation directly and delegates only when backend work is needed. When you receive a delegation, answer it and return the result to GPT Live with the provider's opaque delegation id. Use commentary when GPT Live should speak the result, or thinking for silent context. Preserve the newest cursor supplied with the delegation.\n\nSession: {session_id}\nLive call: {call_id}\nInitial cursor: {initial_cursor}\n\nberdctl session append-to-gpt-live --session-id {session_id} --cursor <cursor> --channel <commentary|thinking> --delegation-id <delegation-id> --message <message> --json"
    )
}

pub fn gpt_live_session_update(options: &RealtimeGptLiveSessionOptions) -> Value {
    json!({
        "type": "session.start",
        "session": {
            "model": "gpt-live-1",
            "audio": {
                "format": { "type": "audio/pcm", "rate": 24_000 },
                "output": {
                    "voice": options.voice.as_deref().unwrap_or("marin"),
                },
            },
            "delegation": { "type": "client" },
        },
    })
}


fn live_speaker_name(speaker: RealtimeTranscriptSpeaker) -> &'static str {
    match speaker {
        RealtimeTranscriptSpeaker::User => "user",
        RealtimeTranscriptSpeaker::GptLive => "gpt_live",
    }
}

pub fn gpt_live_append_event(
    message: &str,
    channel: GptLiveAppendChannel,
    delegation_id: Option<&str>,
) -> Result<Value, String> {
    let append_type = match channel {
        GptLiveAppendChannel::Commentary => "session.commentary.append",
        GptLiveAppendChannel::Thinking => "session.thinking.append",
    };
    let mut event = json!({
        "type": append_type,
        "content": require_non_empty(message, "GPT Live append")?,
    });
    if let Some(delegation_id) = delegation_id {
        event["delegation_id"] = require_non_empty(delegation_id, "delegation id")?.into();
    }
    Ok(event)
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum RealtimeTranscriptSeedTurn {
    User { text: String },
    GptLive { text: String, interrupted: bool },
    Backend { text: String },
}

pub fn realtime_transcript_seed_item(
    turn: RealtimeTranscriptSeedTurn,
    item_id: Option<&str>,
) -> Value {
    let (role, content_type, text) = match turn {
        RealtimeTranscriptSeedTurn::User { text } => ("user", "input_text", text),
        RealtimeTranscriptSeedTurn::GptLive { text, interrupted } => (
            "assistant",
            "output_text",
            if interrupted {
                format!("{text} [interrupted]")
            } else {
                text
            },
        ),
        RealtimeTranscriptSeedTurn::Backend { text } => (
            "system",
            "input_text",
            format!("Private Backend context; do not respond now:\n{text}"),
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
                        "This voice conversation is being resumed from Berd session {session_id}. Durable session link: berd://session/{session_id}. The following items are a compact recent transcript, not new turns. Ask the Backend to inspect the durable session when older context is needed."
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
#[serde(rename_all = "snake_case")]
pub enum RealtimeTranscriptSpeaker {
    User,
    GptLive,
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

/// Resolve the safest publishable transcript after GptLive playback is
/// interrupted. The policy is shared; each transport supplies the strongest
/// evidence it can observe.
pub fn resolve_interrupted_gpt_live_transcript(
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
        backend_message: String,
    },
    #[serde(rename = "transcript.settled", rename_all = "camelCase")]
    TranscriptSettled {
        item_id: String,
        speaker: RealtimeTranscriptSpeaker,
        text: String,
    },
    #[serde(rename = "handoff", rename_all = "camelCase")]
    Handoff {
        #[serde(skip_serializing_if = "Option::is_none")]
        response_id: Option<String>,
        call_id: String,
        message: String,
    },
    #[serde(rename = "gpt_live.playback_interrupted", rename_all = "camelCase")]
    PlaybackInterrupted { response_id: String },
}

#[derive(Debug, Default)]
struct PendingGptLiveTranscriptItem {
    streamed_text: String,
    final_text: Option<String>,
}

#[derive(Debug)]
struct PendingGptLiveTranscript {
    display_item_id: String,
    item_order: Vec<String>,
    items: HashMap<String, PendingGptLiveTranscriptItem>,
}

#[derive(Debug)]
struct PendingLiveTranscript {
    item_id: String,
    text: String,
    last_end_ms: u64,
}

#[derive(Debug)]
pub struct RealtimeProtocolReducer {
    next_transcript_id: u64,
    finalized_item_ids: HashSet<String>,
    pending_user_transcripts: HashMap<String, String>,
    pending_gpt_live_transcripts: HashMap<String, PendingGptLiveTranscript>,
    interrupted_response_ids: HashSet<String>,
    pending_live_input: Option<PendingLiveTranscript>,
    pending_live_output: Option<PendingLiveTranscript>,
    next_live_item_id: u64,
}

impl Default for RealtimeProtocolReducer {
    fn default() -> Self {
        Self {
            next_transcript_id: 1,
            finalized_item_ids: HashSet::new(),
            pending_user_transcripts: HashMap::new(),
            pending_gpt_live_transcripts: HashMap::new(),
            interrupted_response_ids: HashSet::new(),
            pending_live_input: None,
            pending_live_output: None,
            next_live_item_id: 1,
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
                self.capture_gpt_live_transcript_delta(event)
            }
            "response.output_audio_transcript.done" => {
                self.capture_gpt_live_transcript_final(event);
                Ok(Vec::new())
            }
            "session.input_transcript.delta" => {
                self.capture_live_transcript_delta(event, RealtimeTranscriptSpeaker::User)
            }
            "session.output_transcript.delta" => {
                self.capture_live_transcript_delta(event, RealtimeTranscriptSpeaker::GptLive)
            }
            "session.delegation.created" => self.capture_client_delegation(event),
            "session.closed" => Ok(self.finish_all_live_transcripts(false)),
            "output_audio_buffer.stopped" if self.pending_live_output.is_some() => {
                Ok(self.settle_live_output().into_iter().collect())
            }
            "output_audio_buffer.cleared" if self.pending_live_output.is_some() => Ok(self
                .finish_live_transcript(RealtimeTranscriptSpeaker::GptLive, true)
                .into_iter()
                .collect()),
            "output_audio_buffer.stopped" => self.finish_gpt_live_playback(event, false),
            "output_audio_buffer.cleared" => self.finish_gpt_live_playback(event, true),
            _ => Ok(Vec::new()),
        }
    }

    fn capture_live_transcript_delta(
        &mut self,
        event: &Value,
        speaker: RealtimeTranscriptSpeaker,
    ) -> Result<Vec<RealtimeProtocolEvent>, String> {
        let Some(delta) = string_at(event, "/delta") else {
            return Ok(Vec::new());
        };
        if delta.is_empty() {
            return Ok(Vec::new());
        }
        let start_ms = event.get("start_ms").and_then(Value::as_u64).unwrap_or(0);
        let end_ms = event
            .get("end_ms")
            .and_then(Value::as_u64)
            .unwrap_or(start_ms);
        let mut events = Vec::new();
        let other = match speaker {
            RealtimeTranscriptSpeaker::User => RealtimeTranscriptSpeaker::GptLive,
            RealtimeTranscriptSpeaker::GptLive => RealtimeTranscriptSpeaker::User,
        };
        if self.pending_live_transcript(other).is_some() {
            if let Some(event) = self.finish_live_transcript(other, false) {
                events.push(event);
            }
        }
        if self.pending_live_transcript(speaker).is_none() {
            let item_id = format!(
                "live-{}-{}",
                live_speaker_name(speaker),
                self.next_live_item_id
            );
            self.next_live_item_id = self.next_live_item_id.saturating_add(1);
            *self.pending_live_transcript(speaker) = Some(PendingLiveTranscript {
                item_id: item_id.clone(),
                text: String::new(),
                last_end_ms: end_ms,
            });
            events.push(RealtimeProtocolEvent::TranscriptStarted { item_id, speaker });
        }
        let pending = self
            .pending_live_transcript(speaker)
            .as_mut()
            .expect("live transcript exists");
        pending.text.push_str(delta);
        pending.last_end_ms = pending.last_end_ms.max(end_ms);
        events.push(RealtimeProtocolEvent::TranscriptUpdated {
            item_id: pending.item_id.clone(),
            speaker,
            text: pending.text.clone(),
        });
        Ok(events)
    }

    fn capture_client_delegation(
        &mut self,
        event: &Value,
    ) -> Result<Vec<RealtimeProtocolEvent>, String> {
        if string_at(event, "/delegation/target") != Some("client") {
            return Ok(Vec::new());
        }
        let delegation_id = string_at(event, "/delegation/id")
            .ok_or_else(|| "client delegation is missing delegation.id".to_string())?;
        let mut events = self.finish_all_live_transcripts(false);
        events.push(RealtimeProtocolEvent::Handoff {
            response_id: None,
            call_id: delegation_id.to_string(),
            message: CLIENT_DELEGATION_MESSAGE.into(),
        });
        Ok(events)
    }

    fn pending_live_transcript(
        &mut self,
        speaker: RealtimeTranscriptSpeaker,
    ) -> &mut Option<PendingLiveTranscript> {
        match speaker {
            RealtimeTranscriptSpeaker::User => &mut self.pending_live_input,
            RealtimeTranscriptSpeaker::GptLive => &mut self.pending_live_output,
        }
    }

    fn finish_live_transcript(
        &mut self,
        speaker: RealtimeTranscriptSpeaker,
        interrupted: bool,
    ) -> Option<RealtimeProtocolEvent> {
        let pending = self.pending_live_transcript(speaker).take()?;
        let text = pending.text.trim();
        if text.is_empty() {
            return None;
        }
        Some(self.finalized_transcript(
            &pending.item_id,
            speaker,
            text,
            interrupted,
            RealtimeTranscriptEvidence::ProviderDelta,
        ))
    }

    fn finish_all_live_transcripts(&mut self, interrupted: bool) -> Vec<RealtimeProtocolEvent> {
        let mut pending = [
            (
                RealtimeTranscriptSpeaker::User,
                self.pending_live_input
                    .as_ref()
                    .map(|transcript| transcript.last_end_ms),
            ),
            (
                RealtimeTranscriptSpeaker::GptLive,
                self.pending_live_output
                    .as_ref()
                    .map(|transcript| transcript.last_end_ms),
            ),
        ];
        pending.sort_by_key(|(_, end_ms)| end_ms.unwrap_or(u64::MAX));
        pending
            .into_iter()
            .filter_map(|(speaker, _)| self.finish_live_transcript(speaker, interrupted))
            .collect()
    }

    pub fn flush_live_transcripts(&mut self) -> Vec<RealtimeProtocolEvent> {
        self.finish_all_live_transcripts(false)
    }

    fn settle_live_output(&self) -> Option<RealtimeProtocolEvent> {
        let pending = self.pending_live_output.as_ref()?;
        let text = pending.text.trim();
        (!text.is_empty()).then(|| RealtimeProtocolEvent::TranscriptSettled {
            item_id: pending.item_id.clone(),
            speaker: RealtimeTranscriptSpeaker::GptLive,
            text: text.into(),
        })
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

    fn capture_gpt_live_transcript_delta(
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
        let pending = self.pending_gpt_live_transcript(response_id, item_id);
        pending
            .items
            .get_mut(item_id)
            .expect("new item was inserted")
            .streamed_text
            .push_str(delta);
        let text = combined_gpt_live_transcript(pending, false);
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![RealtimeProtocolEvent::TranscriptUpdated {
            item_id: pending.display_item_id.clone(),
            speaker: RealtimeTranscriptSpeaker::GptLive,
            text,
        }])
    }

    fn capture_gpt_live_transcript_final(&mut self, event: &Value) {
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
        self.pending_gpt_live_transcript(response_id, item_id)
            .items
            .get_mut(item_id)
            .expect("new item was inserted")
            .final_text = Some(text.into());
    }

    fn finish_gpt_live_playback(
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
        let pending = self.pending_gpt_live_transcripts.remove(response_id);
        let mut events = Vec::new();
        if let Some(pending) = pending {
            let mut text = combined_gpt_live_transcript(&pending, !interrupted);
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
                let resolved = resolve_interrupted_gpt_live_transcript(input);
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
                    RealtimeTranscriptSpeaker::GptLive,
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

    fn pending_gpt_live_transcript(
        &mut self,
        response_id: &str,
        item_id: &str,
    ) -> &mut PendingGptLiveTranscript {
        let pending = self
            .pending_gpt_live_transcripts
            .entry(response_id.into())
            .or_insert_with(|| PendingGptLiveTranscript {
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
            backend_message: backend_transcript_message(speaker, text, interrupted),
        }
    }
}

pub fn backend_transcript_message(
    speaker: RealtimeTranscriptSpeaker,
    text: &str,
    interrupted: bool,
) -> String {
    match (speaker, interrupted) {
        (RealtimeTranscriptSpeaker::User, _) => {
            format!("[Voice transcript] User said: {text}")
        }
        (RealtimeTranscriptSpeaker::GptLive, false) => {
            format!("[Voice transcript] GptLive said: {text}")
        }
        (RealtimeTranscriptSpeaker::GptLive, true) => {
            format!("[Voice transcript] GptLive said (interrupted; best effort): {text}")
        }
    }
}

pub fn backend_handoff_message(handoff_id: &str, cursor: u64, message: &str) -> String {
    format!("[Delegation {handoff_id} from GPT Live; cursor {cursor}] {message}")
}

fn transcript_delivery_event(
    cursor: u64,
    speaker: RealtimeTranscriptSpeaker,
    text: &str,
    interrupted: bool,
) -> RealtimeBackendDeliveryEvent {
    let role = match (speaker, interrupted) {
        (RealtimeTranscriptSpeaker::User, _) => RealtimeBackendDeliveryRole::User,
        (RealtimeTranscriptSpeaker::GptLive, false) => {
            RealtimeBackendDeliveryRole::GptLive
        }
        (RealtimeTranscriptSpeaker::GptLive, true) => {
            RealtimeBackendDeliveryRole::GptLiveInterrupted
        }
    };
    RealtimeBackendDeliveryEvent {
        cursor,
        role,
        text: text.into(),
        handoff_id: None,
    }
}

fn handoff_delivery_event(
    cursor: u64,
    handoff_id: &str,
    message: &str,
) -> RealtimeBackendDeliveryEvent {
    RealtimeBackendDeliveryEvent {
        cursor,
        role: RealtimeBackendDeliveryRole::Handoff,
        text: message.into(),
        handoff_id: Some(handoff_id.into()),
    }
}

fn combined_gpt_live_transcript(
    pending: &PendingGptLiveTranscript,
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GptLiveAppendChannel {
    Commentary,
    Thinking,
}

/// Transport-independent state for one GPT Live client-delegation session.
/// Native Berd and external adapters own only
/// their transport and presentation concerns around this core.
#[derive(Debug)]
pub struct RealtimeBackendGptLiveSession {
    reducer: RealtimeProtocolReducer,
    conversation: BackendGptLiveCore,
    open_handoffs: HashSet<String>,
    call_scope: String,
    pending_backend_events: Vec<RealtimeBackendDeliveryEvent>,
    client_transcript_since_delegation: Vec<RealtimeBackendDeliveryEvent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeSessionReduction {
    pub protocol_events: Vec<RealtimeProtocolEvent>,
    pub client_events: Vec<Value>,
    pub backend_delivery: Option<RealtimeBackendDelivery>,
    pub accepted_handoffs: Vec<RealtimeAcceptedHandoff>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeBackendDelivery {
    pub events: Vec<RealtimeBackendDeliveryEvent>,
    pub display_text: String,
    pub handoff_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeBackendDeliveryRole {
    User,
    GptLive,
    GptLiveInterrupted,
    Handoff,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeBackendDeliveryEvent {
    pub cursor: u64,
    pub role: RealtimeBackendDeliveryRole,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeAcceptedHandoff {
    pub handoff_id: String,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct RealtimeBackendMessageSubmission {
    pub exchange: RealtimePipeExchange,
    pub event: Option<Value>,
}

impl RealtimeBackendGptLiveSession {
    pub fn new(initial_cursor: u64, call_scope: impl Into<String>) -> Self {
        Self {
            reducer: RealtimeProtocolReducer::default(),
            conversation: BackendGptLiveCore::new(initial_cursor),
            open_handoffs: HashSet::new(),
            call_scope: call_scope.into(),
            pending_backend_events: Vec::new(),
            client_transcript_since_delegation: Vec::new(),
        }
    }

    pub fn handle_provider_event(
        &mut self,
        event: &Value,
    ) -> Result<RealtimeSessionReduction, String> {
        let protocol_events = self.reducer.handle(event)?;
        let mut backend_delivery = None;
        let mut accepted_handoffs = Vec::new();
        for protocol_event in &protocol_events {
            match protocol_event {
                RealtimeProtocolEvent::TranscriptFinalized {
                    speaker,
                    text,
                    interrupted,
                    ..
                } => {
                    let live_event = match speaker {
                        RealtimeTranscriptSpeaker::User => {
                            LiveSideEvent::UserTranscript { text: text.clone() }
                        }
                        RealtimeTranscriptSpeaker::GptLive => {
                            LiveSideEvent::GptLiveTranscript {
                                text: text.clone(),
                                interrupted: *interrupted,
                            }
                        }
                    };
                    let cursor = self.enqueue_live_message(live_event)?;
                    match speaker {
                        RealtimeTranscriptSpeaker::User => {
                            self.conversation.record_user_turn(text.clone());
                        }
                        RealtimeTranscriptSpeaker::GptLive => {
                            self.conversation
                                .record_gpt_live_turn(text.clone(), *interrupted);
                        }
                    }
                    let backend_event =
                        transcript_delivery_event(cursor, *speaker, text, *interrupted);
                    self.remember_client_transcript(backend_event);
                }
                RealtimeProtocolEvent::Handoff {
                    response_id: _,
                    call_id,
                    message,
                } => {
                    let (_, handoff_id, backend_event) =
                        self.record_handoff_with_id(call_id, message)?;
                    self.pending_backend_events
                        .append(&mut self.client_transcript_since_delegation);
                    self.pending_backend_events.push(backend_event);
                    accepted_handoffs.push(RealtimeAcceptedHandoff {
                        handoff_id: handoff_id.clone(),
                        message: message.clone(),
                    });
                    backend_delivery = self.take_backend_delivery(message, vec![handoff_id]);
                }
                _ => {}
            }
        }
        Ok(RealtimeSessionReduction {
            protocol_events,
            client_events: Vec::new(),
            backend_delivery,
            accepted_handoffs,
        })
    }

    pub fn flush_backend_events(&mut self, display_text: &str) -> Option<RealtimeBackendDelivery> {
        let _ = display_text;
        None
    }

    fn remember_client_transcript(&mut self, event: RealtimeBackendDeliveryEvent) {
        self.client_transcript_since_delegation.push(event);
    }

    fn take_backend_delivery(
        &mut self,
        display_text: &str,
        handoff_ids: Vec<String>,
    ) -> Option<RealtimeBackendDelivery> {
        if self.pending_backend_events.is_empty() {
            return None;
        }
        Some(RealtimeBackendDelivery {
            events: std::mem::take(&mut self.pending_backend_events),
            display_text: display_text.into(),
            handoff_ids,
        })
    }

    fn enqueue_live_message(&mut self, event: LiveSideEvent) -> Result<u64, String> {
        Ok(self.conversation.record_live_event(event)?.token)
    }

    pub fn send_backend_pipe_message(
        &mut self,
        cursor: u64,
        message: &str,
    ) -> Result<RealtimePipeExchange, String> {
        self.conversation.send_backend_message(cursor, message)
    }

    pub fn backend_pipe_cursor(&self) -> u64 {
        self.conversation.confirmed_token()
    }

    pub fn prepare_backend_directive(
        &mut self,
        acknowledgement: Option<u64>,
        message: String,
    ) -> BackendDirectiveOutcome {
        let directive = BackendDirective {
            acknowledgement,
            message,
        };
        let outcome = self.conversation.prepare_directive(directive.clone());
        let BackendDirectiveOutcome::Pending(events) = &outcome else {
            return outcome;
        };
        let Some(last) = events.last() else {
            return outcome;
        };
        if !events
            .iter()
            .all(|event| matches!(event.payload, LiveSideEvent::GptLiveTranscript { .. }))
        {
            return outcome;
        }
        self.conversation.prepare_directive(BackendDirective {
            acknowledgement: Some(last.token),
            message: directive.message,
        })
    }

    pub fn record_live_event_with_delivery(
        &mut self,
        event: LiveSideEvent,
    ) -> Result<
        (
            crate::causal_inbox::CausalMessage<LiveSideEvent>,
            Option<RealtimeBackendDelivery>,
        ),
        String,
    > {
        if let LiveSideEvent::Handoff { message, .. } = &event {
            let (recorded, handoff_id, backend_event) = self.record_handoff(message)?;
            self.pending_backend_events.push(backend_event);
            let delivery = self.take_backend_delivery(message, vec![handoff_id]);
            return Ok((recorded, delivery));
        }
        let recorded = self.conversation.record_live_event(event)?;
        let (backend_event, display_text, handoff_ids, flush) = match &recorded.payload {
            LiveSideEvent::UserTranscript { text } => (
                transcript_delivery_event(
                    recorded.token,
                    RealtimeTranscriptSpeaker::User,
                    text,
                    false,
                ),
                text.clone(),
                Vec::new(),
                false,
            ),
            LiveSideEvent::GptLiveTranscript { text, interrupted } => (
                transcript_delivery_event(
                    recorded.token,
                    RealtimeTranscriptSpeaker::GptLive,
                    text,
                    *interrupted,
                ),
                text.clone(),
                Vec::new(),
                true,
            ),
            LiveSideEvent::Handoff { .. } => unreachable!("handoffs return above"),
        };
        self.pending_backend_events.push(backend_event);
        let delivery = flush
            .then(|| self.take_backend_delivery(&display_text, handoff_ids))
            .flatten();
        Ok((recorded, delivery))
    }

    pub fn add_live_event(
        &mut self,
        token: u64,
        event: LiveSideEvent,
    ) -> Result<(), crate::causal_inbox::InvalidCausalToken> {
        self.conversation.add_live_event(token, event)
    }

    pub fn events_after(
        &self,
        token: u64,
    ) -> Vec<crate::causal_inbox::CausalMessage<LiveSideEvent>> {
        self.conversation.events_after(token)
    }

    pub fn has_unresolved_handoff(&self) -> bool {
        !self.open_handoffs.is_empty()
    }

    pub fn reserve_gpt_live_turn(&mut self, response_id: String) {
        self.conversation.reserve_gpt_live_turn(response_id);
    }

    pub fn finish_gpt_live_turn(&mut self, response_id: &str, text: String, interrupted: bool) {
        self.conversation
            .finish_gpt_live_turn(response_id, text, interrupted);
    }

    pub fn record_user_turn(&mut self, text: String) {
        self.conversation.record_user_turn(text);
    }

    pub fn record_backend_turn(&mut self, text: String) {
        self.conversation.record_backend_turn(text);
    }

    pub fn semantic_revision(&self) -> u64 {
        self.conversation.semantic_revision()
    }

    pub fn semantic_transcript(&self) -> Vec<SemanticTurn> {
        self.conversation.semantic_transcript()
    }

    pub fn unresolved_handoff_ids(&self) -> Vec<String> {
        self.open_handoffs.iter().cloned().collect()
    }

    pub fn request_typed_user_message(&mut self, text: &str) -> Result<Vec<Value>, String> {
        let text = require_non_empty(text, "user text")?;
        Ok(vec![json!({
                "type": "session.thinking.append",
                "content": format!("The user typed this message in the durable chat: {text}"),
            })])
    }

    fn register_handoff(
        &mut self,
        handoff_id: &str,
        cursor: u64,
        message: &str,
    ) -> Result<String, String> {
        let handoff_id = require_non_empty(handoff_id, "handoff id")?;
        let message = require_non_empty(message, "handoff message")?;
        let backend_message = backend_handoff_message(&handoff_id, cursor, &message);
        self.open_handoffs.insert(handoff_id);
        Ok(backend_message)
    }

    fn record_handoff(
        &mut self,
        message: &str,
    ) -> Result<
        (
            crate::causal_inbox::CausalMessage<LiveSideEvent>,
            String,
            RealtimeBackendDeliveryEvent,
        ),
        String,
    > {
        let cursor = self.conversation.next_live_token();
        let handoff_id = format!("handoff-{}-{cursor}", self.call_scope);
        let event = LiveSideEvent::Handoff {
            call_id: handoff_id.clone(),
            message: message.to_string(),
        };
        let recorded = self.conversation.record_live_event(event)?;
        debug_assert_eq!(recorded.token, cursor);
        self.register_handoff(&handoff_id, cursor, message)?;
        let backend_event = handoff_delivery_event(cursor, &handoff_id, message);
        Ok((recorded, handoff_id, backend_event))
    }

    fn record_handoff_with_id(
        &mut self,
        handoff_id: &str,
        message: &str,
    ) -> Result<
        (
            crate::causal_inbox::CausalMessage<LiveSideEvent>,
            String,
            RealtimeBackendDeliveryEvent,
        ),
        String,
    > {
        let handoff_id = require_non_empty(handoff_id, "handoff id")?;
        let cursor = self.conversation.next_live_token();
        let event = LiveSideEvent::Handoff {
            call_id: handoff_id.clone(),
            message: message.to_string(),
        };
        let recorded = self.conversation.record_live_event(event)?;
        debug_assert_eq!(recorded.token, cursor);
        self.register_handoff(&handoff_id, cursor, message)?;
        let backend_event = handoff_delivery_event(cursor, &handoff_id, message);
        Ok((recorded, handoff_id, backend_event))
    }

    pub fn unknown_handoff_ids(&self, handoff_ids: &[String]) -> Vec<String> {
        handoff_ids
            .iter()
            .filter(|handoff_id| !self.open_handoffs.contains(*handoff_id))
            .cloned()
            .collect()
    }

    fn resolve_handoffs(&mut self, handoff_ids: &[String]) -> Result<(), String> {
        let unknown = self.unknown_handoff_ids(handoff_ids);
        if !unknown.is_empty() {
            return Err(format!("unknown handoff: {}", unknown.join(", ")));
        }
        for handoff_id in handoff_ids {
            self.open_handoffs.remove(handoff_id);
        }
        Ok(())
    }

    pub fn submit_backend_message(
        &mut self,
        cursor: u64,
        message: &str,
        channel: GptLiveAppendChannel,
        resolved_handoff_ids: &[String],
    ) -> Result<RealtimeBackendMessageSubmission, String> {
        let unknown = self.unknown_handoff_ids(resolved_handoff_ids);
        if !unknown.is_empty() {
            return Err(format!("unknown handoff: {}", unknown.join(", ")));
        }
        let exchange = self.send_backend_pipe_message(cursor, message)?;
        let RealtimePipeExchange::Accepted(_) = &exchange else {
            return Ok(RealtimeBackendMessageSubmission {
                exchange,
                event: None,
            });
        };
        let delegation_id = resolved_handoff_ids.first().map(String::as_str);
        let event = gpt_live_append_event(message, channel, delegation_id)?;
        self.conversation.record_backend_turn(message.to_string());
        self.resolve_handoffs(resolved_handoff_ids)?;
        Ok(RealtimeBackendMessageSubmission {
            exchange,
            event: Some(event),
        })
    }
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
    use serde_json::json;

    use super::{
        gpt_live_session_update, RealtimeGptLiveSessionOptions, RealtimeProtocolEvent,
        RealtimeProtocolReducer, RealtimeTranscriptSpeaker,
    };

    #[test]
    fn starts_gpt_live_with_client_delegation_and_no_custom_instructions() {
        let event = gpt_live_session_update(&RealtimeGptLiveSessionOptions {
            voice: Some("cedar".into()),
        });

        assert_eq!(event["type"], "session.start");
        assert_eq!(event["session"]["model"], "gpt-live-1");
        assert_eq!(event["session"]["delegation"]["type"], "client");
        assert_eq!(event["session"]["audio"]["output"]["voice"], "cedar");
        assert!(event["session"].get("instructions").is_none());
    }

    #[test]
    fn serializes_transcript_speakers_for_the_client_contract() {
        assert_eq!(
            serde_json::to_value(RealtimeTranscriptSpeaker::User).unwrap(),
            json!("user")
        );
        assert_eq!(
            serde_json::to_value(RealtimeTranscriptSpeaker::GptLive).unwrap(),
            json!("gpt_live")
        );
    }

    #[test]
    fn keeps_one_output_turn_across_audio_stops_until_delegation() {
        let mut reducer = RealtimeProtocolReducer::default();
        let first = reducer
            .handle(&json!({
                "type": "session.output_transcript.delta",
                "delta": "A long answer "
            }))
            .unwrap();
        let item_id = match &first[0] {
            RealtimeProtocolEvent::TranscriptStarted {
                item_id,
                speaker: RealtimeTranscriptSpeaker::GptLive,
            } => item_id.clone(),
            event => panic!("unexpected first event: {event:?}"),
        };

        let stopped = reducer
            .handle(&json!({ "type": "output_audio_buffer.stopped" }))
            .unwrap();
        assert!(matches!(
            stopped.as_slice(),
            [RealtimeProtocolEvent::TranscriptSettled { item_id: settled, .. }] if settled == &item_id
        ));

        let resumed = reducer
            .handle(&json!({
                "type": "session.output_transcript.delta",
                "delta": "can arrive in several audio bursts."
            }))
            .unwrap();
        assert!(resumed.iter().all(|event| !matches!(
            event,
            RealtimeProtocolEvent::TranscriptStarted { .. }
        )));

        let delegated = reducer
            .handle(&json!({
                "type": "session.delegation.created",
                "delegation": { "target": "client", "id": "dlg_123" }
            }))
            .unwrap();
        assert!(delegated.iter().any(|event| matches!(
            event,
            RealtimeProtocolEvent::TranscriptFinalized {
                item_id: finalized,
                text,
                interrupted: false,
                ..
            } if finalized == &item_id && text == "A long answer can arrive in several audio bursts."
        )));
        assert!(delegated.iter().any(|event| matches!(
            event,
            RealtimeProtocolEvent::Handoff { call_id, .. } if call_id == "dlg_123"
        )));
    }
}
