use serde::{Deserialize, Serialize};

use crate::{
    input::{InputDuringTtsPolicy, InputDuringTtsSnapshot},
    TtsConfigurationSnapshot, TtsSettings,
};

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SessionRequest {
    Hello {
        id: u64,
        input_during_tts: InputDuringTtsPolicy,
    },
    SetPaused {
        active: bool,
    },
    SetInputMuted {
        id: u64,
        active: bool,
    },
    SetTtsSettings {
        id: u64,
        expected_revision: u64,
        settings: TtsSettings,
    },
    SetInputDuringTts {
        id: u64,
        expected_revision: u64,
        policy: InputDuringTtsPolicy,
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
    AudioBeginAccepted {
        speech_id: u64,
    },
    AudioBeginFailed {
        speech_id: u64,
        played_frames: u64,
        message: String,
    },
    AudioChunkAccepted {
        speech_id: u64,
        sequence: u64,
    },
    AudioPlayed {
        speech_id: u64,
        played_frames: u64,
    },
    AudioSuspended {
        speech_id: u64,
        played_frames: u64,
    },
    AudioResumed {
        speech_id: u64,
        played_frames: u64,
    },
    AudioDrained {
        speech_id: u64,
        sequence: u64,
        played_frames: u64,
    },
    AudioFailed {
        speech_id: u64,
        played_frames: u64,
        message: String,
    },
    AudioCancelled {
        speech_id: u64,
        played_frames: u64,
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
pub struct VoiceSessionSnapshot {
    pub tts: TtsConfigurationSnapshot,
    pub input_during_tts: InputDuringTtsSnapshot,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TtsSettingsOutcome {
    Applied,
    Rejected,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputDuringTtsOutcome {
    Applied,
    Rejected,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionMessage {
    Ready {
        id: u64,
        protocol: u32,
        session: VoiceSessionSnapshot,
    },
    TtsSettingsResult {
        id: u64,
        outcome: TtsSettingsOutcome,
        snapshot: TtsConfigurationSnapshot,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    InputDuringTtsResult {
        id: u64,
        outcome: InputDuringTtsOutcome,
        snapshot: InputDuringTtsSnapshot,
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
    AudioSuspend {
        speech_id: u64,
    },
    AudioResume {
        speech_id: u64,
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
        spoken_through_utf8: u64,
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
            serde_json::to_string(&SessionMessage::Ready {
                id: 4,
                protocol: 2,
                session: VoiceSessionSnapshot {
                    tts: TtsConfigurationSnapshot {
                        revision: 1,
                        settings: TtsSettings::OpenAi {
                            model: "gpt-4o-mini-tts".into(),
                            voice: "marin".into(),
                            rate: 1.0,
                        },
                    },
                    input_during_tts: InputDuringTtsSnapshot {
                        revision: 1,
                        policy: InputDuringTtsPolicy::AllowBargeIn,
                    },
                },
            })
            .unwrap(),
            r#"{"type":"ready","id":4,"protocol":2,"session":{"tts":{"revision":1,"backend":"openai","model":"gpt-4o-mini-tts","voice":"marin","rate":1.0},"input_during_tts":{"revision":1,"policy":"allow_barge_in"}}}"#
        );
        assert_eq!(
            serde_json::from_str::<SessionRequest>(
                r#"{"type":"set_input_during_tts","id":8,"expected_revision":1,"policy":"suppress_input"}"#
            )
            .unwrap(),
            SessionRequest::SetInputDuringTts {
                id: 8,
                expected_revision: 1,
                policy: InputDuringTtsPolicy::SuppressInput,
            }
        );
        assert_eq!(
            serde_json::to_string(&SessionMessage::InputDuringTtsResult {
                id: 8,
                outcome: InputDuringTtsOutcome::Applied,
                snapshot: InputDuringTtsSnapshot {
                    revision: 2,
                    policy: InputDuringTtsPolicy::SuppressInput,
                },
            })
            .unwrap(),
            r#"{"type":"input_during_tts_result","id":8,"outcome":"applied","snapshot":{"revision":2,"policy":"suppress_input"}}"#
        );
        assert_eq!(
            serde_json::from_str::<SessionRequest>(
                r#"{"type":"set_tts_settings","id":7,"expected_revision":1,"settings":{"backend":"openai","model":"gpt-4o-mini-tts","voice":"marin","rate":2.0}}"#
            )
            .unwrap(),
            SessionRequest::SetTtsSettings {
                id: 7,
                expected_revision: 1,
                settings: TtsSettings::OpenAi {
                    model: "gpt-4o-mini-tts".into(),
                    voice: "marin".into(),
                    rate: 2.0,
                },
            }
        );
        assert_eq!(
            serde_json::to_string(&SessionMessage::TtsSettingsResult {
                id: 7,
                outcome: TtsSettingsOutcome::Applied,
                snapshot: TtsConfigurationSnapshot {
                    revision: 2,
                    settings: TtsSettings::OpenAi {
                        model: "gpt-4o-mini-tts".into(),
                        voice: "marin".into(),
                        rate: 2.0,
                    },
                },
                message: None,
            })
            .unwrap(),
            r#"{"type":"tts_settings_result","id":7,"outcome":"applied","snapshot":{"revision":2,"backend":"openai","model":"gpt-4o-mini-tts","voice":"marin","rate":2.0}}"#
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
        assert_eq!(
            serde_json::to_string(&SessionMessage::SpeechInterrupted {
                id: 7,
                speech_id: 8,
                spoken_through_utf8: 12,
            })
            .unwrap(),
            r#"{"type":"speech_interrupted","id":7,"speech_id":8,"spoken_through_utf8":12}"#
        );
        assert_eq!(
            serde_json::from_str::<SessionRequest>(
                r#"{"type":"audio_chunk_accepted","speech_id":9,"sequence":3}"#
            )
            .unwrap(),
            SessionRequest::AudioChunkAccepted {
                speech_id: 9,
                sequence: 3,
            }
        );
        assert_eq!(
            serde_json::from_str::<SessionRequest>(
                r#"{"type":"audio_drained","speech_id":9,"sequence":3,"played_frames":7000}"#
            )
            .unwrap(),
            SessionRequest::AudioDrained {
                speech_id: 9,
                sequence: 3,
                played_frames: 7000,
            }
        );
        assert_eq!(
            serde_json::from_str::<SessionRequest>(
                r#"{"type":"audio_suspended","speech_id":9,"played_frames":4096}"#
            )
            .unwrap(),
            SessionRequest::AudioSuspended {
                speech_id: 9,
                played_frames: 4096,
            }
        );
        assert_eq!(
            serde_json::from_str::<SessionRequest>(
                r#"{"type":"audio_resumed","speech_id":9,"played_frames":4096}"#
            )
            .unwrap(),
            SessionRequest::AudioResumed {
                speech_id: 9,
                played_frames: 4096,
            }
        );
        assert_eq!(
            serde_json::to_string(&SessionMessage::AudioSuspend { speech_id: 9 }).unwrap(),
            r#"{"type":"audio_suspend","speech_id":9}"#
        );
        assert_eq!(
            serde_json::to_string(&SessionMessage::AudioResume { speech_id: 9 }).unwrap(),
            r#"{"type":"audio_resume","speech_id":9}"#
        );
    }
}
