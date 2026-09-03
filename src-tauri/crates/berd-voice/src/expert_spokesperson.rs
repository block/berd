use crate::causal_inbox::{CausalInbox, CausalMessage, InvalidCausalToken};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LiveSideEvent {
    UserTranscript { text: String },
    SpokespersonTranscript { text: String, interrupted: bool },
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
}

impl ExpertSpokespersonCore {
    pub fn add_live_event(
        &mut self,
        token: u64,
        event: LiveSideEvent,
    ) -> Result<(), InvalidCausalToken> {
        self.live_events.push(token, event)
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

        ExpertDirectiveOutcome::Accepted {
            confirmed_token: self.live_events.confirmed_token(),
            mode: directive.mode,
            message,
        }
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
}
