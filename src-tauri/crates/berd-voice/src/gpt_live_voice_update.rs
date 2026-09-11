use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::{Duration, Instant};

use crate::gpt_live_bridge::SemanticTurn;
use crate::input::VoiceInputFrame;
use crate::gpt_live_runtime::{
    OpenAiGptLiveConfig, OpenAiGptLiveRuntime, GptLiveCommand, GptLiveEvent,
};
use crate::TtsSettings;

const READY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoiceUpdatePhase {
    Building,
    InputBarrier,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoiceUpdatePurpose {
    Settings,
    Renewal,
    SessionRecovery { cause: String },
}

pub struct VoiceUpdateTransaction {
    pub id: u64,
    pub base_revision: u64,
    pub settings: TtsSettings,
    pub semantic_revision: u64,
    runtime: Option<OpenAiGptLiveRuntime>,
    events: Receiver<GptLiveEvent>,
    phase: VoiceUpdatePhase,
    held_input: VecDeque<Box<VoiceInputFrame>>,
    ready_deadline: Instant,
    purpose: VoiceUpdatePurpose,
}

pub struct VoiceUpdateRequest {
    pub id: u64,
    pub base_revision: u64,
    pub settings: TtsSettings,
    pub semantic_revision: u64,
}

/// Single-flight queue shared by every Backend-GptLive host. The queued
/// request and the replacement transaction are deliberately separate: hosts
/// may accept a request while a turn is active, but only one request may be
/// queued or building at a time.
pub struct VoiceUpdateQueue<T> {
    queued: Option<T>,
}

impl<T> Default for VoiceUpdateQueue<T> {
    fn default() -> Self {
        Self { queued: None }
    }
}

impl<T> VoiceUpdateQueue<T> {
    pub fn is_pending(&self) -> bool {
        self.queued.is_some()
    }

    pub fn is_busy(&self, transaction_active: bool) -> bool {
        transaction_active || self.is_pending()
    }

    pub fn try_enqueue(&mut self, transaction_active: bool, request: T) -> Result<(), T> {
        if self.is_busy(transaction_active) {
            Err(request)
        } else {
            self.queued = Some(request);
            Ok(())
        }
    }

    pub fn take_ready(&mut self, transaction_active: bool, ready: bool) -> Option<T> {
        (!transaction_active && ready)
            .then(|| self.queued.take())
            .flatten()
    }

    pub fn take(&mut self) -> Option<T> {
        self.queued.take()
    }
}

pub fn validate_voice_update_settings(
    base_revision: u64,
    settings: &TtsSettings,
    current_revision: u64,
    runtime_config: &OpenAiGptLiveConfig,
) -> Result<(), String> {
    if base_revision != current_revision {
        return Err(format!(
            "stale TTS configuration revision: expected {base_revision}, current {current_revision}"
        ));
    }
    match settings {
        TtsSettings::OpenAi { model, .. } if model != runtime_config.model() => {
            Err("GptLive model cannot change during a session".into())
        }
        TtsSettings::OpenAi { voice, .. } if voice.trim().is_empty() => {
            Err("GptLive voice must not be empty".into())
        }
        TtsSettings::OpenAi { rate, .. } if !rate.is_finite() || !(0.25..=1.5).contains(rate) => {
            Err("Backend-GptLive rate must be between 0.25 and 1.5".into())
        }
        TtsSettings::OpenAi { .. } => Ok(()),
        _ => Err("Backend-GptLive requires OpenAI voice settings".into()),
    }
}

pub struct ActivatedVoiceUpdate {
    pub id: u64,
    pub settings: TtsSettings,
    pub runtime: OpenAiGptLiveRuntime,
    pub events: Receiver<GptLiveEvent>,
    pub held_input: VecDeque<Box<VoiceInputFrame>>,
    pub purpose: VoiceUpdatePurpose,
}

#[derive(Debug, PartialEq, Eq)]
pub enum VoiceUpdateAction {
    None,
    BeginInputBarrier,
    Activate,
    Reject(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum VoiceBarrierAction {
    Ignore,
    Activate,
    Reject(String),
}

impl VoiceUpdateTransaction {
    pub fn start(
        request: VoiceUpdateRequest,
        current_revision: u64,
        quiescent: bool,
        runtime_config: &OpenAiGptLiveConfig,
        semantic_transcript: Vec<SemanticTurn>,
    ) -> Result<Self, String> {
        Self::start_with_purpose(
            request,
            current_revision,
            quiescent,
            runtime_config,
            semantic_transcript,
            VoiceUpdatePurpose::Settings,
        )
    }

    pub fn start_with_purpose(
        request: VoiceUpdateRequest,
        current_revision: u64,
        quiescent: bool,
        runtime_config: &OpenAiGptLiveConfig,
        semantic_transcript: Vec<SemanticTurn>,
        purpose: VoiceUpdatePurpose,
    ) -> Result<Self, String> {
        validate_voice_update_settings(
            request.base_revision,
            &request.settings,
            current_revision,
            runtime_config,
        )?;
        if !quiescent {
            return Err("GptLive voice settings can only change between turns".into());
        }
        let (voice, speed) = match &request.settings {
            TtsSettings::OpenAi { voice, rate, .. } => (voice.clone(), *rate),
            _ => unreachable!("validated Backend-GptLive settings are OpenAI"),
        };
        let mut candidate_config = runtime_config.clone();
        candidate_config.set_voice_and_speed(voice, speed);
        candidate_config.semantic_transcript = semantic_transcript;
        let (runtime, events) = OpenAiGptLiveRuntime::spawn(candidate_config)?;
        Ok(Self {
            id: request.id,
            base_revision: request.base_revision,
            settings: request.settings,
            semantic_revision: request.semantic_revision,
            runtime: Some(runtime),
            events,
            phase: VoiceUpdatePhase::Building,
            held_input: VecDeque::new(),
            ready_deadline: Instant::now() + READY_TIMEOUT,
            purpose,
        })
    }

    pub fn next_action(&self, now: Instant, safe: bool) -> VoiceUpdateAction {
        if !safe {
            return VoiceUpdateAction::Reject(
                "GptLive conversation changed during voice replacement".into(),
            );
        }
        if self.phase == VoiceUpdatePhase::Building && now >= self.ready_deadline {
            return VoiceUpdateAction::Reject(
                "replacement GptLive session timed out before readiness".into(),
            );
        }
        match self.try_recv_control_event() {
            Ok(GptLiveEvent::Ready) if self.phase == VoiceUpdatePhase::Building => {
                match self.try_recv_control_event() {
                    Err(TryRecvError::Empty) => {
                        if matches!(self.purpose, VoiceUpdatePurpose::SessionRecovery { .. }) {
                            VoiceUpdateAction::Activate
                        } else {
                            VoiceUpdateAction::BeginInputBarrier
                        }
                    }
                    Ok(GptLiveEvent::Failed(message)) => VoiceUpdateAction::Reject(message),
                    Ok(GptLiveEvent::SessionLost(message)) => {
                        VoiceUpdateAction::Reject(message)
                    }
                    Ok(GptLiveEvent::Closed) | Err(TryRecvError::Disconnected) => {
                        VoiceUpdateAction::Reject(
                            "replacement GptLive session closed before activation".into(),
                        )
                    }
                    Ok(_) => VoiceUpdateAction::Reject(
                        "replacement GptLive emitted live input before activation".into(),
                    ),
                }
            }
            Ok(GptLiveEvent::Failed(message)) => VoiceUpdateAction::Reject(message),
            Ok(GptLiveEvent::SessionLost(message)) => VoiceUpdateAction::Reject(message),
            Ok(GptLiveEvent::Closed) | Err(TryRecvError::Disconnected) => {
                VoiceUpdateAction::Reject(
                    "replacement GptLive session closed before activation".into(),
                )
            }
            Ok(_) => VoiceUpdateAction::Reject(
                "replacement GptLive emitted live input before activation".into(),
            ),
            Err(TryRecvError::Empty) => VoiceUpdateAction::None,
        }
    }

    fn try_recv_control_event(&self) -> Result<GptLiveEvent, TryRecvError> {
        loop {
            match self.events.try_recv() {
                Ok(GptLiveEvent::Provider(_)) => continue,
                event => return event,
            }
        }
    }

    pub fn finish_barrier(
        &self,
        request_id: u64,
        result: Result<(), String>,
        safe: bool,
    ) -> VoiceBarrierAction {
        if self.phase != VoiceUpdatePhase::InputBarrier || self.id != request_id {
            return VoiceBarrierAction::Ignore;
        }
        match result {
            Ok(()) if safe => VoiceBarrierAction::Activate,
            Ok(()) => VoiceBarrierAction::Reject(
                "GptLive conversation changed during voice replacement".into(),
            ),
            Err(message) => VoiceBarrierAction::Reject(message),
        }
    }

    pub fn begin_input_barrier(&mut self, old: &OpenAiGptLiveRuntime) -> Result<(), String> {
        if self.phase != VoiceUpdatePhase::Building {
            return Err("replacement GptLive input barrier began twice".into());
        }
        old.send(GptLiveCommand::BeginInputCutover {
            request_id: self.id,
        })?;
        self.phase = VoiceUpdatePhase::InputBarrier;
        Ok(())
    }

    pub fn hold_input(
        &mut self,
        frame: Box<VoiceInputFrame>,
        capacity: usize,
    ) -> Result<(), Box<VoiceInputFrame>> {
        if self.held_input.len() >= capacity {
            Err(frame)
        } else {
            self.held_input.push_back(frame);
            Ok(())
        }
    }

    pub fn should_hold_input(&self) -> bool {
        self.phase == VoiceUpdatePhase::InputBarrier
            || matches!(self.purpose, VoiceUpdatePurpose::SessionRecovery { .. })
    }

    pub fn purpose(&self) -> &VoiceUpdatePurpose {
        &self.purpose
    }

    pub fn recover_after_session_loss(&mut self, cause: String) -> Result<(), String> {
        if self.phase != VoiceUpdatePhase::Building {
            return Err(cause);
        }
        if matches!(self.purpose, VoiceUpdatePurpose::Renewal) {
            self.purpose = VoiceUpdatePurpose::SessionRecovery { cause };
            Ok(())
        } else {
            Err(cause)
        }
    }

    pub fn abort(mut self, old: &OpenAiGptLiveRuntime) -> Result<u64, String> {
        if self.phase == VoiceUpdatePhase::InputBarrier {
            old.abort_input_cutover()?;
        }
        for frame in self.held_input.drain(..) {
            old.send(GptLiveCommand::InputPcm48Khz(
                frame.as_samples().to_vec(),
            ))?;
        }
        if let Some(runtime) = self.runtime.take() {
            runtime.finish()?;
        }
        Ok(self.id)
    }

    pub fn activate(mut self) -> ActivatedVoiceUpdate {
        ActivatedVoiceUpdate {
            id: self.id,
            settings: self.settings,
            runtime: self.runtime.take().expect("ready candidate runtime exists"),
            events: self.events,
            held_input: self.held_input,
            purpose: self.purpose,
        }
    }

    pub fn finish_candidate(mut self) -> Result<(), String> {
        if let Some(runtime) = self.runtime.take() {
            runtime.finish()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_voice_update_settings, VoiceUpdateQueue};
    use crate::gpt_live_protocol::RealtimeGptLiveSessionOptions;
    use crate::gpt_live_runtime::OpenAiGptLiveConfig;
    use crate::TtsSettings;

    fn config() -> OpenAiGptLiveConfig {
        OpenAiGptLiveConfig::new(
            "test-key".into(),
            RealtimeGptLiveSessionOptions {
                voice: Some("marin".into()),
                ..Default::default()
            },
            Vec::new(),
        )
    }

    #[test]
    fn shared_settings_validation_accepts_voice_and_rate_changes() {
        assert_eq!(
            validate_voice_update_settings(
                4,
                &TtsSettings::OpenAi {
                    model: "gpt-live-1".into(),
                    voice: "cedar".into(),
                    rate: 1.5,
                },
                4,
                &config(),
            ),
            Ok(())
        );
    }

    #[test]
    fn shared_settings_validation_rejects_stale_or_invalid_changes() {
        let config = config();
        let settings = TtsSettings::OpenAi {
            model: "gpt-live-1".into(),
            voice: "cedar".into(),
            rate: 1.5,
        };
        assert!(validate_voice_update_settings(3, &settings, 4, &config)
            .unwrap_err()
            .contains("stale"));
        assert!(validate_voice_update_settings(
            4,
            &TtsSettings::OpenAi {
                    model: "gpt-live-1".into(),
                voice: "cedar".into(),
                rate: 2.0,
            },
            4,
            &config,
        )
        .unwrap_err()
        .contains("between 0.25 and 1.5"));
    }

    #[test]
    fn shared_queue_is_single_flight_and_waits_for_readiness() {
        let mut queue = VoiceUpdateQueue::default();
        assert_eq!(queue.try_enqueue(false, 1), Ok(()));
        assert_eq!(queue.try_enqueue(false, 2), Err(2));
        assert_eq!(queue.take_ready(false, false), None);
        assert_eq!(queue.take_ready(true, true), None);
        assert_eq!(queue.take_ready(false, true), Some(1));
        assert_eq!(queue.try_enqueue(false, 3), Ok(()));
    }
}
