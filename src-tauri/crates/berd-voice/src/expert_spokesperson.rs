use crate::causal_inbox::{CausalInbox, CausalMessage, InvalidCausalToken};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LiveSideEvent {
    UserTranscript { text: String },
    SpokespersonTranscript { text: String, interrupted: bool },
    Handoff { call_id: String, message: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExpertDirectiveMode {
    Context,
    Say,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpertDirective {
    pub acknowledgement: Option<u64>,
    pub mode: ExpertDirectiveMode,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExpertDirectiveRejection {
    EmptyMessage,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExpertDirectiveOutcome {
    Pending(Vec<CausalMessage<LiveSideEvent>>),
    Rejected(ExpertDirectiveRejection),
    Accepted {
        confirmed_token: u64,
        mode: ExpertDirectiveMode,
        message: String,
    },
}

/// Causal boundary between the durable Expert and the live conversation side.
///
/// The live side contains the user in every mode and may also contain a
/// Spokesperson. Both sources enter one ordered inbox. An Expert directive can
/// cross back only after acknowledging the complete pending live-side batch.
#[derive(Debug, Default)]
pub struct ExpertSpokespersonCore {
    live_events: CausalInbox<LiveSideEvent>,
    semantic_turns: Vec<Option<SemanticTurn>>,
    spokesperson_turns: HashMap<String, usize>,
    semantic_revision: u64,
    unresolved_handoff: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SemanticTurn {
    User(String),
    Spokesperson { text: String, interrupted: bool },
    Expert(String),
}

impl ExpertSpokespersonCore {
    pub fn add_live_event(
        &mut self,
        token: u64,
        event: LiveSideEvent,
    ) -> Result<(), InvalidCausalToken> {
        let is_handoff = matches!(event, LiveSideEvent::Handoff { .. });
        self.live_events.push(token, event)?;
        if is_handoff {
            self.unresolved_handoff = true;
        }
        Ok(())
    }

    pub fn prepare_directive(&mut self, directive: ExpertDirective) -> ExpertDirectiveOutcome {
        let message = directive.message.trim().to_string();
        if message.is_empty() {
            return ExpertDirectiveOutcome::Rejected(ExpertDirectiveRejection::EmptyMessage);
        }

        let cutoff = self.live_events.acknowledge(directive.acknowledgement);
        let pending = self.live_events.messages_after(cutoff);
        if !pending.is_empty() {
            return ExpertDirectiveOutcome::Pending(pending);
        }

        let confirmed_token = self.live_events.confirmed_token();
        self.unresolved_handoff = false;
        ExpertDirectiveOutcome::Accepted {
            confirmed_token,
            mode: directive.mode,
            message,
        }
    }

    pub fn confirmed_token(&self) -> u64 {
        self.live_events.confirmed_token()
    }

    pub fn events_after(&self, token: u64) -> Vec<CausalMessage<LiveSideEvent>> {
        self.live_events.messages_after(token)
    }

    pub fn has_unresolved_handoff(&self) -> bool {
        self.unresolved_handoff
    }

    pub fn reserve_spokesperson_turn(&mut self, response_id: String) {
        if self.spokesperson_turns.contains_key(&response_id) {
            return;
        }
        let index = self.semantic_turns.len();
        self.semantic_turns.push(None);
        self.spokesperson_turns.insert(response_id, index);
    }

    pub fn finish_spokesperson_turn(&mut self, response_id: &str, text: String, interrupted: bool) {
        let Some(index) = self.spokesperson_turns.remove(response_id) else {
            return;
        };
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        self.semantic_turns[index] = Some(SemanticTurn::Spokesperson { text, interrupted });
        self.semantic_revision = self.semantic_revision.saturating_add(1);
    }

    pub fn record_user_turn(&mut self, text: String) {
        self.record_semantic_turn(SemanticTurn::User(text));
    }

    pub fn record_expert_turn(&mut self, text: String) {
        self.record_semantic_turn(SemanticTurn::Expert(text));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn directive(acknowledgement: Option<u64>, message: &str) -> ExpertDirective {
        ExpertDirective {
            acknowledgement,
            mode: ExpertDirectiveMode::Say,
            message: message.into(),
        }
    }

    #[test]
    fn user_and_spokesperson_share_one_ordered_live_side() {
        let mut core = ExpertSpokespersonCore::default();
        core.add_live_event(
            1,
            LiveSideEvent::UserTranscript {
                text: "Can you check?".into(),
            },
        )
        .unwrap();
        core.add_live_event(
            2,
            LiveSideEvent::SpokespersonTranscript {
                text: "I will ask the Expert.".into(),
                interrupted: false,
            },
        )
        .unwrap();

        assert_eq!(
            core.prepare_directive(directive(Some(1), "I checked.")),
            ExpertDirectiveOutcome::Pending(vec![CausalMessage {
                token: 2,
                payload: LiveSideEvent::SpokespersonTranscript {
                    text: "I will ask the Expert.".into(),
                    interrupted: false,
                },
            }])
        );
    }

    #[test]
    fn acknowledging_the_complete_live_batch_allows_the_expert_to_reverse() {
        let mut core = ExpertSpokespersonCore::default();
        core.add_live_event(
            1,
            LiveSideEvent::UserTranscript {
                text: "Can you check?".into(),
            },
        )
        .unwrap();
        core.add_live_event(
            2,
            LiveSideEvent::SpokespersonTranscript {
                text: "I will ask the Expert.".into(),
                interrupted: false,
            },
        )
        .unwrap();

        assert_eq!(
            core.prepare_directive(directive(Some(2), "  I checked.  ")),
            ExpertDirectiveOutcome::Accepted {
                confirmed_token: 2,
                mode: ExpertDirectiveMode::Say,
                message: "I checked.".into(),
            }
        );
    }

    #[test]
    fn invalid_directive_does_not_acknowledge_live_input() {
        let mut core = ExpertSpokespersonCore::default();
        core.add_live_event(
            1,
            LiveSideEvent::UserTranscript {
                text: "Do not lose this.".into(),
            },
        )
        .unwrap();

        assert_eq!(
            core.prepare_directive(directive(Some(1), "  ")),
            ExpertDirectiveOutcome::Rejected(ExpertDirectiveRejection::EmptyMessage)
        );
        assert!(matches!(
            core.prepare_directive(directive(None, "Now reply.")),
            ExpertDirectiveOutcome::Pending(events) if events.len() == 1
        ));
    }

    #[test]
    fn semantic_turns_follow_response_start_not_publication_order() {
        let mut core = ExpertSpokespersonCore::default();
        core.reserve_spokesperson_turn("response-1".into());
        core.record_user_turn("Here I am interrupting you".into());
        core.finish_spokesperson_turn("response-1", "The heard prefix".into(), true);

        assert_eq!(
            core.semantic_transcript(),
            vec![
                SemanticTurn::Spokesperson {
                    text: "The heard prefix".into(),
                    interrupted: true,
                },
                SemanticTurn::User("Here I am interrupting you".into()),
            ]
        );
    }

    #[test]
    fn unheard_spokesperson_turn_is_omitted_from_semantic_transcript() {
        let mut core = ExpertSpokespersonCore::default();
        core.reserve_spokesperson_turn("response-1".into());
        core.record_user_turn("Interrupting immediately".into());
        core.finish_spokesperson_turn("response-1", String::new(), true);

        assert_eq!(
            core.semantic_transcript(),
            vec![SemanticTurn::User("Interrupting immediately".into())]
        );
    }

    #[test]
    fn only_an_unresolved_handoff_blocks_voice_replacement() {
        let mut core = ExpertSpokespersonCore::default();
        core.add_live_event(
            1,
            LiveSideEvent::UserTranscript {
                text: "Hello".into(),
            },
        )
        .unwrap();
        core.add_live_event(
            2,
            LiveSideEvent::SpokespersonTranscript {
                text: "Hi".into(),
                interrupted: false,
            },
        )
        .unwrap();
        assert!(!core.has_unresolved_handoff());

        core.add_live_event(
            3,
            LiveSideEvent::Handoff {
                call_id: "call-1".into(),
                message: "Please inspect this".into(),
            },
        )
        .unwrap();
        assert!(core.has_unresolved_handoff());

        core.add_live_event(
            4,
            LiveSideEvent::UserTranscript {
                text: "One more detail".into(),
            },
        )
        .unwrap();
        assert!(matches!(
            core.prepare_directive(directive(Some(3), "I checked")),
            ExpertDirectiveOutcome::Pending(_)
        ));
        assert!(core.has_unresolved_handoff());

        assert!(matches!(
            core.prepare_directive(directive(Some(4), "I checked")),
            ExpertDirectiveOutcome::Accepted { .. }
        ));
        assert!(!core.has_unresolved_handoff());
    }

    #[test]
    fn rejected_handoff_token_does_not_poison_quiescence() {
        let mut core = ExpertSpokespersonCore::default();
        core.add_live_event(
            1,
            LiveSideEvent::UserTranscript {
                text: "Hello".into(),
            },
        )
        .unwrap();
        assert!(core
            .add_live_event(
                1,
                LiveSideEvent::Handoff {
                    call_id: "duplicate".into(),
                    message: "must not stick".into(),
                },
            )
            .is_err());
        assert!(!core.has_unresolved_handoff());
    }
}
