use crate::{
    causal_inbox::{CausalMessage, InvalidCausalToken},
    realtime_pipe::{
        RealtimeMessagePipe, RealtimePipeExchange, RealtimePipePeer, RealtimePipeRejection,
    },
};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LiveSideEvent {
    UserTranscript { text: String },
    GptLiveTranscript { text: String, interrupted: bool },
    Handoff { call_id: String, message: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackendDirective {
    pub acknowledgement: Option<u64>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendDirectiveRejection {
    EmptyMessage,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackendDirectiveOutcome {
    Pending(Vec<CausalMessage<LiveSideEvent>>),
    Rejected(BackendDirectiveRejection),
    Accepted {
        confirmed_token: u64,
        message: String,
    },
}

/// Causal boundary between the durable Backend and the live conversation side.
///
/// The live side contains the user in every mode and may also contain a
/// GptLive. Both sources enter one ordered inbox. An Backend directive can
/// cross back only after acknowledging the complete pending live-side batch.
#[derive(Debug)]
pub struct BackendGptLiveCore {
    pipe: RealtimeMessagePipe,
    live_events: Vec<CausalMessage<LiveSideEvent>>,
    semantic_turns: Vec<Option<SemanticTurn>>,
    gpt_live_turns: HashMap<String, usize>,
    semantic_revision: u64,
}

impl Default for BackendGptLiveCore {
    fn default() -> Self {
        Self::new(0)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SemanticTurn {
    User(String),
    GptLive { text: String, interrupted: bool },
    Backend(String),
}

impl BackendGptLiveCore {
    pub fn new(initial_cursor: u64) -> Self {
        Self {
            pipe: RealtimeMessagePipe::new(initial_cursor),
            live_events: Vec::new(),
            semantic_turns: Vec::new(),
            gpt_live_turns: HashMap::new(),
            semantic_revision: 0,
        }
    }

    pub fn add_live_event(
        &mut self,
        token: u64,
        event: LiveSideEvent,
    ) -> Result<(), InvalidCausalToken> {
        let previous = self.pipe.next_message_id().saturating_sub(1);
        if token != self.pipe.next_message_id() {
            return Err(InvalidCausalToken { token, previous });
        }
        self.record_live_event(event)
            .map(|_| ())
            .map_err(|_| InvalidCausalToken { token, previous })
    }

    pub fn record_live_event(
        &mut self,
        event: LiveSideEvent,
    ) -> Result<CausalMessage<LiveSideEvent>, String> {
        let cursor = self.pipe.delivery_cursor(RealtimePipePeer::GptLive);
        let pipe_message = live_event_pipe_message(&event);
        let exchange = self
            .pipe
            .send(RealtimePipePeer::GptLive, cursor, &pipe_message)?;
        let token = match exchange {
            RealtimePipeExchange::Accepted(accepted) => accepted.outbound.id,
            RealtimePipeExchange::Rejected(rejected) => {
                return Err(format!(
                    "live event could not enter the Backend pipe ({:?})",
                    rejected.reason
                ))
            }
        };
        let message = CausalMessage {
            token,
            payload: event,
        };
        self.live_events.push(message.clone());
        Ok(message)
    }

    pub fn prepare_directive(&mut self, directive: BackendDirective) -> BackendDirectiveOutcome {
        let message = directive.message.trim().to_string();
        if message.is_empty() {
            return BackendDirectiveOutcome::Rejected(BackendDirectiveRejection::EmptyMessage);
        }

        let cursor = directive
            .acknowledgement
            .unwrap_or_else(|| self.pipe.cursor(RealtimePipePeer::Backend));
        match self.pipe.send(RealtimePipePeer::Backend, cursor, &message) {
            Ok(RealtimePipeExchange::Accepted(accepted)) => BackendDirectiveOutcome::Accepted {
                confirmed_token: accepted.outbound.sender_cursor,
                message,
            },
            Ok(RealtimePipeExchange::Rejected(rejected)) => {
                let acknowledged_live_token = directive.acknowledgement.filter(|token| {
                    self.live_events
                        .iter()
                        .any(|message| message.token == *token)
                });
                let cutoff = acknowledged_live_token.unwrap_or(match rejected.reason {
                    RealtimePipeRejection::PipeBusy | RealtimePipeRejection::StaleCursor => {
                        rejected.cursor
                    }
                });
                BackendDirectiveOutcome::Pending(self.events_after(cutoff))
            }
            Err(_) => BackendDirectiveOutcome::Rejected(BackendDirectiveRejection::EmptyMessage),
        }
    }

    pub fn send_backend_message(
        &mut self,
        cursor: u64,
        message: &str,
    ) -> Result<RealtimePipeExchange, String> {
        self.pipe.send(RealtimePipePeer::Backend, cursor, message)
    }

    pub fn confirmed_token(&self) -> u64 {
        self.pipe.cursor(RealtimePipePeer::Backend)
    }

    pub fn next_live_token(&self) -> u64 {
        self.pipe.next_message_id()
    }

    pub fn events_after(&self, token: u64) -> Vec<CausalMessage<LiveSideEvent>> {
        self.live_events
            .iter()
            .filter(|message| message.token > token)
            .cloned()
            .collect()
    }

    pub fn reserve_gpt_live_turn(&mut self, response_id: String) {
        if self.gpt_live_turns.contains_key(&response_id) {
            return;
        }
        let index = self.semantic_turns.len();
        self.semantic_turns.push(None);
        self.gpt_live_turns.insert(response_id, index);
    }

    pub fn finish_gpt_live_turn(&mut self, response_id: &str, text: String, interrupted: bool) {
        let Some(index) = self.gpt_live_turns.remove(response_id) else {
            return;
        };
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        self.semantic_turns[index] = Some(SemanticTurn::GptLive { text, interrupted });
        self.semantic_revision = self.semantic_revision.saturating_add(1);
    }

    pub fn record_user_turn(&mut self, text: String) {
        self.record_semantic_turn(SemanticTurn::User(text));
    }

    pub fn record_backend_turn(&mut self, text: String) {
        self.record_semantic_turn(SemanticTurn::Backend(text));
    }

    pub fn record_gpt_live_turn(&mut self, text: String, interrupted: bool) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        self.record_semantic_turn(SemanticTurn::GptLive { text, interrupted });
    }

    pub fn semantic_revision(&self) -> u64 {
        self.semantic_revision
    }

    pub fn semantic_transcript(&self) -> Vec<SemanticTurn> {
        self.semantic_turns.iter().flatten().cloned().collect()
    }

    fn record_semantic_turn(&mut self, turn: SemanticTurn) {
        self.semantic_turns.push(Some(turn));
        self.semantic_revision = self.semantic_revision.saturating_add(1);
    }
}

fn live_event_pipe_message(event: &LiveSideEvent) -> String {
    match event {
        LiveSideEvent::UserTranscript { text }
        | LiveSideEvent::GptLiveTranscript { text, .. }
            if !text.trim().is_empty() =>
        {
            text.clone()
        }
        LiveSideEvent::UserTranscript { .. } => "[Empty user transcript]".into(),
        LiveSideEvent::GptLiveTranscript {
            interrupted: true, ..
        } => "[GptLive interrupted before any confirmed words]".into(),
        LiveSideEvent::GptLiveTranscript { .. } => "[Silent GptLive response]".into(),
        LiveSideEvent::Handoff { message, .. } => message.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directive(acknowledgement: Option<u64>, message: &str) -> BackendDirective {
        BackendDirective {
            acknowledgement,
            message: message.into(),
        }
    }

    #[test]
    fn user_and_gpt_live_share_one_ordered_live_side() {
        let mut core = BackendGptLiveCore::default();
        core.add_live_event(
            1,
            LiveSideEvent::UserTranscript {
                text: "Can you check?".into(),
            },
        )
        .unwrap();
        core.add_live_event(
            2,
            LiveSideEvent::GptLiveTranscript {
                text: "I will ask the Backend.".into(),
                interrupted: false,
            },
        )
        .unwrap();

        assert_eq!(
            core.prepare_directive(directive(Some(1), "I checked.")),
            BackendDirectiveOutcome::Pending(vec![CausalMessage {
                token: 2,
                payload: LiveSideEvent::GptLiveTranscript {
                    text: "I will ask the Backend.".into(),
                    interrupted: false,
                },
            }])
        );
    }

    #[test]
    fn acknowledging_the_complete_live_batch_allows_the_backend_to_reverse() {
        let mut core = BackendGptLiveCore::default();
        core.add_live_event(
            1,
            LiveSideEvent::UserTranscript {
                text: "Can you check?".into(),
            },
        )
        .unwrap();
        core.add_live_event(
            2,
            LiveSideEvent::GptLiveTranscript {
                text: "I will ask the Backend.".into(),
                interrupted: false,
            },
        )
        .unwrap();

        assert_eq!(
            core.prepare_directive(directive(Some(2), "  I checked.  ")),
            BackendDirectiveOutcome::Accepted {
                confirmed_token: 2,
                message: "I checked.".into(),
            }
        );
    }

    #[test]
    fn invalid_directive_does_not_acknowledge_live_input() {
        let mut core = BackendGptLiveCore::default();
        core.add_live_event(
            1,
            LiveSideEvent::UserTranscript {
                text: "Do not lose this.".into(),
            },
        )
        .unwrap();

        assert_eq!(
            core.prepare_directive(directive(Some(1), "  ")),
            BackendDirectiveOutcome::Rejected(BackendDirectiveRejection::EmptyMessage)
        );
        assert!(matches!(
            core.prepare_directive(directive(None, "Now reply.")),
            BackendDirectiveOutcome::Pending(events) if events.len() == 1
        ));
    }

    #[test]
    fn semantic_turns_follow_response_start_not_publication_order() {
        let mut core = BackendGptLiveCore::default();
        core.reserve_gpt_live_turn("response-1".into());
        core.record_user_turn("Here I am interrupting you".into());
        core.finish_gpt_live_turn("response-1", "The heard prefix".into(), true);

        assert_eq!(
            core.semantic_transcript(),
            vec![
                SemanticTurn::GptLive {
                    text: "The heard prefix".into(),
                    interrupted: true,
                },
                SemanticTurn::User("Here I am interrupting you".into()),
            ]
        );
    }

    #[test]
    fn unheard_gpt_live_turn_is_omitted_from_semantic_transcript() {
        let mut core = BackendGptLiveCore::default();
        core.reserve_gpt_live_turn("response-1".into());
        core.record_user_turn("Interrupting immediately".into());
        core.finish_gpt_live_turn("response-1", String::new(), true);

        assert_eq!(
            core.semantic_transcript(),
            vec![SemanticTurn::User("Interrupting immediately".into())]
        );
    }
}
