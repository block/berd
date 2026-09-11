use std::{
    sync::mpsc::{self, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

pub const DEFAULT_STATUS_SOUND_VOLUME: f32 = 0.8;
pub const STATUS_SOUND_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StatusSoundMode {
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
}

impl Default for StatusSoundSettings {
    fn default() -> Self {
        Self {
            mode: StatusSoundMode::default(),
            volume: DEFAULT_STATUS_SOUND_VOLUME,
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
        let changed = self.current != Some(next);
        self.current = Some(next);
        changed
    }

    pub fn tick(&mut self, conversation_active: bool) -> Option<StatusSoundCue> {
        let (status, settings) = self.current?;
        let working_only = settings.mode == StatusSoundMode::Working;
        let waiting = status == ConversationStatus::Waiting;
        if conversation_active || (working_only && waiting) {
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
    player: StatusSoundPlayer,
    output_device: Option<String>,
    conversation_active: bool,
}

impl Default for StatusSoundRuntime {
    fn default() -> Self {
        Self {
            machine: StatusSoundStateMachine::default(),
            next_tick: None,
            player: StatusSoundPlayer::new(),
            output_device: None,
            conversation_active: false,
        }
    }
}

impl StatusSoundRuntime {
    pub fn set_output_device(&mut self, output_device: Option<String>) {
        if self.output_device != output_device {
            self.player.stop();
            self.output_device = output_device;
        }
    }

    pub fn update(&mut self, status: ConversationStatus, settings: StatusSoundSettings) {
        let changed = self.machine.update(status, settings);
        if changed {
            self.player.stop();
            self.next_tick = Some(Instant::now());
        }
    }

    pub fn stop(&mut self) {
        self.player.stop();
    }

    pub fn poll(&mut self, conversation_active: bool) -> Result<bool, String> {
        if conversation_active {
            self.stop();
        } else if self.conversation_active {
            self.next_tick = Some(Instant::now());
        }
        self.conversation_active = conversation_active;
        if conversation_active {
            self.player.reap();
            return Ok(false);
        }
        self.player.reap();
        let now = Instant::now();
        if self.next_tick.is_some_and(|deadline| now >= deadline) {
            self.next_tick = Some(now + STATUS_SOUND_INTERVAL);
            if let Some(cue) = self.machine.tick(conversation_active) {
                self.player.play(cue, self.output_device.as_deref())?;
            }
        }
        Ok(self.player.is_active())
    }
}

enum StatusSoundCommand {
    Update(ConversationStatus, StatusSoundSettings),
    ConversationActive(bool),
    OutputDevice(Option<String>),
    Shutdown,
}

/// Thread-safe status-sound service for hosts that do not own a polling loop.
#[derive(Clone)]
pub struct ManagedStatusSoundRuntime {
    commands: Sender<StatusSoundCommand>,
}

impl ManagedStatusSoundRuntime {
    pub fn spawn(output_device: Option<String>) -> Result<Self, String> {
        let (commands, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("berd-status-sounds".into())
            .spawn(move || {
                let mut runtime = StatusSoundRuntime::default();
                let mut conversation_active = false;
                runtime.set_output_device(output_device);
                loop {
                    match receiver.recv_timeout(Duration::from_millis(10)) {
                        Ok(StatusSoundCommand::Update(status, settings)) => {
                            runtime.update(status, settings);
                        }
                        Ok(StatusSoundCommand::ConversationActive(active)) => {
                            conversation_active = active;
                        }
                        Ok(StatusSoundCommand::OutputDevice(device)) => {
                            runtime.set_output_device(device);
                        }
                        Ok(StatusSoundCommand::Shutdown) | Err(RecvTimeoutError::Disconnected) => {
                            runtime.stop();
                            break;
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                    if let Err(message) = runtime.poll(conversation_active) {
                        eprintln!("status sound playback disabled: {message}");
                    }
                }
            })
            .map_err(|error| format!("Could not start status sound runtime: {error}"))?;
        drop(worker);
        Ok(Self { commands })
    }

    pub fn update(
        &self,
        status: ConversationStatus,
        settings: StatusSoundSettings,
    ) -> Result<(), String> {
        settings.validate().map_err(str::to_string)?;
        self.send(StatusSoundCommand::Update(status, settings))
    }

    pub fn set_conversation_active(&self, active: bool) -> Result<(), String> {
        self.send(StatusSoundCommand::ConversationActive(active))
    }

    pub fn set_output_device(&self, output_device: Option<String>) -> Result<(), String> {
        self.send(StatusSoundCommand::OutputDevice(output_device))
    }

    fn send(&self, command: StatusSoundCommand) -> Result<(), String> {
        self.commands
            .send(command)
            .map_err(|_| "Status sound runtime is unavailable".to_string())
    }

    pub fn finish(&self) {
        let _ = self.commands.send(StatusSoundCommand::Shutdown);
    }
}

#[cfg(not(target_os = "macos"))]
struct StatusSoundPlayer;

#[cfg(not(target_os = "macos"))]
impl StatusSoundPlayer {
    fn new() -> Self {
        Self
    }

    fn play(&mut self, _cue: StatusSoundCue, _output_device: Option<&str>) -> Result<(), String> {
        Err("status sound playback is only available on macOS".into())
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
struct ActiveStatusSound {
    player: crate::macos_audio_output::PocketAudioPlayer,
    output_tail_deadline: Option<Instant>,
}

#[cfg(target_os = "macos")]
struct StatusSoundPlayer {
    working: Result<StatusSoundAsset, String>,
    waiting: Result<StatusSoundAsset, String>,
    active: Vec<ActiveStatusSound>,
}

#[cfg(target_os = "macos")]
impl StatusSoundPlayer {
    fn new() -> Self {
        Self {
            working: load_system_sound("Pop"),
            waiting: load_system_sound("Purr"),
            active: Vec::new(),
        }
    }

    fn play(&mut self, cue: StatusSoundCue, output_device: Option<&str>) -> Result<(), String> {
        let asset = match cue.status {
            ConversationStatus::Working => &self.working,
            ConversationStatus::Waiting => &self.waiting,
        }
        .as_ref()
        .map_err(Clone::clone)?;
        let player = crate::macos_audio_output::PocketAudioPlayer::new(
            asset.sample_rate,
            1.0,
            output_device,
        )?;
        let samples = asset
            .samples
            .iter()
            .map(|sample| sample * cue.volume)
            .collect::<Vec<_>>();
        player.enqueue(&samples)?;
        self.active.push(ActiveStatusSound {
            player,
            output_tail_deadline: None,
        });
        Ok(())
    }

    fn reap(&mut self) {
        let now = Instant::now();
        self.active.retain_mut(|sound| {
            if !sound.player.is_empty() {
                sound.output_tail_deadline = None;
                return true;
            }
            let deadline = sound
                .output_tail_deadline
                .get_or_insert(now + STATUS_SOUND_OUTPUT_TAIL);
            now < *deadline
        });
    }

    fn is_active(&self) -> bool {
        !self.active.is_empty()
    }

    fn stop(&mut self) {
        for sound in self.active.drain(..) {
            sound.player.stop();
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
    fn resuming_after_conversation_audio_plays_without_waiting_for_old_cadence() {
        let mut runtime = StatusSoundRuntime::default();
        runtime.update(
            ConversationStatus::Working,
            settings(StatusSoundMode::Working),
        );
        assert!(!runtime.poll(true).unwrap());
        runtime.next_tick = Some(Instant::now() + Duration::from_secs(60));
        let _ = runtime.poll(false);
        assert!(runtime.next_tick.unwrap() < Instant::now() + STATUS_SOUND_INTERVAL);
    }

    #[test]
    fn session_volume_defaults_to_point_eight_and_accepts_an_override() {
        assert_eq!(StatusSoundSettings::default().volume, 0.8);
        let explicit = StatusSoundSettings {
            mode: StatusSoundMode::Working,
            volume: 0.25,
        };
        assert_eq!(explicit.validate().unwrap().volume, 0.25);
    }

    #[test]
    fn rejects_invalid_session_volume() {
        for volume in [f32::NAN, f32::INFINITY, -0.1, 1.1] {
            assert!(StatusSoundSettings {
                mode: StatusSoundMode::Working,
                volume,
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
        assert!(runtime.next_tick.unwrap() < Instant::now() + Duration::from_secs(1));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "opens the default CoreAudio output and plays the macOS Pop and Purr cues"]
    fn macos_player_decodes_and_queues_both_status_cues() {
        let mut player = StatusSoundPlayer::new();
        for status in [ConversationStatus::Working, ConversationStatus::Waiting] {
            player
                .play(
                    StatusSoundCue {
                        status,
                        volume: DEFAULT_STATUS_SOUND_VOLUME,
                    },
                    None,
                )
                .unwrap();
        }
        assert_eq!(player.active.len(), 2);
        player.stop();
    }
}
