use std::{
    sync::{
        mpsc::{self, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

pub const DEFAULT_STATUS_SOUND_VOLUME: f32 = 0.8;
pub const STATUS_SOUND_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StatusSoundMode {
    Off,
    WorkingAndWaiting,
    #[default]
    Working,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationStatus {
    Working,
    Waiting,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StatusSoundSettings {
    pub mode: StatusSoundMode,
    #[serde(default = "default_status_sound_volume")]
    pub volume: f32,
    #[serde(default)]
    pub vad_debug_sounds: bool,
}

impl Default for StatusSoundSettings {
    fn default() -> Self {
        Self {
            mode: StatusSoundMode::default(),
            volume: DEFAULT_STATUS_SOUND_VOLUME,
            vad_debug_sounds: false,
        }
    }
}

impl StatusSoundSettings {
    pub fn validate(self) -> Result<Self, &'static str> {
        if !self.volume.is_finite() || !(0.0..=1.0).contains(&self.volume) {
            return Err("status sound volume must be finite and between 0 and 1");
        }
        Ok(self)
    }
}

const fn default_status_sound_volume() -> f32 {
    DEFAULT_STATUS_SOUND_VOLUME
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StatusSoundCue {
    pub status: ConversationStatus,
    pub volume: f32,
}

/// Pure policy for deciding which cue, if any, a fixed-cadence runtime tick plays.
/// The host owns the timer and supplies whether conversation activity should suppress cues.
#[derive(Debug, Default)]
pub struct StatusSoundStateMachine {
    current: Option<(ConversationStatus, StatusSoundSettings)>,
}

impl StatusSoundStateMachine {
    pub fn update(&mut self, status: ConversationStatus, settings: StatusSoundSettings) -> bool {
        let next = (status, settings);
        let changed = self.current.is_none_or(|(previous, old)| {
            previous != status || old.mode != settings.mode || old.volume != settings.volume
        });
        self.current = Some(next);
        changed
    }

    pub fn tick(&mut self, conversation_active: bool) -> Option<StatusSoundCue> {
        let (status, settings) = self.current?;
        let working_only = settings.mode == StatusSoundMode::Working;
        let waiting = status == ConversationStatus::Waiting;
        if settings.mode == StatusSoundMode::Off || conversation_active || (working_only && waiting)
        {
            return None;
        }
        Some(StatusSoundCue {
            status,
            volume: settings.volume,
        })
    }
}

/// Owns status cadence and cue playback for one running voice session.
/// Producers report semantic state; they never choose or play a sound.
pub struct StatusSoundRuntime {
    machine: StatusSoundStateMachine,
    next_tick: Option<Instant>,
    pending_status_cue: bool,
    player: StatusSoundPlayer,
    debug_player: StatusSoundPlayer,
    speaking: Option<bool>,
    input_policy: crate::input::InputDuringTtsPolicy,
    output_device: Option<String>,
    input_controls: Option<crate::input::VoiceInputControls>,
}

impl Default for StatusSoundRuntime {
    fn default() -> Self {
        Self {
            machine: StatusSoundStateMachine::default(),
            next_tick: None,
            pending_status_cue: false,
            player: StatusSoundPlayer::new(),
            debug_player: StatusSoundPlayer::new(),
            speaking: None,
            input_policy: crate::input::InputDuringTtsPolicy::Auto,
            output_device: None,
            input_controls: None,
        }
    }
}

impl StatusSoundRuntime {
    pub fn set_input_controls(&mut self, controls: Option<crate::input::VoiceInputControls>) {
        self.input_controls = controls;
    }

    pub fn reset_speaking(&mut self) {
        self.speaking = None;
    }

    pub fn observe_speaking(&mut self, speaking: bool) -> Result<(), String> {
        let previous = self.speaking.replace(speaking);
        if debug_transition(
            previous,
            speaking,
            self.machine
                .current
                .is_some_and(|(_, settings)| settings.vad_debug_sounds),
        ) {
            self.debug_player.play_debug(
                speaking,
                self.output_device.as_deref(),
                self.input_controls.as_ref(),
                self.input_policy,
            )?;
        }
        Ok(())
    }

    pub fn set_output_device(&mut self, output_device: Option<String>) {
        if self.output_device != output_device {
            self.player.stop();
            self.debug_player.stop();
            self.output_device = output_device;
        }
    }

    pub fn update(&mut self, status: ConversationStatus, settings: StatusSoundSettings) {
        if !settings.vad_debug_sounds {
            self.debug_player.stop();
        }
        self.pending_status_cue |= self
            .machine
            .current
            .is_some_and(|(previous, _)| previous != status);
        let changed = self.machine.update(status, settings);
        if changed {
            self.player.stop();
            self.next_tick = Some(Instant::now());
        }
    }

    pub fn stop(&mut self) {
        self.debug_player.stop();
        self.player.stop();
    }

    fn update_conversation_activity(&mut self, conversation_active: bool) {
        if !conversation_active && self.pending_status_cue {
            self.next_tick = Some(Instant::now());
            self.pending_status_cue = false;
        }
    }

    pub fn poll(&mut self, conversation_active: bool) -> Result<bool, String> {
        self.update_conversation_activity(conversation_active);
        self.player.reap();
        self.debug_player.reap();
        let now = Instant::now();
        if self.next_tick.is_some_and(|deadline| now >= deadline) {
            let deadline = self.next_tick.unwrap();
            let elapsed = now.duration_since(deadline).as_nanos();
            let ticks = elapsed / STATUS_SOUND_INTERVAL.as_nanos() + 1;
            self.next_tick = Some(deadline + STATUS_SOUND_INTERVAL.mul_f64(ticks as f64));
            if let Some(cue) = self.machine.tick(conversation_active) {
                self.player.play(
                    cue,
                    self.output_device.as_deref(),
                    self.input_controls.as_ref(),
                    self.input_policy,
                )?;
            }
        }
        Ok(self.player.is_active())
    }
}

fn debug_transition(previous: Option<bool>, speaking: bool, enabled: bool) -> bool {
    enabled && previous.is_some_and(|previous| previous != speaking)
}

enum StatusSoundCommand {
    Update(ConversationStatus, StatusSoundSettings),
    ConversationActive {
        active: bool,
        applied: Option<Sender<Result<(), String>>>,
    },
    OutputDevice(Option<String>),
    InputPolicy(crate::input::InputDuringTtsPolicy),
    InputControls(crate::input::VoiceInputControls),
    Speaking(bool),
    ResetSpeaking,
    Shutdown,
}

/// Thread-safe status-sound service for hosts that do not own a polling loop.
#[derive(Clone)]
pub struct ManagedStatusSoundRuntime {
    inner: Arc<StatusSoundWorker>,
}

struct StatusSoundWorker {
    commands: Sender<StatusSoundCommand>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    activity: Mutex<StatusSoundActivityState>,
}

#[derive(Debug, Default)]
struct StatusSoundActivityState {
    explicit_active: bool,
    guards: usize,
}

impl StatusSoundActivityState {
    fn is_active(&self) -> bool {
        self.explicit_active || self.guards > 0
    }
}

/// A scoped conversation-activity claim that suppresses status cues until dropped.
///
/// Hosts use one guard per independently active user- or assistant-audio source.
/// The shared runtime combines overlapping claims and only resumes cues after the
/// final claim ends.
#[must_use = "status sounds resume when the activity guard is dropped"]
pub struct StatusSoundActivityGuard {
    worker: Arc<StatusSoundWorker>,
}

impl ManagedStatusSoundRuntime {
    pub fn spawn(output_device: Option<String>) -> Result<Self, String> {
        Self::spawn_with_input_controls(output_device, None)
    }

    pub fn spawn_with_input_controls(
        output_device: Option<String>,
        input_controls: Option<crate::input::VoiceInputControls>,
    ) -> Result<Self, String> {
        let (commands, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("berd-status-sounds".into())
            .spawn(move || {
                let mut runtime = StatusSoundRuntime::default();
                let mut conversation_active = false;
                runtime.set_output_device(output_device);
                runtime.set_input_controls(input_controls);
                loop {
                    let applied = match receiver.recv_timeout(Duration::from_millis(10)) {
                        Ok(StatusSoundCommand::Update(status, settings)) => {
                            runtime.update(status, settings);
                            None
                        }
                        Ok(StatusSoundCommand::ConversationActive { active, applied }) => {
                            conversation_active = active;
                            applied
                        }
                        Ok(StatusSoundCommand::OutputDevice(device)) => {
                            runtime.set_output_device(device);
                            None
                        }
                        Ok(StatusSoundCommand::InputPolicy(policy)) => {
                            runtime.input_policy = policy;
                            None
                        }
                        Ok(StatusSoundCommand::InputControls(controls)) => {
                            runtime.set_input_controls(Some(controls));
                            None
                        }
                        Ok(StatusSoundCommand::ResetSpeaking) => {
                            runtime.reset_speaking();
                            None
                        }
                        Ok(StatusSoundCommand::Speaking(speaking)) => {
                            if let Err(message) = runtime.observe_speaking(speaking) {
                                eprintln!("VAD debug sound failed: {message}");
                            }
                            None
                        }
                        Ok(StatusSoundCommand::Shutdown) | Err(RecvTimeoutError::Disconnected) => {
                            runtime.stop();
                            break;
                        }
                        Err(RecvTimeoutError::Timeout) => None,
                    };
                    let poll_result = runtime
                        .poll(conversation_active || runtime.speaking == Some(true))
                        .map(|_| ());
                    if let Some(applied) = applied {
                        let _ = applied.send(poll_result.clone());
                    }
                    if let Err(message) = poll_result {
                        eprintln!("status sound playback disabled: {message}");
                    }
                }
            })
            .map_err(|error| format!("Could not start status sound runtime: {error}"))?;
        Ok(Self {
            inner: Arc::new(StatusSoundWorker {
                commands,
                worker: Mutex::new(Some(worker)),
                activity: Mutex::new(StatusSoundActivityState::default()),
            }),
        })
    }

    pub fn set_input_policy(
        &self,
        policy: crate::input::InputDuringTtsPolicy,
    ) -> Result<(), String> {
        self.send(StatusSoundCommand::InputPolicy(policy))
    }

    pub fn set_input_controls(
        &self,
        controls: crate::input::VoiceInputControls,
    ) -> Result<(), String> {
        self.send(StatusSoundCommand::InputControls(controls))
    }

    pub fn reset_speaking(&self) -> Result<(), String> {
        self.send(StatusSoundCommand::ResetSpeaking)
    }

    pub fn observe_speaking(&self, speaking: bool) -> Result<(), String> {
        self.send(StatusSoundCommand::Speaking(speaking))
    }

    pub fn update(
        &self,
        status: ConversationStatus,
        settings: StatusSoundSettings,
    ) -> Result<(), String> {
        settings.validate().map_err(str::to_string)?;
        self.send(StatusSoundCommand::Update(status, settings))
    }

    /// Queue activity without waiting for native audio operations. PCM-owning loops
    /// must use this path so a slow output device cannot stop microphone draining.
    pub fn queue_conversation_active(&self, active: bool) -> Result<(), String> {
        self.update_explicit_activity(active, false)
    }

    pub fn set_conversation_active(&self, active: bool) -> Result<(), String> {
        self.update_explicit_activity(active, true)
    }

    fn update_explicit_activity(&self, active: bool, wait: bool) -> Result<(), String> {
        let mut activity = self
            .inner
            .activity
            .lock()
            .map_err(|_| "Status sound activity state is unavailable".to_string())?;
        let previous = activity.is_active();
        let previous_explicit = activity.explicit_active;
        activity.explicit_active = active;
        let current = activity.is_active();
        if previous != current {
            let result = if wait {
                self.apply_conversation_active(current)
            } else {
                self.send_conversation_active(current, None)
            };
            if let Err(error) = result {
                activity.explicit_active = previous_explicit;
                let _ = self.send_conversation_active(previous, None);
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn begin_conversation_activity(&self) -> Result<StatusSoundActivityGuard, String> {
        let mut activity = self
            .inner
            .activity
            .lock()
            .map_err(|_| "Status sound activity state is unavailable".to_string())?;
        let was_active = activity.is_active();
        activity.guards = activity
            .guards
            .checked_add(1)
            .ok_or_else(|| "Too many overlapping status sound activity guards".to_string())?;
        if !was_active {
            if let Err(error) = self.apply_conversation_active(true) {
                activity.guards -= 1;
                let _ = self.send_conversation_active(activity.is_active(), None);
                return Err(error);
            }
        }
        drop(activity);
        Ok(StatusSoundActivityGuard {
            worker: Arc::clone(&self.inner),
        })
    }

    pub fn set_output_device(&self, output_device: Option<String>) -> Result<(), String> {
        self.send(StatusSoundCommand::OutputDevice(output_device))
    }

    fn send(&self, command: StatusSoundCommand) -> Result<(), String> {
        self.inner
            .commands
            .send(command)
            .map_err(|_| "Status sound runtime is unavailable".to_string())
    }

    fn apply_conversation_active(&self, active: bool) -> Result<(), String> {
        let (applied, acknowledgement) = mpsc::channel();
        self.send_conversation_active(active, Some(applied))?;
        acknowledgement
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "Status sound activity update timed out".to_string())?
    }

    fn send_conversation_active(
        &self,
        active: bool,
        applied: Option<Sender<Result<(), String>>>,
    ) -> Result<(), String> {
        self.send(StatusSoundCommand::ConversationActive { active, applied })
    }

    pub fn finish(&self) -> Result<(), String> {
        let _ = self.inner.commands.send(StatusSoundCommand::Shutdown);
        let worker = self
            .inner
            .worker
            .lock()
            .map_err(|_| "Status sound worker join state is unavailable")?
            .take();
        if let Some(worker) = worker {
            let deadline = Instant::now() + Duration::from_secs(2);
            while !worker.is_finished() {
                if Instant::now() >= deadline {
                    reap_status_sound_worker(worker);
                    return Err("Status sound worker shutdown timed out".into());
                }
                thread::sleep(Duration::from_millis(10));
            }
            worker
                .join()
                .map_err(|_| "Status sound worker panicked".to_string())?;
        }
        Ok(())
    }
}

impl Drop for StatusSoundActivityGuard {
    fn drop(&mut self) {
        let Ok(mut activity) = self.worker.activity.lock() else {
            return;
        };
        debug_assert!(activity.guards > 0);
        activity.guards = activity.guards.saturating_sub(1);
        if !activity.is_active() {
            let command = StatusSoundCommand::ConversationActive {
                active: false,
                applied: None,
            };
            let _ = self.worker.commands.send(command);
        }
    }
}

impl Drop for StatusSoundWorker {
    fn drop(&mut self) {
        let _ = self.commands.send(StatusSoundCommand::Shutdown);
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(worker) = worker.take() {
                reap_status_sound_worker(worker);
            }
        }
    }
}

fn reap_status_sound_worker(worker: thread::JoinHandle<()>) {
    let _ = thread::Builder::new()
        .name("berd-status-sound-reaper".into())
        .spawn(move || {
            let _ = worker.join();
        });
}

#[cfg(not(target_os = "macos"))]
struct StatusSoundPlayer;

#[cfg(not(target_os = "macos"))]
impl StatusSoundPlayer {
    fn new() -> Self {
        Self
    }

    fn play(
        &mut self,
        _cue: StatusSoundCue,
        _output_device: Option<&str>,
        _input_controls: Option<&crate::input::VoiceInputControls>,
        _input_policy: crate::input::InputDuringTtsPolicy,
    ) -> Result<(), String> {
        Err("status sound playback is only available on macOS".into())
    }

    fn play_debug(
        &mut self,
        _speaking: bool,
        _device: Option<&str>,
        _controls: Option<&crate::input::VoiceInputControls>,
        _policy: crate::input::InputDuringTtsPolicy,
    ) -> Result<(), String> {
        Err("VAD debug sound playback is only available on macOS".into())
    }

    fn reap(&mut self) {}

    fn is_active(&self) -> bool {
        false
    }

    fn stop(&mut self) {}
}

#[cfg(target_os = "macos")]
const STATUS_SOUND_OUTPUT_TAIL: Duration = Duration::from_millis(100);

#[cfg(target_os = "macos")]
const STATUS_SOUND_DRAIN_GRACE: Duration = Duration::from_secs(2);

#[cfg(target_os = "macos")]
struct ActiveStatusSound {
    player: Box<dyn crate::PcmAudioOutput>,
    drain_deadline: Instant,
    output_tail_deadline: Option<Instant>,
    _input_activity: Option<crate::input::CueInputActivityGuard>,
}

#[cfg(target_os = "macos")]
struct StatusSoundPlayer {
    working: Result<StatusSoundAsset, String>,
    waiting: Result<StatusSoundAsset, String>,
    active: Option<ActiveStatusSound>,
}

#[cfg(target_os = "macos")]
impl StatusSoundPlayer {
    fn new() -> Self {
        Self {
            working: load_system_sound("Pop"),
            waiting: load_system_sound("Purr"),
            active: None,
        }
    }

    fn play(
        &mut self,
        cue: StatusSoundCue,
        output_device: Option<&str>,
        input_controls: Option<&crate::input::VoiceInputControls>,
        input_policy: crate::input::InputDuringTtsPolicy,
    ) -> Result<(), String> {
        self.reap();
        if self.active.is_some() {
            return Ok(());
        }
        let asset = match cue.status {
            ConversationStatus::Working => &self.working,
            ConversationStatus::Waiting => &self.waiting,
        }
        .as_ref()
        .map_err(Clone::clone)?;
        Self::play_asset(
            &mut self.active,
            asset,
            cue.volume,
            output_device,
            input_controls,
            input_policy,
        )
    }

    fn play_debug(
        &mut self,
        speaking: bool,
        output_device: Option<&str>,
        input_controls: Option<&crate::input::VoiceInputControls>,
        input_policy: crate::input::InputDuringTtsPolicy,
    ) -> Result<(), String> {
        self.reap();
        self.stop();
        let sample_rate = 48_000;
        let frequency = if speaking { 1200.0 } else { 650.0 };
        let samples = (0..960)
            .map(|index| {
                let phase = index as f32 / sample_rate as f32;
                (phase * frequency * std::f32::consts::TAU).sin()
                    * (std::f32::consts::PI * index as f32 / 960.0).sin()
            })
            .collect();
        Self::play_asset(
            &mut self.active,
            &StatusSoundAsset {
                sample_rate,
                samples,
            },
            0.08,
            output_device,
            input_controls,
            input_policy,
        )
    }

    fn play_asset(
        active: &mut Option<ActiveStatusSound>,
        asset: &StatusSoundAsset,
        volume: f32,
        output_device: Option<&str>,
        input_controls: Option<&crate::input::VoiceInputControls>,
        input_policy: crate::input::InputDuringTtsPolicy,
    ) -> Result<(), String> {
        let player = crate::macos_audio_output::PocketAudioPlayer::new(
            asset.sample_rate,
            1.0,
            output_device,
        )?;
        Self::enqueue_asset(
            active,
            Box::new(player),
            asset,
            volume,
            input_controls,
            input_policy.resolve(output_device),
        )
    }

    fn enqueue_asset(
        active: &mut Option<ActiveStatusSound>,
        player: Box<dyn crate::PcmAudioOutput>,
        asset: &StatusSoundAsset,
        volume: f32,
        input_controls: Option<&crate::input::VoiceInputControls>,
        input_policy: crate::input::InputDuringTtsPolicy,
    ) -> Result<(), String> {
        let samples = asset
            .samples
            .iter()
            .map(|sample| sample * volume)
            .collect::<Vec<_>>();
        let input_activity = input_controls
            .map(|controls| controls.begin_cue_activity(input_policy, None))
            .transpose()?;
        player.write(&samples)?;
        *active = Some(ActiveStatusSound {
            player,
            drain_deadline: Instant::now()
                + Duration::from_secs_f64(samples.len() as f64 / f64::from(asset.sample_rate))
                + STATUS_SOUND_DRAIN_GRACE,
            output_tail_deadline: None,
            _input_activity: input_activity,
        });
        Ok(())
    }

    fn reap(&mut self) {
        let now = Instant::now();
        let should_clear = self.active.as_mut().is_some_and(|sound| {
            if sound.player.check_health().is_err() || now >= sound.drain_deadline {
                return true;
            }
            if !sound.player.is_drained() {
                sound.output_tail_deadline = None;
                return false;
            }
            let deadline = sound
                .output_tail_deadline
                .get_or_insert(now + STATUS_SOUND_OUTPUT_TAIL);
            now >= *deadline
        });
        if should_clear {
            self.stop();
        }
    }

    fn is_active(&self) -> bool {
        self.active.is_some()
    }

    fn stop(&mut self) {
        if let Some(sound) = self.active.take() {
            sound.player.cancel();
        }
    }
}

#[cfg(target_os = "macos")]
struct StatusSoundAsset {
    sample_rate: u32,
    samples: Vec<f32>,
}

#[cfg(target_os = "macos")]
fn load_system_sound(name: &str) -> Result<StatusSoundAsset, String> {
    let source = format!("/System/Library/Sounds/{name}.aiff");
    let (sample_rate, samples) = crate::macos_audio_output::load_mono_audio_file(&source)
        .map_err(|error| format!("could not decode {name} status sound: {error}"))?;
    Ok(StatusSoundAsset {
        sample_rate,
        samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_cues_require_enabled_real_transitions() {
        assert!(!debug_transition(None, true, true));
        assert!(!debug_transition(None, false, true));
        assert!(!debug_transition(Some(false), false, true));
        assert!(!debug_transition(Some(true), true, true));
        assert!(!debug_transition(Some(false), true, false));
        assert!(debug_transition(Some(false), true, true));
        assert!(debug_transition(Some(true), false, true));
        let settings: StatusSoundSettings = serde_json::from_str(r#"{"mode":"off"}"#).unwrap();
        assert!(!settings.vad_debug_sounds);
    }

    #[test]
    fn debug_toggle_preserves_status_deadline() {
        let mut runtime = StatusSoundRuntime::default();
        let mut settings = settings(StatusSoundMode::Working);
        runtime.update(ConversationStatus::Working, settings);
        let deadline = runtime.next_tick;
        settings.vad_debug_sounds = true;
        runtime.update(ConversationStatus::Working, settings);
        assert_eq!(runtime.next_tick, deadline);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_cue_enqueue_obeys_policy_and_releases_guard_on_failure() {
        struct Output {
            fail: bool,
        }
        impl crate::PcmAudioOutput for Output {
            fn write(&self, _: &[f32]) -> Result<(), String> {
                if self.fail {
                    Err("enqueue failed".into())
                } else {
                    Ok(())
                }
            }
            fn cancel(&self) {}
            fn is_drained(&self) -> bool {
                false
            }
            fn check_health(&self) -> Result<(), String> {
                Ok(())
            }
            fn played_frames(&self) -> u64 {
                0
            }
        }
        use crate::input::{InputDuringTtsPolicy, VoiceInputControls};
        for policy in [
            InputDuringTtsPolicy::AllowBargeIn,
            InputDuringTtsPolicy::SuppressInput,
        ] {
            for fail in [false, true] {
                let controls = VoiceInputControls::default();
                let mut active = None;
                let result = StatusSoundPlayer::enqueue_asset(
                    &mut active,
                    Box::new(Output { fail }),
                    &StatusSoundAsset {
                        sample_rate: 48000,
                        samples: vec![0.01; 960],
                    },
                    0.08,
                    Some(&controls),
                    policy,
                );
                assert_eq!(result.is_err(), fail);
                assert_eq!(
                    controls.is_input_suppressed(),
                    !fail && policy == InputDuringTtsPolicy::SuppressInput
                );
                drop(active);
                assert!(!controls.is_input_suppressed());
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "opens CoreAudio output and plays short VAD debug clicks"]
    fn macos_debug_clicks_follow_input_policy() {
        use crate::input::{InputDuringTtsPolicy, VoiceInputControls};
        for policy in [
            InputDuringTtsPolicy::AllowBargeIn,
            InputDuringTtsPolicy::SuppressInput,
        ] {
            let controls = VoiceInputControls::default();
            let mut player = StatusSoundPlayer::new();
            for speaking in [true, false] {
                player
                    .play_debug(speaking, None, Some(&controls), policy)
                    .unwrap();
                assert_eq!(
                    controls.is_input_suppressed(),
                    policy == InputDuringTtsPolicy::SuppressInput
                );
                let deadline = Instant::now() + Duration::from_secs(5);
                while player.is_active() {
                    assert!(Instant::now() < deadline);
                    player.reap();
                    thread::sleep(Duration::from_millis(10));
                }
                assert!(!controls.is_input_suppressed());
            }
        }
    }

    #[test]
    fn restored_speech_after_reset_is_silent() {
        let mut runtime = StatusSoundRuntime::default();
        runtime.update(
            ConversationStatus::Waiting,
            StatusSoundSettings {
                mode: StatusSoundMode::Off,
                vad_debug_sounds: true,
                ..Default::default()
            },
        );
        runtime.speaking = Some(true);
        runtime.reset_speaking();
        runtime.observe_speaking(false).unwrap();
        assert!(!runtime.debug_player.is_active());
        runtime.reset_speaking();
        runtime.observe_speaking(true).unwrap();
        assert!(!runtime.debug_player.is_active());
    }

    fn settings(mode: StatusSoundMode) -> StatusSoundSettings {
        StatusSoundSettings {
            mode,
            ..StatusSoundSettings::default()
        }
    }

    fn assert_status(machine: &mut StatusSoundStateMachine, expected: ConversationStatus) {
        let actual = machine.tick(false).map(|cue| cue.status);
        assert_eq!(actual, Some(expected));
    }

    #[test]
    fn session_activity_does_not_wait_for_a_stalled_audio_worker() {
        let (commands, receiver) = mpsc::channel();
        let runtime = ManagedStatusSoundRuntime {
            inner: Arc::new(StatusSoundWorker {
                commands,
                worker: Mutex::new(None),
                activity: Mutex::new(StatusSoundActivityState::default()),
            }),
        };
        let (done, result) = mpsc::channel();
        let caller = thread::spawn(move || {
            let outcome = runtime.queue_conversation_active(true);
            done.send(outcome).unwrap();
        });
        // The audio worker deliberately never services the command.
        let outcome = result.recv_timeout(Duration::from_millis(100));
        // Release the old blocking implementation before asserting the result.
        if let Ok(StatusSoundCommand::ConversationActive {
            applied: Some(applied),
            ..
        }) = receiver.try_recv()
        {
            let _ = applied.send(Ok(()));
        }
        caller.join().unwrap();
        assert!(
            outcome.is_ok(),
            "microphone processing waited for the audio worker"
        );
    }

    #[test]
    fn managed_worker_finish_joins_and_is_idempotent_across_clones() {
        let runtime = ManagedStatusSoundRuntime::spawn(None).unwrap();
        let other = runtime.clone();
        drop(runtime);
        other.set_conversation_active(true).unwrap();
        other.finish().unwrap();
        assert!(other.inner.worker.lock().unwrap().is_none());
        assert!(other.set_conversation_active(false).is_err());
        other.finish().unwrap();
    }

    #[test]
    fn last_owner_drop_stops_and_reaps_the_worker() {
        let (commands, receiver) = mpsc::channel();
        let (stopped, completed) = mpsc::channel();
        let worker = thread::spawn(move || {
            assert!(matches!(receiver.recv(), Ok(StatusSoundCommand::Shutdown)));
            stopped.send(()).unwrap();
        });
        let runtime = ManagedStatusSoundRuntime {
            inner: Arc::new(StatusSoundWorker {
                commands,
                worker: Mutex::new(Some(worker)),
                activity: Mutex::new(StatusSoundActivityState::default()),
            }),
        };
        drop(runtime);
        completed.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    #[test]
    fn off_suppresses_both_statuses_and_round_trips_on_the_wire() {
        let mode: StatusSoundMode = serde_json::from_str("\"off\"").unwrap();
        assert_eq!(mode, StatusSoundMode::Off);
        assert_eq!(serde_json::to_string(&mode).unwrap(), "\"off\"");
        let mut machine = StatusSoundStateMachine::default();
        for status in [ConversationStatus::Working, ConversationStatus::Waiting] {
            machine.update(status, settings(mode));
            assert_eq!(machine.tick(false), None);
            assert_eq!(machine.tick(true), None);
        }
    }

    #[test]
    fn first_status_update_schedules_an_immediate_cue() {
        let mut runtime = StatusSoundRuntime::default();
        let started_at = Instant::now();
        runtime.update(
            ConversationStatus::Working,
            settings(StatusSoundMode::Working),
        );
        assert!(runtime.next_tick.unwrap() >= started_at);
        assert!(runtime.next_tick.unwrap() <= Instant::now());
        runtime.update(
            ConversationStatus::Waiting,
            settings(StatusSoundMode::Working),
        );
        assert!(!runtime.poll(false).unwrap());
        assert_eq!(runtime.machine.tick(false), None);
    }

    #[test]
    fn defaults_to_working_only() {
        assert_eq!(
            StatusSoundSettings::default(),
            settings(StatusSoundMode::Working)
        );
    }

    #[test]
    fn working_and_waiting_repeats_both_statuses() {
        let mut machine = StatusSoundStateMachine::default();
        let settings = settings(StatusSoundMode::WorkingAndWaiting);
        machine.update(ConversationStatus::Working, settings);
        assert_status(&mut machine, ConversationStatus::Working);
        assert_status(&mut machine, ConversationStatus::Working);
        machine.update(ConversationStatus::Waiting, settings);
        assert_status(&mut machine, ConversationStatus::Waiting);
        assert_status(&mut machine, ConversationStatus::Waiting);
    }

    #[test]
    fn working_only_repeats_working_and_stays_silent_while_waiting() {
        let mut machine = StatusSoundStateMachine::default();
        let settings = settings(StatusSoundMode::Working);
        machine.update(ConversationStatus::Working, settings);
        assert_status(&mut machine, ConversationStatus::Working);
        assert_status(&mut machine, ConversationStatus::Working);
        machine.update(ConversationStatus::Waiting, settings);
        assert_eq!(machine.tick(false), None);
        assert_eq!(machine.tick(false), None);
    }

    #[test]
    fn conversation_audio_suppresses_without_changing_the_status() {
        let mut machine = StatusSoundStateMachine::default();
        machine.update(
            ConversationStatus::Working,
            settings(StatusSoundMode::Working),
        );
        assert_eq!(machine.tick(true), None);
        assert!(machine.tick(false).is_some());
    }

    #[test]
    fn no_status_event_means_no_startup_cue() {
        assert_eq!(StatusSoundStateMachine::default().tick(false), None);
    }

    #[test]
    fn session_volume_defaults_to_point_eight_and_accepts_an_override() {
        assert_eq!(StatusSoundSettings::default().volume, 0.8);
        let explicit = StatusSoundSettings {
            mode: StatusSoundMode::Working,
            volume: 0.25,
            ..Default::default()
        };
        assert_eq!(explicit.validate().unwrap().volume, 0.25);
    }

    #[test]
    fn rejects_invalid_session_volume() {
        for volume in [f32::NAN, f32::INFINITY, -0.1, 1.1] {
            assert!(StatusSoundSettings {
                mode: StatusSoundMode::Working,
                volume,
                ..Default::default()
            }
            .validate()
            .is_err());
        }
    }

    #[test]
    fn duplicate_updates_preserve_the_existing_cadence() {
        let mut runtime = StatusSoundRuntime::default();
        let settings = settings(StatusSoundMode::WorkingAndWaiting);
        runtime.update(ConversationStatus::Working, settings);
        let deadline = runtime.next_tick;
        runtime.update(ConversationStatus::Working, settings);
        assert_eq!(runtime.next_tick, deadline);
    }

    #[test]
    fn changed_updates_restart_the_cadence() {
        let mut runtime = StatusSoundRuntime::default();
        runtime.update(
            ConversationStatus::Working,
            settings(StatusSoundMode::WorkingAndWaiting),
        );
        runtime.next_tick = Some(Instant::now() + Duration::from_secs(60));
        runtime.update(
            ConversationStatus::Waiting,
            settings(StatusSoundMode::WorkingAndWaiting),
        );
        assert!(runtime.next_tick.unwrap() <= Instant::now());
    }

    #[test]
    fn speech_preserves_the_existing_cue_schedule() {
        for status in [ConversationStatus::Working, ConversationStatus::Waiting] {
            let mut runtime = StatusSoundRuntime::default();
            runtime.update(status, settings(StatusSoundMode::WorkingAndWaiting));
            let deadline = Instant::now() + STATUS_SOUND_INTERVAL;
            runtime.next_tick = Some(deadline);
            runtime.poll(true).unwrap();
            runtime.update_conversation_activity(false);
            assert_eq!(runtime.next_tick, Some(deadline));
        }
    }

    #[test]
    fn status_change_during_speech_is_announced_when_speech_finishes() {
        for (before, after) in [
            (ConversationStatus::Working, ConversationStatus::Waiting),
            (ConversationStatus::Waiting, ConversationStatus::Working),
        ] {
            let mut runtime = StatusSoundRuntime::default();
            let settings = settings(StatusSoundMode::WorkingAndWaiting);
            runtime.update(before, settings);
            runtime.poll(true).unwrap();
            runtime.update(after, settings);
            runtime.poll(true).unwrap();
            runtime.update_conversation_activity(false);
            assert!(runtime.next_tick.unwrap() <= Instant::now());
        }
    }

    #[test]
    fn cues_due_during_speech_are_skipped_without_catching_up() {
        let mut runtime = StatusSoundRuntime::default();
        runtime.update(
            ConversationStatus::Working,
            settings(StatusSoundMode::Working),
        );
        let deadline = Instant::now() - Duration::from_secs(1);
        runtime.next_tick = Some(deadline);
        assert!(!runtime.poll(true).unwrap());
        let next = runtime.next_tick.unwrap();
        assert!(next > Instant::now());
        assert_eq!(next, deadline + STATUS_SOUND_INTERVAL);
        assert!(!runtime.poll(false).unwrap());
        assert_eq!(runtime.next_tick, Some(next));
    }

    #[test]
    fn activity_guards_keep_cues_suppressed_until_every_owner_finishes() {
        let runtime = ManagedStatusSoundRuntime::spawn(None).unwrap();
        let first = runtime.begin_conversation_activity().unwrap();
        let second = runtime.begin_conversation_activity().unwrap();
        assert!(runtime.inner.activity.lock().unwrap().is_active());

        drop(first);
        assert!(runtime.inner.activity.lock().unwrap().is_active());
        runtime.set_conversation_active(true).unwrap();
        drop(second);
        assert!(runtime.inner.activity.lock().unwrap().is_active());

        runtime.set_conversation_active(false).unwrap();
        assert!(!runtime.inner.activity.lock().unwrap().is_active());
        runtime.finish().unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn speech_does_not_cancel_a_sample_already_playing() {
        struct PendingOutput;
        impl crate::PcmAudioOutput for PendingOutput {
            fn write(&self, _: &[f32]) -> Result<(), String> {
                Ok(())
            }
            fn cancel(&self) {}
            fn is_drained(&self) -> bool {
                false
            }
            fn check_health(&self) -> Result<(), String> {
                Ok(())
            }
            fn played_frames(&self) -> u64 {
                0
            }
        }
        let mut runtime = StatusSoundRuntime::default();
        runtime.player.active = Some(ActiveStatusSound {
            player: Box::new(PendingOutput),
            drain_deadline: Instant::now() + Duration::from_secs(10),
            output_tail_deadline: None,
            _input_activity: None,
        });
        assert!(runtime.poll(true).unwrap());
        assert!(runtime.player.active.is_some());
        runtime.stop();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn failed_or_expired_pending_cue_releases_microphone_suppression() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct PendingOutput {
            failed: bool,
            cancelled: Arc<AtomicBool>,
            controls: crate::input::VoiceInputControls,
        }
        impl crate::PcmAudioOutput for PendingOutput {
            fn write(&self, _: &[f32]) -> Result<(), String> {
                Ok(())
            }
            fn cancel(&self) {
                assert!(
                    self.controls.is_input_suppressed(),
                    "cancel before releasing input suppression"
                );
                self.cancelled.store(true, Ordering::SeqCst);
            }
            fn is_drained(&self) -> bool {
                false
            }
            fn check_health(&self) -> Result<(), String> {
                if self.failed {
                    Err("render failed while engine is running".into())
                } else {
                    Ok(())
                }
            }
            fn played_frames(&self) -> u64 {
                0
            }
        }
        for (failed, expired) in [(false, false), (true, false), (false, true)] {
            let controls = crate::input::VoiceInputControls::default();
            let cancelled = Arc::new(AtomicBool::new(false));
            let mut player = StatusSoundPlayer {
                working: Err("unused".into()),
                waiting: Err("unused".into()),
                active: Some(ActiveStatusSound {
                    player: Box::new(PendingOutput {
                        failed,
                        cancelled: Arc::clone(&cancelled),
                        controls: controls.clone(),
                    }),
                    drain_deadline: if expired {
                        Instant::now() - Duration::from_secs(1)
                    } else {
                        Instant::now() + Duration::from_secs(10)
                    },
                    output_tail_deadline: None,
                    _input_activity: Some(
                        controls
                            .begin_cue_activity(
                                crate::input::InputDuringTtsPolicy::SuppressInput,
                                None,
                            )
                            .unwrap(),
                    ),
                }),
            };
            assert!(controls.is_input_suppressed());
            player.reap();
            assert_eq!(player.is_active(), !failed && !expired);
            assert_eq!(controls.is_input_suppressed(), !failed && !expired);
            assert_eq!(cancelled.load(Ordering::SeqCst), failed || expired);
            player.stop();
            assert!(!controls.is_input_suppressed());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "opens the default CoreAudio output and plays the macOS Pop and Purr cues"]
    fn macos_player_keeps_only_one_status_cue_in_flight() {
        let mut player = StatusSoundPlayer::new();
        let controls = crate::input::VoiceInputControls::default();
        for status in [ConversationStatus::Working, ConversationStatus::Waiting] {
            player
                .play(
                    StatusSoundCue {
                        status,
                        volume: DEFAULT_STATUS_SOUND_VOLUME,
                    },
                    None,
                    Some(&controls),
                    crate::input::InputDuringTtsPolicy::SuppressInput,
                )
                .unwrap();
        }
        assert!(player.active.is_some());
        assert!(controls.is_input_suppressed());
        player.stop();
        assert!(!controls.is_input_suppressed());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "opens CoreAudio output and plays a status cue"]
    fn macos_cue_suppresses_input_until_audio_and_tail_drain() {
        let controls = crate::input::VoiceInputControls::default();
        let mut player = StatusSoundPlayer::new();
        player
            .play(
                StatusSoundCue {
                    status: ConversationStatus::Working,
                    volume: DEFAULT_STATUS_SOUND_VOLUME,
                },
                None,
                Some(&controls),
                crate::input::InputDuringTtsPolicy::SuppressInput,
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while player.is_active() {
            assert!(controls.is_input_suppressed());
            assert!(Instant::now() < deadline, "status cue did not drain");
            player.reap();
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!controls.is_input_suppressed());
    }
}
