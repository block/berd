use std::{
    sync::{mpsc::{self, RecvTimeoutError, Sender}, Arc, Mutex},
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
    input_controls: Option<crate::input::VoiceInputControls>,
}

impl Default for StatusSoundRuntime {
    fn default() -> Self {
        Self {
            machine: StatusSoundStateMachine::default(),
            next_tick: None,
            player: StatusSoundPlayer::new(),
            output_device: None,
            conversation_active: false,
            input_controls: None,
        }
    }
}

impl StatusSoundRuntime {
    pub fn set_input_controls(&mut self, controls: Option<crate::input::VoiceInputControls>) {
        self.input_controls = controls;
    }

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
                self.player.play(cue, self.output_device.as_deref(), self.input_controls.as_ref())?;
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
    inner: Arc<StatusSoundWorker>,
}

struct StatusSoundWorker {
    commands: Sender<StatusSoundCommand>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
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
        Ok(Self {
            inner: Arc::new(StatusSoundWorker {
                commands,
                worker: Mutex::new(Some(worker)),
            }),
        })
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
        self.inner.commands
            .send(command)
            .map_err(|_| "Status sound runtime is unavailable".to_string())
    }

    pub fn finish(&self) -> Result<(), String> {
        let _ = self.inner.commands.send(StatusSoundCommand::Shutdown);
        let worker = self.inner.worker.lock()
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
            worker.join().map_err(|_| "Status sound worker panicked".to_string())?;
        }
        Ok(())
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

    fn play(&mut self, _cue: StatusSoundCue, _output_device: Option<&str>, _input_controls: Option<&crate::input::VoiceInputControls>) -> Result<(), String> {
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
    _input_activity: Option<crate::input::AssistantActivityGuard>,
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

    fn play(&mut self, cue: StatusSoundCue, output_device: Option<&str>, input_controls: Option<&crate::input::VoiceInputControls>) -> Result<(), String> {
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
        let input_activity = input_controls.map(|controls| {
            controls.begin_assistant_activity(0.65, crate::input::InputDuringTtsPolicy::SuppressInput)
        }).transpose()?;
        player.enqueue(&samples)?;
        self.active.push(ActiveStatusSound {
            player,
            output_tail_deadline: None,
            _input_activity: input_activity,
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
            }),
        };
        drop(runtime);
        completed.recv_timeout(Duration::from_secs(2)).unwrap();
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
                )
                .unwrap();
        }
        assert_eq!(player.active.len(), 2);
        assert!(controls.is_muted());
        player.stop();
        assert!(!controls.is_muted());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "opens CoreAudio output and plays a status cue"]
    fn macos_cue_suppresses_input_until_audio_and_tail_drain() {
        let controls = crate::input::VoiceInputControls::default();
        let mut player = StatusSoundPlayer::new();
        player.play(StatusSoundCue {
            status: ConversationStatus::Working,
            volume: DEFAULT_STATUS_SOUND_VOLUME,
        }, None, Some(&controls)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while player.is_active() {
            assert!(controls.is_muted());
            assert!(Instant::now() < deadline, "status cue did not drain");
            player.reap();
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!controls.is_muted());
    }
}
