use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::{Duration, Instant};

use berd_voice::expert_spokesperson::SemanticTurn;
use berd_voice::input::VoiceInputFrame;
use berd_voice::openai_spokesperson::{
    OpenAiSpokespersonConfig, OpenAiSpokespersonRuntime, SpokespersonCommand, SpokespersonEvent,
};
use berd_voice::TtsSettings;

const READY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoiceUpdatePhase {
    Building,
    InputBarrier,
}

pub struct VoiceUpdateTransaction {
    pub id: u64,
    pub base_revision: u64,
    pub settings: TtsSettings,
    pub semantic_revision: u64,
    runtime: Option<OpenAiSpokespersonRuntime>,
    events: Receiver<SpokespersonEvent>,
    phase: VoiceUpdatePhase,
    held_input: VecDeque<Box<VoiceInputFrame>>,
    ready_deadline: Instant,
}

pub struct VoiceUpdateRequest {
    pub id: u64,
    pub base_revision: u64,
    pub settings: TtsSettings,
    pub semantic_revision: u64,
}

pub struct ActivatedVoiceUpdate {
    pub id: u64,
    pub settings: TtsSettings,
    pub runtime: OpenAiSpokespersonRuntime,
    pub events: Receiver<SpokespersonEvent>,
    pub held_input: VecDeque<Box<VoiceInputFrame>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum VoiceUpdateAction {
    None,
    BeginInputBarrier,
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
        runtime_config: &OpenAiSpokespersonConfig,
        semantic_transcript: Vec<SemanticTurn>,
    ) -> Result<Self, String> {
        if current_revision != request.base_revision {
            return Err(format!(
                "stale TTS configuration revision: expected {}, current {current_revision}",
                request.base_revision
            ));
        }
        if !quiescent {
            return Err("Spokesperson voice settings can only change between turns".into());
        }
        let (voice, speed) = match &request.settings {
            TtsSettings::OpenAi { model, voice, rate }
                if model == &runtime_config.model
                    && !voice.trim().is_empty()
                    && rate.is_finite()
                    && (0.25..=1.5).contains(rate) =>
            {
                (voice.clone(), *rate)
            }
            TtsSettings::OpenAi { model, .. } if model != &runtime_config.model => {
                return Err("Spokesperson model cannot change during a session".into());
            }
            TtsSettings::OpenAi { voice, .. } if voice.trim().is_empty() => {
                return Err("Spokesperson voice must not be empty".into());
            }
            TtsSettings::OpenAi { .. } => {
                return Err("Expert-Spokesperson rate must be between 0.25 and 1.5".into());
            }
            _ => return Err("Expert-Spokesperson requires OpenAI voice settings".into()),
        };
        let mut candidate_config = runtime_config.clone();
        candidate_config.voice = voice;
        candidate_config.speed = speed;
        candidate_config.semantic_transcript = semantic_transcript;
        let (runtime, events) = OpenAiSpokespersonRuntime::spawn(candidate_config)?;
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
        })
    }

    pub fn phase(&self) -> VoiceUpdatePhase {
        self.phase
    }

    pub fn next_action(&self, now: Instant, safe: bool) -> VoiceUpdateAction {
        if !safe {
            return VoiceUpdateAction::Reject(
                "Spokesperson conversation changed during voice replacement".into(),
            );
        }
        if self.phase == VoiceUpdatePhase::Building && now >= self.ready_deadline {
            return VoiceUpdateAction::Reject(
                "replacement Spokesperson session timed out before readiness".into(),
            );
        }
        match self.events.try_recv() {
            Ok(SpokespersonEvent::Ready) if self.phase == VoiceUpdatePhase::Building => {
                match self.events.try_recv() {
                    Err(TryRecvError::Empty) => VoiceUpdateAction::BeginInputBarrier,
                    Ok(SpokespersonEvent::Failed(message)) => VoiceUpdateAction::Reject(message),
                    Ok(SpokespersonEvent::Closed) | Err(TryRecvError::Disconnected) => {
                        VoiceUpdateAction::Reject(
                            "replacement Spokesperson session closed before activation".into(),
                        )
                    }
                    Ok(_) => VoiceUpdateAction::Reject(
                        "replacement Spokesperson emitted live input before activation".into(),
                    ),
                }
            }
            Ok(SpokespersonEvent::Failed(message)) => VoiceUpdateAction::Reject(message),
            Ok(SpokespersonEvent::Closed) | Err(TryRecvError::Disconnected) => {
                VoiceUpdateAction::Reject(
                    "replacement Spokesperson session closed before activation".into(),
                )
            }
            Ok(_) => VoiceUpdateAction::Reject(
                "replacement Spokesperson emitted live input before activation".into(),
            ),
            Err(TryRecvError::Empty) => VoiceUpdateAction::None,
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
                "Spokesperson conversation changed during voice replacement".into(),
            ),
            Err(message) => VoiceBarrierAction::Reject(message),
        }
    }

    pub fn begin_input_barrier(&mut self, old: &OpenAiSpokespersonRuntime) -> Result<(), String> {
        if self.phase != VoiceUpdatePhase::Building {
            return Err("replacement Spokesperson input barrier began twice".into());
        }
        old.send(SpokespersonCommand::BeginInputCutover {
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

    pub fn abort(mut self, old: &OpenAiSpokespersonRuntime) -> Result<u64, String> {
        if self.phase == VoiceUpdatePhase::InputBarrier {
            old.abort_input_cutover()?;
        }
        for frame in self.held_input.drain(..) {
            old.send(SpokespersonCommand::InputPcm48Khz(
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
        }
    }

    pub fn finish_candidate(mut self) -> Result<(), String> {
        if let Some(runtime) = self.runtime.take() {
            runtime.finish()?;
        }
        Ok(())
    }
}
