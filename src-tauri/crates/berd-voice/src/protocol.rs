use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SessionRequest {
    Hello {
        id: u64,
        output_device: Option<String>,
    },
    SetPaused {
        active: bool,
    },
    SetInputMuted {
        id: u64,
        active: bool,
    },
    ResetInput {
        id: u64,
    },
    PrepareSpeak {
        id: u64,
        acknowledgement: Option<u64>,
        text: String,
    },
    OutputReady {
        id: u64,
        speech_id: u64,
    },
    QueryState {
        id: u64,
        after: u64,
    },
    Cancel {
        id: u64,
    },
    Shutdown,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PendingUtterance {
    pub token: u64,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotAdmittedReason {
    Paused,
    InProgress,
    Cancelled,
    EmptyText,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CancelOutcome {
    Cancelled,
    Stale,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputReadyOutcome {
    Accepted,
    Stale,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionMessage {
    Ready {
        id: u64,
        protocol: u32,
    },
    InputMuteApplied {
        id: u64,
        active: bool,
    },
    InputResetApplied {
        id: u64,
    },
    InputSpeaking {
        active: bool,
    },
    RecognitionPending {
        active: bool,
    },
    UserFinal {
        token: u64,
        text: String,
    },
    Pending {
        id: u64,
        utterances: Vec<PendingUtterance>,
    },
    NotAdmitted {
        id: u64,
        reason: NotAdmittedReason,
    },
    Admitted {
        id: u64,
        speech_id: u64,
        confirmed_token: u64,
    },
    State {
        id: u64,
        confirmed_token: u64,
        utterances_after: Vec<PendingUtterance>,
    },
    CancelResult {
        id: u64,
        outcome: CancelOutcome,
        speech_id: Option<u64>,
    },
    OutputReadyResult {
        id: u64,
        speech_id: u64,
        outcome: OutputReadyOutcome,
    },
    SpeechStarted {
        id: u64,
        speech_id: u64,
    },
    SpeechCompleted {
        id: u64,
        speech_id: u64,
    },
    SpeechInterrupted {
        id: u64,
        speech_id: u64,
    },
    SpeechFailed {
        id: u64,
        speech_id: u64,
        message: String,
    },
    Fatal {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_is_stably_tagged() {
        let request: SessionRequest = serde_json::from_str(
            r#"{"type":"prepare_speak","id":4,"acknowledgement":0,"text":"hi"}"#,
        )
        .unwrap();
        assert_eq!(
            request,
            SessionRequest::PrepareSpeak {
                id: 4,
                acknowledgement: Some(0),
                text: "hi".into()
            }
        );
        assert_eq!(
            serde_json::to_string(&SessionMessage::Ready { id: 4, protocol: 2 }).unwrap(),
            r#"{"type":"ready","id":4,"protocol":2}"#
        );
        assert_eq!(
            serde_json::from_str::<SessionRequest>(
                r#"{"type":"set_input_muted","id":5,"active":true}"#
            )
            .unwrap(),
            SessionRequest::SetInputMuted {
                id: 5,
                active: true
            }
        );
        assert_eq!(
            serde_json::to_string(&SessionMessage::UserFinal {
                token: 6,
                text: "words".into()
            })
            .unwrap(),
            r#"{"type":"user_final","token":6,"text":"words"}"#
        );
        assert_eq!(
            serde_json::to_string(&SessionMessage::InputSpeaking { active: true }).unwrap(),
            r#"{"type":"input_speaking","active":true}"#
        );
        assert_eq!(
            serde_json::to_string(&SessionMessage::RecognitionPending { active: false }).unwrap(),
            r#"{"type":"recognition_pending","active":false}"#
        );
    }
}
