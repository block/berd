#![cfg(target_os = "macos")]

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{json, Value};

use berd_call::input::InputDuringTtsPolicy;
use berd_call::openai_realtime_protocol::{
    RealtimeExpertDeliveryEvent, RealtimeExpertDeliveryRole,
};
use berd_call::protocol::{
    NotAdmittedReason, OutputReadyOutcome, SessionMessage, SessionRequest, UtteranceOrigin,
    VoiceSessionSnapshot,
};
use berd_call::PocketAudioPlayer;

use crate::codex::{self, CodexRecord, CodexRelay, CodexTarget};
use crate::hooks::{HookBinding, HookEvent, Reply, UNHEARD};
use crate::host_control::{ControlServer, HostControl};
use crate::saved_settings;
use crate::session_audio::{
    AUDIO_BEGIN_KIND, AUDIO_CANCEL_KIND, AUDIO_CHUNK_KIND, AUDIO_END_KIND,
    AUDIO_FRAME_HEADER_BYTES, AUDIO_FRAME_MAGIC, AUDIO_FRAME_MARKER,
};
use crate::session_framing::{
    encode_frame, JSON_FRAME_KIND, PCM_FRAME_KIND, SESSION_PROTOCOL_VERSION,
};
use crate::{StartOptions, TranscriptDestination};

const NON_BLOCKING_REQUIRES_DELIVERY: &str =
    "non-blocking speech requires start --stream or --codex for delivery events";
const CLEAN_STOP: &str = "Berd Call stopped after a stop request. This is a clean shutdown, not a crash. Do not restart it unless asked.";
// How long a restart waits for speech to finish before cutting it off: longer than a typical spoken reply.
const RESTART_SPEECH_WAIT: Duration = Duration::from_secs(60);
const INPUT_FRAME_SAMPLES: usize = 960;
const MAX_AUDIO_RECORD_BYTES: usize = 4096 * std::mem::size_of::<f32>() + 16;

pub(crate) fn run(options: StartOptions) -> Result<(), String> {
    let server = ControlServer::bind(options.port)?;
    let hooks = Arc::new(HookBinding::new(
        options
            .hook_session
            .clone()
            .or_else(crate::hooks::environment_session),
        options.port,
    ));
    let transcript = Arc::new(Transcript::for_options(&options)?);
    transcript.start()?;
    let non_blocking = Arc::new(AtomicBool::new(options.non_blocking));
    let stop_requested = Arc::new(AtomicBool::new(false));
    if matches!(&*transcript, Transcript::Stdout { .. }) {
        crate::host_lifetime::watch_stdout(Arc::clone(&stop_requested))?;
    }
    let status_sounds = Arc::new(Mutex::new(StatusSounds {
        mode: options
            .saved
            .as_ref()
            .and_then(|(_, saved)| saved.status_sounds)
            .unwrap_or_default(),
        status: None,
    }));
    let mut session = SessionStart {
        saved: options.saved.clone(),
        arguments: options.session_arguments,
        expert_spokesperson: options.expert_spokesperson,
        muted: Arc::new(AtomicBool::new(false)),
        mute_epoch: Arc::new(AtomicU64::new(0)),
        system_input_mute: None,
        input_during_tts: options
            .saved
            .as_ref()
            .and_then(|(_, saved)| saved.input_policy)
            .unwrap_or_else(default_input_during_tts_policy),
        restarted: None,
    };
    loop {
        match run_session(
            &server,
            session,
            &transcript,
            &non_blocking,
            &stop_requested,
            &status_sounds,
            &hooks,
        ) {
            Ok(None) => {
                transcript.finish(CLEAN_STOP);
                return Ok(());
            }
            // A stop recorded while the old session was shutting down wins
            // over the restart it would otherwise hand off to.
            Ok(Some(next)) if stop_requested.load(Ordering::SeqCst) => {
                if let Some(response) = next.restarted {
                    let _ = response.send(Err("voice call stopped".into()));
                }
                transcript.finish(CLEAN_STOP);
                return Ok(());
            }
            Ok(Some(next)) => {
                session = next;
            }
            Err(_) if stop_requested.load(Ordering::SeqCst) => {
                transcript.finish(CLEAN_STOP);
                return Ok(());
            }
            Err(message) => {
                transcript.finish(&format!("Berd Call failed: {message}"));
                return Err(message);
            }
        }
    }
}

/// Where live transcript records go: nowhere, stdout TSV, or a Codex task.
pub(crate) enum Transcript {
    Silent,
    Stdout { live: bool },
    Codex(CodexRelay),
}

impl Transcript {
    fn for_options(options: &StartOptions) -> Result<Self, String> {
        Ok(match options.transcript {
            TranscriptDestination::None => Self::Silent,
            TranscriptDestination::Stdout { live } => Self::Stdout { live },
            TranscriptDestination::Codex => {
                let target = CodexTarget::from_environment()?;
                let executable = std::env::current_exe().map_err(|error| {
                    format!("could not resolve the berd-call executable: {error}")
                })?;
                Self::Codex(CodexRelay::start(
                    target,
                    codex::guidance(&executable, options.port),
                ))
            }
        })
    }

    /// Whether interruption and failure reports reach the agent.
    fn delivers(&self) -> bool {
        !matches!(self, Self::Silent)
    }

    fn start(&self) -> Result<(), String> {
        match self {
            Self::Stdout { .. } => print_flushed("cursor\trole\ttext"),
            Self::Codex(_) => {
                println!("Berd Call is delivering transcripts to this Codex task.");
                Ok(())
            }
            Self::Silent => Ok(()),
        }
    }

    fn record(
        &self,
        cursor: Option<u64>,
        role: &str,
        handoff_id: Option<&str>,
        text: &str,
    ) -> Result<(), String> {
        match self {
            Self::Silent => Ok(()),
            Self::Stdout { .. } => print_flushed(&format!(
                "{}\t{role}\t{}",
                cursor.unwrap_or_default(),
                stream_text(text)
            )),
            Self::Codex(relay) => {
                relay.send(CodexRecord {
                    cursor,
                    role: role.to_string(),
                    handoff_id: handoff_id.map(str::to_string),
                    text: text.to_string(),
                });
                Ok(())
            }
        }
    }

    /// Reports why the call ended, then drains any pending delivery.
    fn finish(&self, text: &str) {
        match self {
            Self::Silent => {}
            Self::Stdout { .. } => {
                let _ = self.record(None, "lifecycle", None, text);
            }
            Self::Codex(relay) => relay.finish(Some(CodexRecord {
                cursor: None,
                role: "lifecycle".into(),
                handoff_id: None,
                text: text.to_string(),
            })),
        }
    }
}

fn user_interim_line(cursor: u64, text: &str) -> String {
    format!(
        "0\tuser_interim\t{}",
        json!({"cursor": cursor, "text": text})
    )
}

fn input_activity_line(speaking: bool, recognizing: bool) -> String {
    format!(
        "0\tinput_activity\t{}",
        json!({"speaking": speaking, "recognizing": recognizing})
    )
}

fn print_flushed(line: &str) -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{line}")
        .and_then(|()| stdout.flush())
        .map_err(|error| format!("could not flush voice stream: {error}"))
}

struct SessionStart {
    saved: Option<(std::path::PathBuf, crate::saved_settings::SavedSettings)>,
    arguments: Vec<String>,
    expert_spokesperson: bool,
    muted: Arc<AtomicBool>,
    mute_epoch: Arc<AtomicU64>,
    system_input_mute: Option<crate::system_input_mute::SystemInputMute>,
    input_during_tts: InputDuringTtsPolicy,
    restarted: Option<SyncSender<Result<Value, String>>>,
}

fn run_session(
    server: &ControlServer,
    start: SessionStart,
    transcript: &Arc<Transcript>,
    non_blocking: &Arc<AtomicBool>,
    stop_requested: &Arc<AtomicBool>,
    status_sounds: &Arc<Mutex<StatusSounds>>,
    hooks: &Arc<HookBinding>,
) -> Result<Option<SessionStart>, String> {
    let SessionStart {
        saved,
        arguments,
        expert_spokesperson,
        muted,
        mute_epoch,
        system_input_mute,
        input_during_tts,
        restarted,
    } = start;
    let started = start_session(
        arguments,
        expert_spokesperson,
        muted,
        mute_epoch,
        system_input_mute,
        input_during_tts,
        transcript,
        non_blocking,
        stop_requested,
        status_sounds,
        hooks,
        saved,
    );
    let StartedSession {
        mut child,
        mut actor,
        control,
        mut capture,
        failure_rx,
        running,
    } = match started {
        Ok(started) => started,
        Err(message) => {
            if let Some(response) = restarted {
                let _ = response.send(Err(message.clone()));
            }
            return Err(message);
        }
    };
    if let Some(response) = restarted {
        transcript.record(
            Some(0),
            "lifecycle",
            None,
            "session restarted; transcript cursors reset",
        )?;
        let _ = response.send(control.status());
    }
    let control: Arc<dyn HostControl> = control;
    while running.load(Ordering::SeqCst) {
        server.poll(Arc::clone(&control))?;
        // A stop can be recorded by a control connection that outlived the
        // session it was sent to, so the flag, not the command, is authoritative.
        if stop_requested.load(Ordering::SeqCst) {
            actor.stop()?;
        }
        actor.poll()?;
        if !actor.stopping {
            capture.poll(&mut actor)?;
        }
        match failure_rx.try_recv() {
            Ok(message) => return Err(message),
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                return Err("voice host workers stopped unexpectedly".into())
            }
        }
        if actor.stopping {
            running.store(false, Ordering::SeqCst);
        }
        thread::sleep(Duration::from_millis(2));
    }
    drop(capture);
    child.wait_for_exit()?;
    let restart = actor.restart.take();
    actor.finish_pending(if restart.is_some() {
        "voice session restarted"
    } else {
        "voice call stopped"
    });
    Ok(restart.map(|restart| actor.restart_start(restart, input_during_tts)))
}

impl SessionActor {
    fn restart_start(
        &mut self,
        restart: PendingRestart,
        input_during_tts: InputDuringTtsPolicy,
    ) -> SessionStart {
        let mut arguments = restart.arguments;
        SessionStart {
            saved: self.saved.take().map(|(path, mut saved)| {
                // Calls whose replies don't have their own voice keep the Spokesperson's for later.
                let kept = saved_settings::only_spokesperson(&saved.arguments);
                saved.arguments = saved_settings::merge_arguments(
                    &kept,
                    &saved_settings::persistable_arguments(&arguments[1..]),
                );
                saved.tts = restart.tts;
                // Turning the Spokesperson back on starts with its saved voice.
                if arguments
                    .iter()
                    .any(|argument| argument == crate::DIRECT_AGENT_SPEECH)
                    && !arguments
                        .iter()
                        .any(|argument| argument == "--spokesperson-voice")
                {
                    if let Some(voice) = kept
                        .chunks_exact(2)
                        .find(|pair| pair[0] == "--spokesperson-voice")
                    {
                        arguments.splice(1..1, voice.iter().cloned());
                    }
                }
                (path, saved)
            }),
            arguments,
            expert_spokesperson: restart.expert_spokesperson,
            // Keep native registration and shared intent across session handoffs
            // so gestures remain effective.
            muted: self.capture_muted.clone(),
            mute_epoch: self.capture_mute_epoch.clone(),
            system_input_mute: self.system_input_mute.take(),
            input_during_tts: self
                .session
                .lock()
                .map(|session| session.input_during_tts.policy)
                .unwrap_or(input_during_tts),
            restarted: Some(restart.response),
        }
    }
}

struct StartedSession {
    child: SessionProcess,
    actor: SessionActor,
    control: Arc<SessionControl>,
    capture: DefaultInputCapture,
    failure_rx: Receiver<String>,
    running: Arc<AtomicBool>,
}

#[allow(clippy::too_many_arguments)]
fn start_session(
    arguments: Vec<String>,
    expert_spokesperson: bool,
    muted: Arc<AtomicBool>,
    mute_epoch: Arc<AtomicU64>,
    system_input_mute: Option<crate::system_input_mute::SystemInputMute>,
    input_during_tts: InputDuringTtsPolicy,
    transcript: &Arc<Transcript>,
    non_blocking: &Arc<AtomicBool>,
    stop_requested: &Arc<AtomicBool>,
    status_sounds: &Arc<Mutex<StatusSounds>>,
    hooks: &Arc<HookBinding>,
    saved: Option<(std::path::PathBuf, crate::saved_settings::SavedSettings)>,
) -> Result<StartedSession, String> {
    let mut child = SessionProcess::spawn(arguments.clone())?;
    let writer = Arc::new(Mutex::new(child.take_stdin()?));
    let (event_tx, event_rx) = mpsc::sync_channel(128);
    spawn_stdout_reader(child.take_stdout()?, event_tx)?;
    let (audio_command_tx, audio_command_rx) = mpsc::sync_channel(16);
    let (failure_tx, failure_rx) = mpsc::sync_channel(1);
    spawn_audio_host(
        child.take_audio()?,
        Arc::clone(&writer),
        audio_command_rx,
        failure_tx.clone(),
    )?;

    send_request(
        &writer,
        &SessionRequest::Hello {
            id: 1,
            input_during_tts,
            status_sound_output_device: None,
        },
    )?;
    let ready = receive_ready(&event_rx, stop_requested)?;
    let running = Arc::new(AtomicBool::new(true));
    let (command_tx, command_rx) = mpsc::sync_channel(32);
    let mut actor = SessionActor::new(
        Arc::clone(&writer),
        event_rx,
        command_rx,
        audio_command_tx,
        Arc::clone(&ready.session),
        Arc::clone(transcript),
        expert_spokesperson,
    );
    actor.saved = saved;
    actor
        .muted
        .store(muted.load(Ordering::SeqCst), Ordering::SeqCst);
    actor.capture_muted = muted;
    actor.capture_mute_epoch = mute_epoch;
    actor.system_input_mute = system_input_mute;
    if actor.system_input_mute.is_none() {
        match crate::system_input_mute::SystemInputMute::install(
            actor.capture_muted.clone(),
            actor.capture_mute_epoch.clone(),
        ) {
            Ok(listener) => actor.system_input_mute = Some(listener),
            Err(error) => eprintln!("System input mute unavailable: {error}"),
        }
    }
    if let Some(settings) = actor
        .saved
        .as_ref()
        .and_then(|(_, saved)| saved.tts.clone())
    {
        let revision = ready
            .session
            .lock()
            .map_err(|_| "session settings lock failed")?
            .tts
            .revision;
        actor.restore_saved_tts(settings, revision, Duration::from_secs(30))?;
    }
    actor.restore_input_mute()?;
    actor.status_sounds = Arc::clone(status_sounds);
    let sounds = *status_sounds
        .lock()
        .map_err(|_| "status sounds lock failed")?;
    actor.send_status_sounds(sounds)?;
    let capture = DefaultInputCapture::start(
        writer,
        failure_tx,
        actor.capture_muted.clone(),
        actor.capture_mute_epoch.clone(),
    )?;
    actor.persist_settings(SavedPreference::SessionStart);
    let control = Arc::new(SessionControl {
        commands: command_tx,
        running: Arc::clone(&running),
        ready: ready.clone(),
        non_blocking: Arc::clone(non_blocking),
        stop_requested: Arc::clone(stop_requested),
        muted: Arc::clone(&actor.muted),
        status_sounds: Arc::clone(status_sounds),
        transcript: Arc::clone(transcript),
        speaks: !expert_spokesperson
            || arguments
                .iter()
                .any(|argument| argument == crate::DIRECT_AGENT_SPEECH),
        session_arguments: arguments,
        hooks: Arc::clone(hooks),
    });
    Ok(StartedSession {
        child,
        actor,
        control,
        capture,
        failure_rx,
        running,
    })
}

fn default_input_during_tts_policy() -> InputDuringTtsPolicy {
    InputDuringTtsPolicy::Auto
}

/// Session options for these speech settings, keeping a Pocket model directory from `arguments`.
fn tts_arguments(settings: &berd_call::TtsSettings, arguments: &[String]) -> Vec<String> {
    let pocket_model_dir = arguments
        .chunks_exact(2)
        .find(|pair| pair[0] == "--model-dir")
        .map(|pair| pair[1].clone());
    let backend = match settings {
        berd_call::TtsSettings::Siri { .. } => "siri",
        berd_call::TtsSettings::Pocket { .. } => "pocket",
        berd_call::TtsSettings::OpenAi { .. } => "openai",
    };
    let mut replacement = vec![
        "--tts-backend".to_string(),
        backend.to_string(),
        "--rate".to_string(),
        settings.rate().to_string(),
    ];
    match settings {
        berd_call::TtsSettings::Siri {
            voice, language, ..
        } => replacement.extend([
            "--voice".into(),
            voice.clone(),
            "--language".into(),
            language.clone(),
        ]),
        berd_call::TtsSettings::Pocket { voice, .. } => {
            if let Some(model_dir) = pocket_model_dir {
                replacement.extend(["--model-dir".into(), model_dir]);
            }
            replacement.extend(["--voice".into(), voice.clone()])
        }
        berd_call::TtsSettings::OpenAi { .. } => {}
    }
    replacement
}

/// The call's status sounds, kept across session restarts.
#[derive(Clone, Copy, Default)]
struct StatusSounds {
    mode: berd_call::StatusSoundMode,
    // Unknown until a host reports it, so a call nothing reports on stays silent.
    status: Option<berd_call::ConversationStatus>,
}

#[derive(Clone)]
struct ReadyState {
    session: Arc<Mutex<VoiceSessionSnapshot>>,
}

enum ControlCommand {
    PollInput {
        since: Option<u64>,
        wait: bool,
        timeout_seconds: u64,
        response: SyncSender<Result<Value, String>>,
    },
    InputDuringTts {
        policy: InputDuringTtsPolicy,
        expected_revision: u64,
        response: SyncSender<Result<Value, String>>,
    },
    Muted {
        muted: bool,
        response: SyncSender<Result<Value, String>>,
    },
    StatusSounds {
        mode: Option<berd_call::StatusSoundMode>,
        status: Option<berd_call::ConversationStatus>,
        response: SyncSender<Result<Value, String>>,
    },
    TtsSettings {
        settings: berd_call::TtsSettings,
        expected_revision: u64,
        response: SyncSender<Result<Value, String>>,
    },
    SpokespersonSettings {
        settings: berd_call::TtsSettings,
        expected_revision: u64,
        response: SyncSender<Result<Value, String>>,
    },
    Speak {
        text: String,
        acknowledgement: Option<u64>,
        resolved_handoff_ids: Vec<String>,
        voice: Option<String>,
        language: Option<String>,
        relay: bool,
        non_blocking: bool,
        response: SyncSender<Result<Value, String>>,
    },
    Stop {
        response: SyncSender<Result<Value, String>>,
    },
    Restart {
        arguments: Vec<String>,
        expert_spokesperson: bool,
        // Speech settings to restore in the new session, beyond what its options can say.
        tts: Option<berd_call::TtsSettings>,
        response: SyncSender<Result<Value, String>>,
    },
}

struct PendingRestart {
    arguments: Vec<String>,
    expert_spokesperson: bool,
    tts: Option<berd_call::TtsSettings>,
    response: SyncSender<Result<Value, String>>,
}

struct SessionControl {
    commands: SyncSender<ControlCommand>,
    running: Arc<AtomicBool>,
    ready: ReadyState,
    non_blocking: Arc<AtomicBool>,
    stop_requested: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
    status_sounds: Arc<Mutex<StatusSounds>>,
    transcript: Arc<Transcript>,
    // Whether the Expert may speak to the user rather than only through the Spokesperson.
    speaks: bool,
    session_arguments: Vec<String>,
    hooks: Arc<HookBinding>,
}

impl SessionControl {
    /// Tells the call whether the agent is working, unless it already knows.
    fn report(&self, status: berd_call::ConversationStatus) {
        if self
            .status_sounds
            .lock()
            .is_ok_and(|sounds| sounds.status != Some(status))
        {
            let _ = self.request(|response| ControlCommand::StatusSounds {
                mode: None,
                status: Some(status),
                response,
            });
        }
    }

    /// Says `text` to the user without waiting for it, as the agent would.
    fn announce(&self, text: &str) {
        let (response, _) = mpsc::sync_channel(1);
        let _ = self.commands.send(ControlCommand::Speak {
            text: text.into(),
            acknowledgement: None,
            resolved_handoff_ids: Vec::new(),
            voice: None,
            language: None,
            relay: !self.speaks,
            non_blocking: false,
            response,
        });
    }

    fn restart_with(
        &self,
        session_arguments: Vec<String>,
        tts: Option<berd_call::TtsSettings>,
    ) -> Result<Value, String> {
        let expert_spokesperson = crate::validate_session_arguments(&session_arguments)?;
        let (response, result) = mpsc::sync_channel(1);
        self.commands
            .send(ControlCommand::Restart {
                arguments: session_arguments,
                expert_spokesperson,
                tts,
                response,
            })
            .map_err(|_| "voice call is not running")?;
        result
            .recv()
            .map_err(|_| "voice call stopped during restart".to_string())?
    }

    fn request(
        &self,
        command: impl FnOnce(SyncSender<Result<Value, String>>) -> ControlCommand,
    ) -> Result<Value, String> {
        let (response, result) = mpsc::sync_channel(1);
        self.commands
            .send(command(response))
            .map_err(|_| "voice call is not running")?;
        result
            .recv()
            .map_err(|_| "voice call stopped during settings update")?
    }
}

impl HostControl for SessionControl {
    fn poll_input(
        &self,
        since: Option<u64>,
        wait: bool,
        timeout_seconds: u64,
    ) -> Result<Value, String> {
        self.request(|response| ControlCommand::PollInput {
            since,
            wait,
            timeout_seconds,
            response,
        })
    }
    fn set_tts(&self, settings: berd_call::TtsSettings) -> Result<Value, String> {
        let expected_revision = self
            .ready
            .session
            .lock()
            .map_err(|_| "session settings lock failed")?
            .tts
            .revision;
        self.request(|response| ControlCommand::TtsSettings {
            settings,
            expected_revision,
            response,
        })
    }

    fn set_rate(&self, rate: f32) -> Result<Value, String> {
        let (previous, expected_revision, spokesperson) = {
            let session = self
                .ready
                .session
                .lock()
                .map_err(|_| "session settings lock failed")?;
            // The Spokesperson keeps as close to the agents' speed as it can.
            let spokesperson = session.spokesperson.as_ref().map(|spokesperson| {
                (
                    spokesperson
                        .settings
                        .clone()
                        .with_rate(crate::spokesperson_speed(rate)),
                    spokesperson.revision,
                )
            });
            (
                session.tts.settings.clone(),
                session.tts.revision,
                spokesperson,
            )
        };
        let status = self.request(|response| ControlCommand::TtsSettings {
            settings: previous.clone().with_rate(rate),
            expected_revision,
            response,
        })?;
        // A rate the agents' voice refuses leaves the Spokesperson's alone too.
        let Some((settings, expected_revision)) =
            spokesperson.filter(|_| status["outcome"] == "applied")
        else {
            return Ok(status);
        };
        let result = self.request(|response| ControlCommand::SpokespersonSettings {
            settings,
            expected_revision,
            response,
        });
        // One the Spokesperson refuses puts the agents' back, so the voices never disagree.
        if let (false, Some(expected_revision)) = (
            matches!(&result, Ok(value) if value["outcome"] == "applied"),
            status["snapshot"]["revision"].as_u64(),
        ) {
            let _ = self.request(|response| ControlCommand::TtsSettings {
                settings: previous,
                expected_revision,
                response,
            });
        }
        result
    }

    fn set_voice(&self, voice: String, language: Option<String>) -> Result<Value, String> {
        let (mut settings, expected_revision) = {
            let session = self
                .ready
                .session
                .lock()
                .map_err(|_| "session settings lock failed")?;
            (session.tts.settings.clone(), session.tts.revision)
        };
        match &mut settings {
            berd_call::TtsSettings::Siri {
                voice: selected,
                language: locale,
                ..
            } => {
                *selected = voice;
                if let Some(language) = language {
                    *locale = language;
                }
            }
            berd_call::TtsSettings::Pocket {
                voice: selected, ..
            }
            | berd_call::TtsSettings::OpenAi {
                voice: selected, ..
            } => {
                if language.is_some() {
                    return Err("language applies only to Siri voices".into());
                }
                *selected = voice;
            }
        }
        self.request(|response| ControlCommand::TtsSettings {
            settings,
            expected_revision,
            response,
        })
    }

    fn set_spokesperson(&self, voice: Option<String>, rate: Option<f32>) -> Result<Value, String> {
        let (mut settings, expected_revision) = {
            let session = self
                .ready
                .session
                .lock()
                .map_err(|_| "session settings lock failed")?;
            let spokesperson = session
                .spokesperson
                .as_ref()
                .ok_or("this call has no separate Spokesperson voice; use --voice and --rate")?;
            (spokesperson.settings.clone(), spokesperson.revision)
        };
        if let (
            Some(voice),
            berd_call::TtsSettings::OpenAi {
                voice: selected, ..
            },
        ) = (voice, &mut settings)
        {
            *selected = voice;
        }
        if let Some(rate) = rate {
            settings = settings.with_rate(rate);
        }
        self.request(|response| ControlCommand::SpokespersonSettings {
            settings,
            expected_revision,
            response,
        })
    }

    fn set_input_during_tts(&self, policy: InputDuringTtsPolicy) -> Result<Value, String> {
        let expected_revision = self
            .ready
            .session
            .lock()
            .map_err(|_| "session settings lock failed")?
            .input_during_tts
            .revision;
        self.request(|response| ControlCommand::InputDuringTts {
            policy,
            expected_revision,
            response,
        })
    }

    fn set_muted(&self, muted: bool) -> Result<Value, String> {
        self.request(|response| ControlCommand::Muted { muted, response })?;
        self.status()
    }

    fn set_status_sounds(
        &self,
        mode: Option<berd_call::StatusSoundMode>,
        status: Option<berd_call::ConversationStatus>,
    ) -> Result<Value, String> {
        self.request(|response| ControlCommand::StatusSounds {
            mode,
            status,
            response,
        })?;
        self.status()
    }

    fn restart(&self, session_arguments: Vec<String>) -> Result<Value, String> {
        self.restart_with(session_arguments, None)
    }

    fn set_spokesperson_mode(&self, on: bool) -> Result<Value, String> {
        let realtime = crate::validate_session_arguments(&self.session_arguments)?;
        // Without the one flag that takes no value, so the rest pair up.
        let arguments: Vec<_> = self.session_arguments[1..]
            .iter()
            .filter(|argument| *argument != crate::DIRECT_AGENT_SPEECH)
            .cloned()
            .collect();
        let arguments = &arguments[..];
        if on == realtime {
            return self.status();
        }
        let direct = matches!(*self.transcript, Transcript::Stdout { live: true });
        let live = self
            .ready
            .session
            .lock()
            .map_err(|_| "session settings lock failed")?
            .tts
            .settings
            .clone();
        // Agents keep the voice they have now, if they speak before and after; otherwise the Spokesperson's voice is
        // its own, and only their speed carries over.
        let tts = (self.speaks && (!on || direct)).then(|| live.clone());
        let arguments = crate::saved_settings::merge_arguments(
            arguments,
            &match &tts {
                Some(settings) => tts_arguments(settings, arguments),
                None => vec!["--rate".into(), live.rate().to_string()],
            },
        );
        let mut session_arguments = vec!["session".to_string()];
        session_arguments.extend(crate::saved_settings::with_spokesperson(
            &arguments, on, direct,
        ));
        self.restart_with(session_arguments, tts)
    }

    fn set_non_blocking(&self, enabled: bool) -> Result<Value, String> {
        if enabled && !self.transcript.delivers() {
            return Err(NON_BLOCKING_REQUIRES_DELIVERY.into());
        }
        self.non_blocking.store(enabled, Ordering::SeqCst);
        self.status()
    }

    fn status(&self) -> Result<Value, String> {
        let sounds = *self
            .status_sounds
            .lock()
            .map_err(|_| "status sounds lock failed")?;
        Ok(json!({
            "running": self.running.load(Ordering::SeqCst),
            "session": *self.ready.session.lock().map_err(|_| "session settings lock failed")?,
            "nonBlocking": self.non_blocking.load(Ordering::SeqCst),
            "muted": self.muted.load(Ordering::SeqCst),
            "statusSounds": sounds.mode,
            "conversationStatus": sounds.status,
            "sessionArguments": &self.session_arguments[1..],
        }))
    }

    fn speak(
        &self,
        text: String,
        acknowledgement: Option<u64>,
        resolved_handoff_ids: Vec<String>,
        voice: Option<String>,
        language: Option<String>,
        relay: bool,
    ) -> Result<Value, String> {
        if !relay && !self.speaks {
            return Err(format!(
                "the Expert speaks through the Spokesperson: use message-spokesperson, or start the call with {}",
                crate::DIRECT_AGENT_SPEECH
            ));
        }
        let (tx, rx) = mpsc::sync_channel(1);
        self.commands
            .send(ControlCommand::Speak {
                text,
                acknowledgement,
                resolved_handoff_ids,
                voice,
                language,
                relay,
                non_blocking: self.non_blocking.load(Ordering::SeqCst),
                response: tx,
            })
            .map_err(|_| "voice call is not running".to_string())?;
        let result = rx
            .recv()
            .map_err(|_| "voice call stopped before speech completed".to_string())?;
        if result.as_ref().is_ok_and(|value| {
            matches!(
                value["status"].as_str(),
                Some("completed" | "interrupted" | "accepted")
            )
        }) {
            self.hooks.worked.store(false, Ordering::SeqCst);
        }
        result
    }

    fn hook(
        &self,
        event: HookEvent,
        session_id: &str,
        subagent: bool,
        call: bool,
    ) -> Result<Value, String> {
        if !self.hooks.holds(session_id, subagent) {
            return Ok(json!({}));
        }
        let reply = Reply {
            relays: !self.speaks,
            port: self.hooks.port,
        };
        // Input the agent hasn't answered. If the session can't say in time, the hook lets the agent go on.
        let unanswered = || {
            self.poll_input(None, false, 1)
                .ok()
                .and_then(|poll| reply.unanswered(&poll))
        };
        let block = match event {
            HookEvent::PromptSubmit | HookEvent::PostTool => {
                self.report(berd_call::ConversationStatus::Working);
                None
            }
            // Working the call itself is never refused, so the agent can always answer.
            HookEvent::PreTool if call => None,
            HookEvent::PreTool => {
                self.hooks.worked.store(true, Ordering::SeqCst);
                self.report(berd_call::ConversationStatus::Working);
                unanswered()
            }
            HookEvent::Stop => unanswered()
                .or_else(|| {
                    self.hooks
                        .worked
                        .load(Ordering::SeqCst)
                        .then(|| reply.unspoken())
                })
                .or_else(|| {
                    self.report(berd_call::ConversationStatus::Waiting);
                    (!self.transcript.delivers()).then(|| UNHEARD.to_string())
                }),
            HookEvent::PermissionRequest => {
                self.report(berd_call::ConversationStatus::Waiting);
                self.announce("I need you to review a permission request.");
                None
            }
        };
        Ok(block.map_or_else(|| json!({}), |reason| json!({ "block": reason })))
    }

    fn stop(&self) -> Result<Value, String> {
        // Recorded before enqueueing, so a stop that races a restart handoff
        // still ends the call even if this session never reads the command.
        self.stop_requested.store(true, Ordering::SeqCst);
        let (tx, rx) = mpsc::sync_channel(1);
        if self
            .commands
            .send(ControlCommand::Stop { response: tx })
            .is_err()
        {
            return Ok(json!({"stopping":true}));
        }
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Disconnected) => Ok(json!({"stopping":true})),
            Err(mpsc::RecvTimeoutError::Timeout) => Err("timed out stopping voice call".into()),
        }
    }
}

struct PendingSpeak {
    prepare_id: u64,
    text: String,
    non_blocking: bool,
    response: Option<SyncSender<Result<Value, String>>>,
}

enum AudioCommand {
    Drain(SyncSender<()>),
    Suspend(u64),
    Resume(u64),
}

enum SavedPreference {
    SessionStart,
    Tts,
    Spokesperson,
    InputPolicy,
    StatusSounds(berd_call::StatusSoundMode),
}

struct SessionActor {
    saved: Option<(std::path::PathBuf, crate::saved_settings::SavedSettings)>,
    input_speaking: bool,
    recognition_pending: bool,
    interim_shown: bool,
    pending_polls: Vec<PendingInputPoll>,
    writer: Arc<Mutex<ChildStdin>>,
    events: Receiver<SessionMessage>,
    commands: Receiver<ControlCommand>,
    audio_commands: SyncSender<AudioCommand>,
    next_id: u64,
    pending_speak: Option<PendingSpeak>,
    pending_settings: std::collections::HashMap<u64, SyncSender<Result<Value, String>>>,
    // Settings requests answered with the Spokesperson's voice rather than the call's.
    spokesperson_settings: HashSet<u64>,
    waiting_speaks: VecDeque<ControlCommand>,
    session: Arc<Mutex<VoiceSessionSnapshot>>,
    transcript: Arc<Transcript>,
    expert_spokesperson: bool,
    // User rows already streamed when transcribed, left out of the Expert batch.
    transcribed: HashSet<u64>,
    stopping: bool,
    restart: Option<PendingRestart>,
    // When a restart waiting for speech to end stops waiting.
    restart_not_after: Instant,
    // A restart needs the host to consume prior ingress and finish playback.
    audio_drain: Option<Receiver<()>>,
    muted: Arc<AtomicBool>,
    status_sounds: Arc<Mutex<StatusSounds>>,
    // Requested sounds and any mode change, committed when the session applies them.
    pending_status_sounds: BTreeMap<u64, (StatusSounds, Option<berd_call::StatusSoundMode>)>,
    suppress_startup_persist: bool,
    // Immediate requested mute gates capture before the child acknowledges it.
    // Native callbacks and manual controls write it; `muted` above holds only
    // the acknowledged value used for status and persistence. Restart carries
    // current capture intent, including native changes still awaiting a reply.
    capture_muted: Arc<AtomicBool>,
    capture_mute_epoch: Arc<AtomicU64>,
    system_input_mute: Option<crate::system_input_mute::SystemInputMute>,
}

impl SessionActor {
    fn restore_input_mute(&mut self) -> Result<(), String> {
        // Restore current capture intent rather than stale acknowledged state.
        let (muted, mute_epoch) = crate::system_input_mute::mute_state_snapshot(
            &self.capture_muted,
            &self.capture_mute_epoch,
        );
        if muted {
            // Requests and captured PCM share one ordered pipe, so the replacement
            // session is muted before it can receive any microphone input.
            let id = self.next_id();
            send_request(
                &self.writer,
                &SessionRequest::SetInputMuted { id, active: true },
            )?;
        }
        if let Some(listener) = self.system_input_mute.as_mut() {
            listener.mark_forwarded(muted, mute_epoch);
        }
        Ok(())
    }

    /// Tells the session its status sounds, once a host has said whether the agent is working.
    fn send_status_sounds(&mut self, sounds: StatusSounds) -> Result<Option<u64>, String> {
        let Some(status) = sounds.status else {
            return Ok(None);
        };
        let id = self.next_id();
        send_request(
            &self.writer,
            &SessionRequest::SetConversationStatus {
                id,
                status,
                settings: berd_call::StatusSoundSettings {
                    mode: sounds.mode,
                    ..Default::default()
                },
            },
        )?;
        Ok(Some(id))
    }

    fn commit_status_sounds(
        &mut self,
        sounds: StatusSounds,
        mode: Option<berd_call::StatusSoundMode>,
    ) {
        if let Ok(mut committed) = self.status_sounds.lock() {
            *committed = sounds;
        }
        if let Some(mode) = mode {
            self.persist_settings(SavedPreference::StatusSounds(mode));
        }
    }

    fn new(
        writer: Arc<Mutex<ChildStdin>>,
        events: Receiver<SessionMessage>,
        commands: Receiver<ControlCommand>,
        audio_commands: SyncSender<AudioCommand>,
        session: Arc<Mutex<VoiceSessionSnapshot>>,
        transcript: Arc<Transcript>,
        expert_spokesperson: bool,
    ) -> Self {
        Self {
            saved: None,
            input_speaking: false,
            recognition_pending: false,
            interim_shown: false,
            pending_polls: Vec::new(),
            writer,
            events,
            commands,
            audio_commands,
            next_id: 2,
            pending_speak: None,
            pending_settings: std::collections::HashMap::new(),
            spokesperson_settings: HashSet::new(),
            waiting_speaks: VecDeque::new(),
            session,
            transcript,
            expert_spokesperson,
            transcribed: HashSet::new(),
            stopping: false,
            restart: None,
            restart_not_after: Instant::now(),
            audio_drain: None,
            muted: Arc::new(AtomicBool::new(false)),
            status_sounds: Arc::default(),
            pending_status_sounds: BTreeMap::new(),
            suppress_startup_persist: false,
            capture_muted: Arc::new(AtomicBool::new(false)),
            capture_mute_epoch: Arc::new(AtomicU64::new(0)),
            system_input_mute: None,
        }
    }

    fn restore_saved_tts(
        &mut self,
        settings: berd_call::TtsSettings,
        expected_revision: u64,
        timeout: Duration,
    ) -> Result<(), String> {
        let (response, result) = mpsc::sync_channel(1);
        self.handle_command(ControlCommand::TtsSettings {
            settings: settings.clone(),
            expected_revision,
            response,
        })?;
        let deadline = Instant::now() + timeout;
        let failure = loop {
            self.poll()?;
            match result.try_recv() {
                Ok(Ok(value)) if value["outcome"] == "applied" => return Ok(()),
                Ok(result) => break format!("saved TTS settings were rejected: {result:?}"),
                Err(mpsc::TryRecvError::Disconnected) => {
                    break "saved TTS settings restore disconnected".into()
                }
                Err(mpsc::TryRecvError::Empty) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(2))
                }
                Err(_) => break "timed out restoring saved TTS settings".into(),
            }
        };
        eprintln!("berd-call: {failure}; continuing with startup configuration");
        self.suppress_startup_persist = true;
        self.quarantine_saved_tts(&settings);
        Ok(())
    }

    fn quarantine_saved_tts(&mut self, rejected: &berd_call::TtsSettings) {
        let Some((path, _)) = &self.saved else {
            return;
        };
        let path = path.clone();
        let mut quarantined = false;
        let mut current = None;
        if let Err(error) = crate::saved_settings::update(&path, |latest| {
            if latest.tts.as_ref() == Some(rejected) {
                latest.tts = None;
                latest.arguments = crate::saved_settings::without_tts(&latest.arguments);
                quarantined = true;
            }
            current = Some(latest.clone());
        }) {
            eprintln!("berd-call: could not quarantine saved TTS settings: {error}");
            return;
        }
        if let Some(current) = current {
            self.saved = Some((path, current));
        }
        if !quarantined {
            eprintln!(
                "berd-call: saved TTS settings changed during restore; preserving the newer choice"
            );
        }
    }

    fn poll(&mut self) -> Result<(), String> {
        if !self.stopping {
            if let Some(muted) = self
                .system_input_mute
                .as_mut()
                .and_then(|listener| listener.take_change())
            {
                // Do not write the native intent back: another gesture may have
                // arrived after take_change. The ordered child acknowledgement
                // commits this request while the next poll handles the newer one.
                let id = self.next_id();
                send_request(
                    &self.writer,
                    &SessionRequest::SetInputMuted { id, active: muted },
                )?;
            }
        }
        loop {
            match self.commands.try_recv() {
                Ok(command) => self.handle_command(command)?,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.stopping = true;
                    break;
                }
            }
        }
        loop {
            match self.events.try_recv() {
                Ok(event) => self.handle_event(event)?,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    if !self.stopping {
                        return Err("voice session ended unexpectedly".into());
                    }
                    break;
                }
            }
        }
        self.poll_input_requests()?;
        if !self.stopping && self.pending_speak.is_none() {
            if let Some(command) = self.waiting_speaks.pop_front() {
                self.handle_command(command)?;
            }
        }
        self.start_restart_between_replies()
    }

    /// Shuts the session down for a requested restart once no speech is playing or queued, or the wait is up.
    fn start_restart_between_replies(&mut self) -> Result<(), String> {
        if self.stopping || self.restart.is_none() {
            return Ok(());
        }
        let expired = Instant::now() >= self.restart_not_after;
        let mut drained = false;
        if !expired && self.pending_speak.is_none() && self.waiting_speaks.is_empty() {
            if let Some(acknowledged) = &self.audio_drain {
                drained = match acknowledged.try_recv() {
                    Ok(()) => true,
                    Err(TryRecvError::Empty) => false,
                    Err(TryRecvError::Disconnected) => {
                        return Err("voice audio host stopped before restart drain".into())
                    }
                };
            } else {
                let (response, acknowledged) = mpsc::sync_channel(1);
                match self.audio_commands.try_send(AudioCommand::Drain(response)) {
                    Ok(()) => self.audio_drain = Some(acknowledged),
                    Err(mpsc::TrySendError::Full(_)) => {}
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        return Err("voice audio host stopped before restart drain".into());
                    }
                }
            }
        }
        if expired || drained {
            send_request(&self.writer, &SessionRequest::Shutdown)?;
            self.stopping = true;
        }
        Ok(())
    }

    fn handle_command(&mut self, command: ControlCommand) -> Result<(), String> {
        match command {
            ControlCommand::PollInput {
                since,
                wait,
                timeout_seconds,
                response,
            } => {
                if self.stopping || self.pending_polls.len() >= 32 {
                    let _ = response.send(Err(
                        "voice call is stopping or has too many input waiters".into(),
                    ));
                } else {
                    self.pending_polls.push(PendingInputPoll {
                        since,
                        wait,
                        response,
                        request_id: None,
                        deadline: Instant::now() + Duration::from_secs(timeout_seconds),
                        next_query: Instant::now(),
                    });
                }
            }
            ControlCommand::InputDuringTts {
                policy,
                expected_revision,
                response,
            } => {
                let id = self.next_id();
                send_request(
                    &self.writer,
                    &SessionRequest::SetInputDuringTts {
                        id,
                        expected_revision,
                        policy,
                    },
                )?;
                self.pending_settings.insert(id, response);
            }
            ControlCommand::Muted { muted, response } => {
                if let Some(listener) = self.system_input_mute.as_mut() {
                    if let Err(error) = listener.set_muted(muted) {
                        eprintln!("could not synchronize system input mute: {error}");
                    }
                } else {
                    crate::system_input_mute::update_mute_state(
                        &self.capture_muted,
                        &self.capture_mute_epoch,
                        muted,
                    );
                }
                let id = self.next_id();
                send_request(
                    &self.writer,
                    &SessionRequest::SetInputMuted { id, active: muted },
                )?;
                self.pending_settings.insert(id, response);
            }
            ControlCommand::StatusSounds {
                mode,
                status,
                response,
            } => {
                // Build on the newest request, since the session applies them in order.
                let latest = match self.pending_status_sounds.last_key_value() {
                    Some((_, (sounds, _))) if !self.stopping => *sounds,
                    _ => *self
                        .status_sounds
                        .lock()
                        .map_err(|_| "status sounds lock failed")?,
                };
                let sounds = StatusSounds {
                    mode: mode.unwrap_or(latest.mode),
                    status: status.or(latest.status),
                };
                // A stopping child may already have exited; a restarted session
                // is sent the committed status when it starts.
                let sent = if self.stopping {
                    None
                } else {
                    self.send_status_sounds(sounds)?
                };
                match sent {
                    Some(id) => {
                        self.pending_status_sounds.insert(id, (sounds, mode));
                        self.pending_settings.insert(id, response);
                    }
                    None => {
                        self.commit_status_sounds(sounds, mode);
                        let _ = response.send(Ok(json!({})));
                    }
                }
            }
            ControlCommand::TtsSettings {
                settings,
                expected_revision,
                response,
            } => {
                let id = self.next_id();
                send_request(
                    &self.writer,
                    &SessionRequest::SetTtsSettings {
                        id,
                        expected_revision,
                        settings,
                    },
                )?;
                self.pending_settings.insert(id, response);
            }
            ControlCommand::SpokespersonSettings {
                settings,
                expected_revision,
                response,
            } => {
                let id = self.next_id();
                send_request(
                    &self.writer,
                    &SessionRequest::SetSpokespersonSettings {
                        id,
                        expected_revision,
                        settings,
                    },
                )?;
                self.spokesperson_settings.insert(id);
                self.pending_settings.insert(id, response);
            }
            ControlCommand::Speak {
                text,
                acknowledgement,
                resolved_handoff_ids,
                voice,
                language,
                relay,
                non_blocking,
                response,
            } => {
                if self.stopping || self.audio_drain.is_some() {
                    let _ = response.send(Err("voice session is restarting or stopping".into()));
                    return Ok(());
                }
                if non_blocking && !self.transcript.delivers() {
                    let _ = response.send(Err(NON_BLOCKING_REQUIRES_DELIVERY.into()));
                    return Ok(());
                }
                if self.pending_speak.is_some() {
                    self.waiting_speaks.push_back(ControlCommand::Speak {
                        text,
                        acknowledgement,
                        resolved_handoff_ids,
                        voice,
                        language,
                        relay,
                        non_blocking,
                        response,
                    });
                    return Ok(());
                }
                let id = self.next_id();
                send_request(
                    &self.writer,
                    &SessionRequest::PrepareSpeak {
                        id,
                        acknowledgement,
                        text: text.clone(),
                        resolved_handoff_ids,
                        voice,
                        language,
                        relay,
                    },
                )?;
                self.pending_speak = Some(PendingSpeak {
                    prepare_id: id,
                    text,
                    non_blocking,
                    response: Some(response),
                });
            }
            ControlCommand::Restart {
                arguments,
                expert_spokesperson,
                tts,
                response,
            } => {
                if self.stopping || self.restart.is_some() {
                    let _ = response.send(Err(if self.stopping {
                        "voice call is stopping"
                    } else {
                        "voice session is already restarting"
                    }
                    .into()));
                    return Ok(());
                }
                self.restart = Some(PendingRestart {
                    arguments,
                    expert_spokesperson,
                    tts,
                    response,
                });
                // Ending the session ends its speech, so a restart waits for the reply being played.
                self.restart_not_after = Instant::now() + RESTART_SPEECH_WAIT;
                self.start_restart_between_replies()?;
            }
            ControlCommand::Stop { response } => {
                self.stop()?;
                let _ = response.send(Ok(json!({"stopping":true})));
            }
        }
        Ok(())
    }

    /// Ends the call, cancelling any restart it would otherwise hand off to.
    fn stop(&mut self) -> Result<(), String> {
        if let Some(restart) = self.restart.take() {
            let _ = restart.response.send(Err("voice call stopped".into()));
        }
        if !self.stopping {
            send_request(&self.writer, &SessionRequest::Shutdown)?;
            self.stopping = true;
        }
        Ok(())
    }

    fn handle_event(&mut self, event: SessionMessage) -> Result<(), String> {
        match event {
            SessionMessage::InputSpeaking { active } => {
                if self.input_speaking != active {
                    self.input_speaking = active;
                    self.stream_input_activity()?;
                }
            }
            SessionMessage::RecognitionPending { active } => {
                if self.recognition_pending != active {
                    self.recognition_pending = active;
                    self.stream_input_activity()?;
                }
            }
            SessionMessage::State {
                id,
                confirmed_token,
                utterances_after,
                unresolved_handoff_ids,
            } => {
                if let Some(index) = self
                    .pending_polls
                    .iter()
                    .position(|poll| poll.request_id == Some(id))
                {
                    let poll = &mut self.pending_polls[index];
                    let since = *poll.since.get_or_insert(confirmed_token);
                    let utterances: Vec<_> = utterances_after
                        .into_iter()
                        .filter(|item| item.token > since)
                        .collect();
                    let actionable = utterances
                        .iter()
                        .any(|item| item.origin != Some(UtteranceOrigin::Spokesperson));
                    if !self.input_speaking
                        && !self.recognition_pending
                        && (!poll.wait || actionable)
                    {
                        let cursor = utterances.last().map_or(since, |item| item.token);
                        let poll = self.pending_polls.remove(index);
                        let _ = poll.response.send(Ok(json!({
                            "utterances": utterances, "cursor": cursor,
                            "unresolvedHandoffIds": unresolved_handoff_ids, "timedOut": false,
                        })));
                    } else {
                        poll.request_id = None;
                        poll.next_query = Instant::now() + Duration::from_millis(50);
                    }
                }
            }
            SessionMessage::TtsSettingsResult {
                id,
                outcome,
                snapshot,
                message,
            } => {
                let spokesperson = self.spokesperson_settings.remove(&id);
                if let Ok(mut session) = self.session.lock() {
                    let voice = if spokesperson {
                        session.spokesperson.as_mut()
                    } else {
                        Some(&mut session.tts)
                    };
                    if let Some(voice) = voice.filter(|voice| snapshot.revision >= voice.revision) {
                        *voice = snapshot.clone();
                    }
                }
                if outcome == berd_call::protocol::TtsSettingsOutcome::Applied {
                    self.persist_settings(if spokesperson {
                        SavedPreference::Spokesperson
                    } else {
                        SavedPreference::Tts
                    });
                }
                if let Some(response) = self.pending_settings.remove(&id) {
                    let _ = response.send(Ok(
                        json!({"outcome":outcome,"snapshot":snapshot,"message":message}),
                    ));
                }
            }
            SessionMessage::InputDuringTtsResult {
                id,
                outcome,
                snapshot,
            } => {
                if let Ok(mut session) = self.session.lock() {
                    if snapshot.revision >= session.input_during_tts.revision {
                        session.input_during_tts = snapshot;
                    }
                }
                if outcome == berd_call::protocol::InputDuringTtsOutcome::Applied {
                    if let Some((_, saved)) = &mut self.saved {
                        saved.input_policy = Some(snapshot.policy);
                    }
                    self.persist_settings(SavedPreference::InputPolicy);
                }
                if let Some(response) = self.pending_settings.remove(&id) {
                    let _ = response.send(Ok(json!({"outcome":outcome,"snapshot":snapshot})));
                }
            }
            SessionMessage::ConversationStatusApplied { id, .. } => {
                if let Some((sounds, mode)) = self.pending_status_sounds.remove(&id) {
                    self.commit_status_sounds(sounds, mode);
                }
                if let Some(response) = self.pending_settings.remove(&id) {
                    let _ = response.send(Ok(json!({})));
                }
            }
            SessionMessage::InputMuteApplied { id, active } => {
                // Commit before acknowledging so a restart cannot read a stale value.
                self.muted.store(active, Ordering::SeqCst);
                if active {
                    self.stream_user_interim(0, "")?;
                }
                self.stream_input_activity()?;
                if let Some(response) = self.pending_settings.remove(&id) {
                    let _ = response.send(Ok(json!({"muted":active})));
                }
            }
            SessionMessage::UserInterim { token, text } if !self.expert_spokesperson => {
                self.stream_user_interim(token, &text)?
            }
            SessionMessage::LiveEvent {
                token,
                text,
                origin,
            } if !self.expert_spokesperson => self.stream_live_event(token, origin, &text)?,
            // Only a live stream shows the conversation as it happens.
            SessionMessage::UserTranscribed { token, text }
                if self.expert_spokesperson
                    && matches!(*self.transcript, Transcript::Stdout { live: true }) =>
            {
                self.transcript.record(Some(token), "user", None, &text)?;
                self.transcribed.insert(token);
            }
            SessionMessage::SpokespersonGenerated { text }
                if self.expert_spokesperson
                    && matches!(*self.transcript, Transcript::Stdout { live: true }) =>
            {
                self.transcript
                    .record(None, "spokesperson_generated", None, &text)?
            }
            SessionMessage::ExpertDelivery { events, .. } if self.expert_spokesperson => {
                self.stream_expert_delivery(&events)?
            }
            SessionMessage::Pending { id, utterances } if self.pending_prepare_id() == Some(id) => {
                self.respond_speak(Ok(json!({"spoke":false,"utterances":utterances})));
            }
            SessionMessage::NotAdmitted { id, reason } if self.pending_prepare_id() == Some(id) => {
                self.respond_speak(Err(format!(
                    "speech was not admitted: {}",
                    not_admitted_reason_name(reason)
                )));
            }
            SessionMessage::Admitted { id, speech_id, .. }
                if self.pending_prepare_id() == Some(id) =>
            {
                send_request(&self.writer, &SessionRequest::OutputReady { id, speech_id })?;
            }
            SessionMessage::OutputReadyResult { id, outcome, .. }
                if self.pending_prepare_id() == Some(id) =>
            {
                if outcome != OutputReadyOutcome::Accepted {
                    self.respond_speak(Err("speech output reservation became stale".into()));
                } else if let Some(pending) = self.pending_speak.as_mut() {
                    if pending.non_blocking {
                        if let Some(response) = pending.response.take() {
                            let _ = response.send(Ok(json!({"status":"accepted", "requestId":id})));
                        }
                    }
                }
            }
            SessionMessage::SpeechCompleted { id, .. } if self.pending_prepare_id() == Some(id) => {
                self.respond_speak(Ok(json!({"spoke":true,"status":"completed"})));
            }
            SessionMessage::SpeechInterrupted {
                id,
                spoken_through_utf8,
                ..
            } if self.pending_prepare_id() == Some(id) => {
                let spoken_text = estimated_spoken_text(
                    &self
                        .pending_speak
                        .as_ref()
                        .expect("matched pending speech")
                        .text,
                    spoken_through_utf8,
                );
                self.respond_speak(Ok(json!({
                    "spoke":true,
                    "status":"interrupted",
                    "spokenThroughUtf8":spoken_through_utf8,
                    "estimatedSpokenText":spoken_text,
                })));
            }
            SessionMessage::SpeechFailed { id, message, .. }
                if self.pending_prepare_id() == Some(id) =>
            {
                self.respond_speak(Err(message));
            }
            SessionMessage::AudioSuspend { speech_id } => self
                .audio_commands
                .send(AudioCommand::Suspend(speech_id))
                .map_err(|_| "audio host stopped".to_string())?,
            SessionMessage::AudioResume { speech_id } => self
                .audio_commands
                .send(AudioCommand::Resume(speech_id))
                .map_err(|_| "audio host stopped".to_string())?,
            SessionMessage::Fatal { message } => {
                self.finish_pending(&message);
                return Err(message);
            }
            SessionMessage::Ready { .. } => {
                return Err("voice session emitted ready more than once".into())
            }
            _ => {}
        }
        Ok(())
    }

    fn pending_prepare_id(&self) -> Option<u64> {
        self.pending_speak
            .as_ref()
            .map(|pending| pending.prepare_id)
    }

    fn respond_speak(&mut self, result: Result<Value, String>) {
        if let Some(pending) = self.pending_speak.take() {
            if let Some(response) = pending.response {
                let _ = response.send(result);
            } else {
                let result = match result {
                    Ok(value) => value,
                    Err(message) => json!({"status":"failed", "message":message}),
                };
                if should_notify_delivery(&result) {
                    let _ = self.transcript.record(
                        Some(pending.prepare_id),
                        "speech_result",
                        None,
                        &result.to_string(),
                    );
                }
            }
        }
    }

    /// Ephemeral UI state never enters the transcript or wakes a Codex task.
    fn stream_input_activity(&self) -> Result<(), String> {
        if matches!(&*self.transcript, Transcript::Stdout { .. }) {
            print_flushed(&input_activity_line(
                self.input_speaking && !self.muted.load(Ordering::SeqCst),
                self.recognition_pending && !self.muted.load(Ordering::SeqCst),
            ))?;
        }
        Ok(())
    }

    fn reset_input_activity(&mut self) -> Result<(), String> {
        self.input_speaking = false;
        self.recognition_pending = false;
        self.stream_user_interim(0, "")?;
        self.stream_input_activity()
    }

    /// Ephemeral like input activity. Muted words are never shown.
    fn stream_user_interim(&mut self, cursor: u64, text: &str) -> Result<(), String> {
        let text = if self.muted.load(Ordering::SeqCst) {
            ""
        } else {
            text
        };
        if matches!(&*self.transcript, Transcript::Stdout { .. })
            && (self.interim_shown || !text.is_empty())
        {
            self.interim_shown = !text.is_empty();
            print_flushed(&user_interim_line(cursor, text))?;
        }
        Ok(())
    }

    fn stream_live_event(
        &self,
        token: u64,
        origin: Option<UtteranceOrigin>,
        text: &str,
    ) -> Result<(), String> {
        let role = utterance_origin_name(origin.unwrap_or(UtteranceOrigin::User));
        self.transcript.record(Some(token), role, None, text)
    }

    fn stream_expert_delivery(
        &mut self,
        events: &[RealtimeExpertDeliveryEvent],
    ) -> Result<(), String> {
        for event in unstreamed(events, &mut self.transcribed) {
            self.transcript.record(
                Some(event.cursor),
                expert_delivery_role_name(event.role),
                event.handoff_id.as_deref(),
                &event.text,
            )?;
        }
        Ok(())
    }

    fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn finish_pending(&mut self, message: &str) {
        for poll in self.pending_polls.drain(..) {
            let _ = poll.response.send(Err(message.to_string()));
        }
        for (_, response) in self.pending_settings.drain() {
            let _ = response.send(Err(message.to_string()));
        }
        self.pending_status_sounds.clear();
        self.respond_speak(Err(message.to_string()));
        for command in self.waiting_speaks.drain(..) {
            if let ControlCommand::Speak { response, .. } = command {
                let _ = response.send(Err(message.to_string()));
            }
        }
    }

    fn persist_settings(&mut self, changed: SavedPreference) {
        if matches!(changed, SavedPreference::SessionStart) && self.suppress_startup_persist {
            self.suppress_startup_persist = false;
            return;
        }
        let Some((path, saved)) = &mut self.saved else {
            return;
        };
        let Ok(session) = self.session.lock() else {
            return;
        };
        if let SavedPreference::StatusSounds(mode) = changed {
            saved.status_sounds = Some(mode);
            if let Err(error) =
                crate::saved_settings::update(path, |latest| latest.status_sounds = Some(mode))
            {
                eprintln!("berd-call: status sounds applied but could not be saved: {error}");
            }
            return;
        }
        if let SavedPreference::Spokesperson = changed {
            let Some(spokesperson) = &session.spokesperson else {
                return;
            };
            let replacement = vec![
                "--spokesperson-voice".to_string(),
                spokesperson.settings.voice().to_string(),
                "--spokesperson-rate".to_string(),
                spokesperson.settings.rate().to_string(),
            ];
            saved.arguments =
                crate::saved_settings::merge_arguments(&saved.arguments, &replacement);
            if let Err(error) = crate::saved_settings::update(path, |latest| {
                latest.arguments =
                    crate::saved_settings::merge_arguments(&latest.arguments, &replacement)
            }) {
                eprintln!("berd-call: live settings applied but could not be saved: {error}");
            }
            return;
        }
        saved.tts = Some(session.tts.settings.clone());
        let replacement = tts_arguments(&session.tts.settings, &saved.arguments);
        saved.arguments = crate::saved_settings::merge_arguments(&saved.arguments, &replacement);
        if let Err(error) = crate::saved_settings::update(path, |latest| match changed {
            SavedPreference::SessionStart => {
                latest.arguments = saved.arguments.clone();
                latest.tts = saved.tts.clone();
            }
            SavedPreference::Tts => {
                latest.arguments =
                    crate::saved_settings::merge_arguments(&latest.arguments, &replacement);
                latest.tts = saved.tts.clone();
            }
            SavedPreference::InputPolicy => latest.input_policy = saved.input_policy,
            SavedPreference::Spokesperson | SavedPreference::StatusSounds(_) => {
                unreachable!("saved above")
            }
        }) {
            eprintln!("berd-call: live settings applied but could not be saved: {error}");
        }
    }

    fn poll_input_requests(&mut self) -> Result<(), String> {
        let now = Instant::now();
        let mut index = 0;
        while index < self.pending_polls.len() {
            if self.stopping {
                let poll = self.pending_polls.remove(index);
                let _ = poll
                    .response
                    .send(Err("voice session stopped or restarted".into()));
                continue;
            }
            if now >= self.pending_polls[index].deadline {
                let poll = self.pending_polls.remove(index);
                let result = poll
                    .since
                    .map(|cursor| {
                        json!({
                            "utterances": [], "cursor": cursor,
                            "unresolvedHandoffIds": [], "timedOut": true,
                        })
                    })
                    .ok_or_else(|| {
                        "timed out before the session reported its acknowledged cursor".to_string()
                    });
                let _ = poll.response.send(result);
                continue;
            }
            let poll = &self.pending_polls[index];
            if poll.request_id.is_none() && now >= poll.next_query {
                let after = poll.since.unwrap_or(0);
                let id = self.next_id();
                send_request(&self.writer, &SessionRequest::QueryState { id, after })?;
                self.pending_polls[index].request_id = Some(id);
            }
            index += 1;
        }
        Ok(())
    }
}

struct PendingInputPoll {
    // None means use the acknowledged cursor; the first correlated State reply
    // resolves it. Until then, a timeout is an error, not an invented cursor.
    since: Option<u64>,
    wait: bool,
    deadline: Instant,
    next_query: Instant,
    request_id: Option<u64>,
    response: SyncSender<Result<Value, String>>,
}

fn receive_ready(
    events: &Receiver<SessionMessage>,
    stopped: &AtomicBool,
) -> Result<ReadyState, String> {
    let event = crate::host_lifetime::receive_ready_event(events, stopped)?;
    match event {
        SessionMessage::Ready {
            id: 1,
            protocol: SESSION_PROTOCOL_VERSION,
            session,
        } => Ok(ReadyState {
            session: Arc::new(Mutex::new(session)),
        }),
        SessionMessage::Fatal { message } => Err(message),
        _ => Err("voice session returned an invalid ready handshake".into()),
    }
}

struct SessionProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<std::process::ChildStdout>,
    audio: Option<File>,
    reaped: bool,
}

impl SessionProcess {
    fn spawn(arguments: Vec<String>) -> Result<Self, String> {
        let mut fds: [RawFd; 2] = [-1, -1];
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(format!(
                "could not create voice audio pipe: {}",
                std::io::Error::last_os_error()
            ));
        }
        let read_fd = fds[0];
        let write_fd = fds[1];
        let executable = std::env::current_exe()
            .map_err(|error| format!("could not locate berd-call executable: {error}"))?;
        // Only the write end reaches the child; `pipe` leaves both inheritable.
        unsafe { libc::fcntl(read_fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        let mut command = Command::new(executable);
        // No pre_exec, so std uses posix_spawn: forking a process with AppKit's threads can abort the child.
        // The host owns Ctrl-C, so terminal signals stay out of the child's process group.
        let result = command
            .args(arguments)
            .arg("--pcm-output-fd")
            .arg(write_fd.to_string())
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn();
        unsafe { libc::close(write_fd) };
        let mut child = match result {
            Ok(child) => child,
            Err(error) => {
                unsafe { libc::close(read_fd) };
                return Err(format!("could not start voice session: {error}"));
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "voice session has no stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "voice session has no stdout".to_string())?;
        let audio = unsafe { File::from_raw_fd(read_fd) };
        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: Some(stdout),
            audio: Some(audio),
            reaped: false,
        })
    }

    fn take_stdin(&mut self) -> Result<ChildStdin, String> {
        self.stdin
            .take()
            .ok_or_else(|| "voice session stdin was already taken".into())
    }

    fn take_stdout(&mut self) -> Result<std::process::ChildStdout, String> {
        self.stdout
            .take()
            .ok_or_else(|| "voice session stdout was already taken".into())
    }

    fn take_audio(&mut self) -> Result<File, String> {
        self.audio
            .take()
            .ok_or_else(|| "voice session audio was already taken".into())
    }

    fn wait_for_exit(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self
                .child
                .try_wait()
                .map_err(|error| format!("could not inspect voice session: {error}"))?
            {
                self.reaped = true;
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("voice session exited with {status}"))
                };
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                let _ = self.child.wait();
                self.reaped = true;
                return Err("voice session did not stop within 5 seconds".into());
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for SessionProcess {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn spawn_stdout_reader(
    stdout: std::process::ChildStdout,
    events: SyncSender<SessionMessage>,
) -> Result<(), String> {
    thread::Builder::new()
        .name("berd-call-session-events".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let value = match serde_json::from_str::<SessionMessage>(&line) {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = events.send(SessionMessage::Fatal {
                            message: format!("could not decode voice session event: {error}"),
                        });
                        break;
                    }
                };
                if events.send(value).is_err() {
                    break;
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("could not start voice event reader: {error}"))
}

fn send_request(writer: &Arc<Mutex<ChildStdin>>, request: &SessionRequest) -> Result<(), String> {
    let payload = serde_json::to_vec(request)
        .map_err(|error| format!("could not encode voice session request: {error}"))?;
    write_frame(writer, JSON_FRAME_KIND, &payload)
}

fn send_captured_pcm(
    writer: &Arc<Mutex<ChildStdin>>,
    frame: &CapturedFrame,
    muted: &AtomicBool,
    mute_epoch: &AtomicU64,
) -> Result<(), String> {
    let mut payload = Vec::with_capacity(frame.samples.len() * 4);
    for sample in &frame.samples {
        payload.extend_from_slice(&sample.to_le_bytes());
    }
    let encoded = encode_frame(PCM_FRAME_KIND, &payload)?;
    let mut writer = writer
        .lock()
        .map_err(|_| "voice session input lock was poisoned")?;
    if !captured_frame_is_current(
        frame,
        muted.load(Ordering::SeqCst),
        mute_epoch.load(Ordering::SeqCst),
    ) {
        return Ok(());
    }
    write_cancellable_pcm(&mut *writer, &encoded, frame, muted, mute_epoch)
}

struct FileStatusFlagsGuard {
    fd: RawFd,
    flags: libc::c_int,
}

impl Drop for FileStatusFlagsGuard {
    fn drop(&mut self) {
        // SAFETY: `fd` stays open while this guard is held under the writer lock.
        let _ = unsafe { libc::fcntl(self.fd, libc::F_SETFL, self.flags) };
    }
}

fn write_cancellable_pcm(
    writer: &mut (impl Write + AsRawFd),
    encoded: &[u8],
    frame: &CapturedFrame,
    muted: &AtomicBool,
    mute_epoch: &AtomicU64,
) -> Result<(), String> {
    let fd = writer.as_raw_fd();
    // SAFETY: `fd` is owned by `writer` and protected by its mutex.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(format!(
            "could not configure cancellable voice input: {}",
            std::io::Error::last_os_error()
        ));
    }
    let _flags = FileStatusFlagsGuard { fd, flags };
    let mut offset = 0;
    loop {
        if !captured_frame_is_current(
            frame,
            muted.load(Ordering::SeqCst),
            mute_epoch.load(Ordering::SeqCst),
        ) {
            if offset == 0 {
                return Ok(());
            }
            return Err("input mute changed during a PCM frame".into());
        }
        match writer.write(&encoded[offset..]) {
            Ok(0) => return Err("voice session input closed during a PCM frame".into()),
            Ok(written) => {
                offset += written;
                if offset != encoded.len() {
                    continue;
                }
                return writer
                    .flush()
                    .map_err(|error| format!("could not write voice session input: {error}"));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => {
                return Err(format!("could not write voice session input: {error}"));
            }
        }
    }
}

fn write_frame(writer: &Arc<Mutex<ChildStdin>>, kind: u8, payload: &[u8]) -> Result<(), String> {
    let frame = encode_frame(kind, payload)?;
    let mut writer = writer
        .lock()
        .map_err(|_| "voice session input lock was poisoned")?;
    writer
        .write_all(&frame)
        .and_then(|()| writer.flush())
        .map_err(|error| format!("could not write voice session input: {error}"))
}

struct DefaultInputCapture {
    recovery: crate::microphone_recovery::MicrophoneRecovery<InputCapture>,
    writer: Arc<Mutex<ChildStdin>>,
    failures: SyncSender<String>,
    next_check: Instant,
    muted: Arc<AtomicBool>,
    mute_epoch: Arc<AtomicU64>,
}

fn default_input() -> Result<(String, cpal::Device), String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or_else(|| "no default microphone is available".to_string())?;
    let id = device
        .id()
        .map_err(|error| format!("could not identify microphone: {error}"))?;
    let config = device
        .default_input_config()
        .map_err(|error| format!("could not inspect microphone: {error}"))?;
    let key = format!(
        "{id:?}:{:?}:{}:{}",
        config.sample_format(),
        config.sample_rate(),
        config.channels()
    );
    Ok((key, device))
}

impl DefaultInputCapture {
    fn start(
        writer: Arc<Mutex<ChildStdin>>,
        failures: SyncSender<String>,
        muted: Arc<AtomicBool>,
        mute_epoch: Arc<AtomicU64>,
    ) -> Result<Self, String> {
        let (key, device) = default_input()?;
        let capture = InputCapture::start(
            device,
            writer.clone(),
            failures.clone(),
            muted.clone(),
            mute_epoch.clone(),
        )?;
        Ok(Self {
            recovery: crate::microphone_recovery::MicrophoneRecovery::new(key, capture),
            writer,
            failures,
            next_check: Instant::now() + Duration::from_millis(500),
            muted,
            mute_epoch,
        })
    }

    fn poll(&mut self, actor: &mut SessionActor) -> Result<(), String> {
        let now = Instant::now();
        if now < self.next_check {
            return Ok(());
        }
        self.next_check = now + Duration::from_millis(500);
        let failed = self
            .recovery
            .capture()
            .is_some_and(|capture| capture.failed(now));
        if !failed
            && self.recovery.capture().is_some_and(|capture| {
                capture.activity.last_callback_ms.load(Ordering::Relaxed) != 0
            })
            && self.recovery.confirm_activity()
        {
            actor.transcript.record(
                None,
                "lifecycle",
                None,
                "default microphone capture recovered",
            )?;
        }
        let desired = default_input();
        let key = desired
            .as_ref()
            .map(|(key, _)| key.clone())
            .map_err(Clone::clone);
        let writer = &self.writer;
        let failures = &self.failures;
        let change = self
            .recovery
            .reconcile(now, key, failed, InputCapture::stop, || {
                // The previous stream and its forwarder have stopped before this reset.
                // ResetInput preserves acknowledged mute and input policy settings.
                let id = actor.next_id();
                send_request(writer, &SessionRequest::ResetInput { id })?;
                InputCapture::start(
                    desired?.1,
                    writer.clone(),
                    failures.clone(),
                    self.muted.clone(),
                    self.mute_epoch.clone(),
                )
            })?;
        if change.invalidated || change.opened {
            actor.reset_input_activity()?;
        }
        Ok(())
    }
}

struct InputCapture {
    stream: Option<cpal::Stream>,
    forwarder: Option<thread::JoinHandle<()>>,
    errors: Receiver<String>,
    activity: Arc<CaptureActivity>,
}

struct CapturedFrame {
    samples: [f32; INPUT_FRAME_SAMPLES],
    mute_epoch: u64,
}

fn captured_frame_is_current(frame: &CapturedFrame, muted: bool, mute_epoch: u64) -> bool {
    !muted && frame.mute_epoch == mute_epoch
}

struct CaptureActivity {
    started: Instant,
    last_callback_ms: AtomicU64,
}

impl CaptureActivity {
    fn new(started: Instant) -> Self {
        Self {
            started,
            last_callback_ms: AtomicU64::new(0),
        }
    }

    fn record(&self, now: Instant) {
        self.last_callback_ms.store(
            // Zero means no callback yet, including during startup grace.
            now.saturating_duration_since(self.started).as_millis() as u64 + 1,
            Ordering::Relaxed,
        );
    }
}

impl Drop for InputCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

impl InputCapture {
    fn stop(&mut self) -> Result<(), String> {
        drop(self.stream.take());
        if let Some(forwarder) = self.forwarder.take() {
            let deadline = Instant::now() + Duration::from_millis(250);
            while !forwarder.is_finished() {
                if Instant::now() >= deadline {
                    // Fail the call before resetting or opening another capture.
                    // SessionProcess cleanup kills the child, releasing its pipe.
                    return Err("microphone forwarding did not stop within 250 milliseconds".into());
                }
                thread::sleep(Duration::from_millis(2));
            }
            forwarder
                .join()
                .map_err(|_| "microphone forwarding panicked".to_string())?;
        }
        Ok(())
    }
}

impl InputCapture {
    fn failed(&self, now: Instant) -> bool {
        // CoreAudio can stop callbacks without reporting an error or changing
        // device identity. Silent samples and muted capture still deliver callbacks.
        let elapsed_ms = now
            .saturating_duration_since(self.activity.started)
            .as_millis();
        let last_ms = u128::from(
            self.activity
                .last_callback_ms
                .load(Ordering::Relaxed)
                .saturating_sub(1),
        );
        self.errors.try_recv().is_ok() || elapsed_ms.saturating_sub(last_ms) >= 2_000
    }

    fn start(
        device: cpal::Device,
        writer: Arc<Mutex<ChildStdin>>,
        failures: SyncSender<String>,
        muted: Arc<AtomicBool>,
        mute_epoch: Arc<AtomicU64>,
    ) -> Result<Self, String> {
        let supported = device
            .default_input_config()
            .map_err(|error| format!("could not inspect the default microphone: {error}"))?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let channels = usize::from(config.channels);
        let sample_rate = config.sample_rate;
        let (frames_tx, frames_rx) = mpsc::sync_channel::<CapturedFrame>(32);
        let (capture_failure_tx, errors) = mpsc::sync_channel(1);
        let activity = Arc::new(CaptureActivity::new(Instant::now()));
        let writer_failures = failures.clone();
        let forwarding_muted = muted.clone();
        let forwarding_mute_epoch = mute_epoch.clone();
        let forwarder = thread::Builder::new()
            .name("berd-call-microphone-writer".into())
            .spawn(move || {
                while let Ok(frame) = frames_rx.recv() {
                    if let Err(message) = send_captured_pcm(
                        &writer,
                        &frame,
                        &forwarding_muted,
                        &forwarding_mute_epoch,
                    ) {
                        report_failure(&writer_failures, message);
                        break;
                    }
                }
            })
            .map_err(|error| format!("could not start microphone forwarding: {error}"))?;
        let stream = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                capture_callback(
                    activity.clone(),
                    sample_rate,
                    channels,
                    frames_tx.clone(),
                    failures.clone(),
                    muted.clone(),
                    mute_epoch.clone(),
                    |sample: f32| sample,
                ),
                capture_error(capture_failure_tx.clone()),
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config,
                capture_callback(
                    activity.clone(),
                    sample_rate,
                    channels,
                    frames_tx.clone(),
                    failures.clone(),
                    muted.clone(),
                    mute_epoch.clone(),
                    |sample: i16| f32::from(sample) / f32::from(i16::MAX),
                ),
                capture_error(capture_failure_tx.clone()),
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config,
                capture_callback(
                    activity.clone(),
                    sample_rate,
                    channels,
                    frames_tx,
                    failures.clone(),
                    muted,
                    mute_epoch,
                    |sample: u16| (f32::from(sample) / f32::from(u16::MAX)) * 2.0 - 1.0,
                ),
                capture_error(capture_failure_tx),
                None,
            ),
            _ => {
                return Err(format!(
                    "unsupported microphone sample format: {sample_format}"
                ))
            }
        }
        .map_err(|error| format!("could not open the default microphone: {error}"))?;
        stream
            .play()
            .map_err(|error| format!("could not start the default microphone: {error}"))?;
        Ok(Self {
            stream: Some(stream),
            forwarder: Some(forwarder),
            errors,
            activity,
        })
    }
}

fn capture_callback<T: Copy + Send + 'static>(
    activity: Arc<CaptureActivity>,
    sample_rate: u32,
    channels: usize,
    frames: SyncSender<CapturedFrame>,
    failures: SyncSender<String>,
    muted: Arc<AtomicBool>,
    mute_epoch: Arc<AtomicU64>,
    convert: impl Fn(T) -> f32 + Send + 'static,
) -> impl FnMut(&[T], &cpal::InputCallbackInfo) + Send + 'static {
    let mut normalizer = InputNormalizer::new(sample_rate, channels);
    let mut normalizer_epoch = crate::system_input_mute::mute_state_snapshot(&muted, &mute_epoch).1;
    move |data, _| {
        activity.record(Instant::now());
        let (callback_muted, callback_epoch) =
            crate::system_input_mute::mute_state_snapshot(&muted, &mute_epoch);
        if callback_epoch != normalizer_epoch {
            normalizer = InputNormalizer::new(sample_rate, channels);
            normalizer_epoch = callback_epoch;
        }
        if callback_muted {
            // Muted samples must never enter the queue or survive in a partial
            // normalized frame that could be forwarded after unmuting.
            normalizer = InputNormalizer::new(sample_rate, channels);
            return;
        }
        let normalized = normalizer.push(data.iter().copied().map(&convert));
        let (after_muted, after_epoch) =
            crate::system_input_mute::mute_state_snapshot(&muted, &mute_epoch);
        if after_muted || after_epoch != callback_epoch {
            normalizer = InputNormalizer::new(sample_rate, channels);
            normalizer_epoch = after_epoch;
            return;
        }
        for frame in normalized {
            let frame = CapturedFrame {
                samples: frame,
                mute_epoch: callback_epoch,
            };
            if frames.try_send(frame).is_err() {
                report_failure(&failures, "microphone input could not keep up".into());
                break;
            }
        }
    }
}

fn capture_error(failures: SyncSender<String>) -> impl FnMut(cpal::StreamError) + Send + 'static {
    move |error| {
        report_failure(&failures, format!("microphone capture failed: {error}"));
    }
}

fn report_failure(failures: &SyncSender<String>, message: String) {
    let _ = failures.try_send(message);
}

struct InputNormalizer {
    source_rate: f64,
    channels: usize,
    mono: Vec<f32>,
    position: f64,
    normalized: VecDeque<f32>,
}

impl InputNormalizer {
    fn new(source_rate: u32, channels: usize) -> Self {
        Self {
            source_rate: f64::from(source_rate),
            channels,
            mono: Vec::new(),
            position: 0.0,
            normalized: VecDeque::new(),
        }
    }

    fn push(&mut self, samples: impl Iterator<Item = f32>) -> Vec<[f32; INPUT_FRAME_SAMPLES]> {
        let interleaved = samples.collect::<Vec<_>>();
        for frame in interleaved.chunks_exact(self.channels) {
            self.mono
                .push(frame.iter().sum::<f32>() / self.channels as f32);
        }
        let step = self.source_rate / 48_000.0;
        while self.position + 1.0 < self.mono.len() as f64 {
            let left = self.position.floor() as usize;
            let fraction = (self.position - left as f64) as f32;
            let sample = self.mono[left] + (self.mono[left + 1] - self.mono[left]) * fraction;
            self.normalized.push_back(sample.clamp(-1.0, 1.0));
            self.position += step;
        }
        let consumed = self.position.floor() as usize;
        if consumed > 0 {
            self.mono.drain(..consumed.min(self.mono.len()));
            self.position -= consumed as f64;
        }
        let mut frames = Vec::new();
        while self.normalized.len() >= INPUT_FRAME_SAMPLES {
            let mut frame = [0.0; INPUT_FRAME_SAMPLES];
            for sample in &mut frame {
                *sample = self
                    .normalized
                    .pop_front()
                    .expect("checked normalized length");
            }
            frames.push(frame);
        }
        frames
    }
}

struct ActiveAudio {
    speech_id: u64,
    player: PocketAudioPlayer,
    last_played: u64,
    ended_sequence: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RetiredAudio {
    speech_id: u64,
    played_frames: u64,
}

enum AudioPlaybackState {
    Idle,
    Playing(ActiveAudio),
    Finished(RetiredAudio),
}

impl AudioPlaybackState {
    fn playing_mut(&mut self, speech_id: u64) -> Option<&mut ActiveAudio> {
        match self {
            Self::Playing(playback) if playback.speech_id == speech_id => Some(playback),
            _ => None,
        }
    }

    fn played_frames(&self, speech_id: u64) -> u64 {
        match self {
            Self::Playing(playback) if playback.speech_id == speech_id => {
                playback.player.played_frames()
            }
            Self::Finished(retired) if retired.speech_id == speech_id => retired.played_frames,
            _ => 0,
        }
    }

    /// What the host played of this speech, once it has ended it. The session may not have heard yet, so its records for it can still arrive.
    fn retired(&self, speech_id: u64) -> Option<u64> {
        match self {
            Self::Finished(retired) if retired.speech_id == speech_id => {
                Some(retired.played_frames)
            }
            _ => None,
        }
    }

    fn finish(&mut self, speech_id: u64, played_frames: u64) {
        *self = Self::Finished(RetiredAudio {
            speech_id,
            played_frames,
        });
    }
}

struct PendingSuspension {
    speech_id: u64,
    ready_at: Instant,
}

fn spawn_audio_host(
    mut audio: File,
    writer: Arc<Mutex<ChildStdin>>,
    commands: Receiver<AudioCommand>,
    failures: SyncSender<String>,
) -> Result<(), String> {
    let flags = unsafe { libc::fcntl(audio.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(audio.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(format!(
            "could not configure voice audio pipe: {}",
            std::io::Error::last_os_error()
        ));
    }
    thread::Builder::new()
        .name("berd-call-audio-host".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let mut playback = AudioPlaybackState::Idle;
            let mut drain: Option<SyncSender<()>> = None;
            let mut pending_suspension: Option<PendingSuspension> = None;
            let suspension_latency = suspension_settle_time(
                berd_call::macos_audio_route::playback_latency_safety_duration(None),
            );
            loop {
                // A newly requested drain is checked after the next pipe read,
                // so records already entering the host cannot be missed.
                let drain_requested = drain.is_some();
                let ingress_open = match read_available_audio(&mut audio, &mut bytes) {
                    Ok(open) => open,
                    Err(error) => {
                        report_failure(&failures, error);
                        return;
                    }
                };
                loop {
                    match take_audio_record(&mut bytes) {
                        Ok(Some((kind, payload))) => {
                            if let Err(error) =
                                handle_audio_record(kind, &payload, &writer, &mut playback)
                            {
                                report_failure(&failures, error);
                                return;
                            }
                        }
                        Ok(None) => break,
                        Err(error) => {
                            report_failure(&failures, error);
                            return;
                        }
                    }
                }
                if !ingress_open {
                    break;
                }
                while let Ok(command) = commands.try_recv() {
                    if let AudioCommand::Drain(response) = command {
                        drain = Some(response);
                        continue;
                    }
                    if let Err(error) = handle_audio_command(
                        command,
                        &writer,
                        &mut playback,
                        &mut pending_suspension,
                        suspension_latency,
                    ) {
                        report_failure(&failures, error);
                        return;
                    }
                }
                let mut finished = None;
                if let AudioPlaybackState::Playing(active) = &mut playback {
                    if let Err(error) = active.player.check_health() {
                        let speech_id = active.speech_id;
                        let played_frames = active.player.played_frames();
                        let _ = send_request(
                            &writer,
                            &SessionRequest::AudioFailed {
                                speech_id,
                                played_frames,
                                message: error,
                            },
                        );
                        finished = Some((speech_id, played_frames));
                    } else {
                        let played = active.player.played_frames();
                        if played > active.last_played {
                            active.last_played = played;
                            let _ = send_request(
                                &writer,
                                &SessionRequest::AudioPlayed {
                                    speech_id: active.speech_id,
                                    played_frames: played,
                                },
                            );
                        }
                        if let Some(sequence) = active.ended_sequence {
                            if active.player.is_empty() {
                                let speech_id = active.speech_id;
                                let played_frames = active.player.completed_source_frames();
                                let _ = send_request(
                                    &writer,
                                    &SessionRequest::AudioDrained {
                                        speech_id,
                                        sequence,
                                        played_frames,
                                    },
                                );
                                finished = Some((speech_id, played_frames));
                            }
                        }
                    }
                }
                if let Some((speech_id, played_frames)) = finished {
                    playback.finish(speech_id, played_frames);
                }
                if drain_requested
                    && bytes.is_empty()
                    && !matches!(playback, AudioPlaybackState::Playing(_))
                {
                    if let Some(response) = drain.take() {
                        let _ = response.send(());
                        // Park admission until the actor drops its sender. Keep the
                        // pipe open while the actor shuts down the child, so no new
                        // playback or premature audio EOF can race the acknowledgement.
                        while commands.recv().is_ok() {}
                        return;
                    }
                }
                if pending_suspension
                    .as_ref()
                    .is_some_and(|pending| Instant::now() >= pending.ready_at)
                {
                    let pending = pending_suspension
                        .take()
                        .expect("checked pending suspension");
                    if let Err(error) = send_request(
                        &writer,
                        &SessionRequest::AudioSuspended {
                            speech_id: pending.speech_id,
                            played_frames: playback.played_frames(pending.speech_id),
                        },
                    ) {
                        report_failure(&failures, error);
                        return;
                    }
                }
                thread::sleep(Duration::from_millis(2));
            }
        })
        .map(|_| ())
        .map_err(|error| format!("could not start voice audio host: {error}"))
}

/// Read through WouldBlock before deciding whether the audio ingress is empty.
fn read_available_audio(audio: &mut impl Read, bytes: &mut Vec<u8>) -> Result<bool, String> {
    let mut chunk = [0_u8; 8192];
    loop {
        match audio.read(&mut chunk) {
            Ok(0) => return Ok(false),
            Ok(count) => bytes.extend_from_slice(&chunk[..count]),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(format!("berd-call audio pipe failed: {error}")),
        }
    }
}

use std::os::fd::AsRawFd;

fn take_audio_record(bytes: &mut Vec<u8>) -> Result<Option<(u8, Vec<u8>)>, String> {
    if bytes.len() < AUDIO_FRAME_HEADER_BYTES {
        return Ok(None);
    }
    if bytes[..2] != AUDIO_FRAME_MAGIC || bytes[2] != AUDIO_FRAME_MARKER {
        return Err("voice session emitted an invalid audio frame header".into());
    }
    let kind = bytes[3];
    let length =
        u32::from_le_bytes(bytes[4..8].try_into().expect("complete audio header")) as usize;
    if length > MAX_AUDIO_RECORD_BYTES {
        return Err("voice session emitted an oversized audio record".into());
    }
    if bytes.len() < AUDIO_FRAME_HEADER_BYTES + length {
        return Ok(None);
    }
    let payload = bytes[AUDIO_FRAME_HEADER_BYTES..AUDIO_FRAME_HEADER_BYTES + length].to_vec();
    bytes.drain(..AUDIO_FRAME_HEADER_BYTES + length);
    Ok(Some((kind, payload)))
}

fn handle_audio_record(
    kind: u8,
    payload: &[u8],
    writer: &Arc<Mutex<ChildStdin>>,
    playback: &mut AudioPlaybackState,
) -> Result<(), String> {
    match kind {
        AUDIO_BEGIN_KIND if payload.len() == 16 => {
            if matches!(playback, AudioPlaybackState::Playing(_)) {
                return Err("voice session began overlapping audio".into());
            }
            let speech_id = le_u64(&payload[0..8])?;
            let sample_rate = le_u32(&payload[8..12])?;
            let rate = f32::from_le_bytes(
                payload[12..16]
                    .try_into()
                    .map_err(|_| "invalid audio rate")?,
            );
            let player = match PocketAudioPlayer::new(sample_rate, rate, None) {
                Ok(player) => player,
                Err(message) => {
                    return send_request(
                        writer,
                        &SessionRequest::AudioBeginFailed {
                            speech_id,
                            played_frames: 0,
                            message,
                        },
                    );
                }
            };
            *playback = AudioPlaybackState::Playing(ActiveAudio {
                speech_id,
                player,
                last_played: 0,
                ended_sequence: None,
            });
            send_request(writer, &SessionRequest::AudioBeginAccepted { speech_id })
        }
        AUDIO_CHUNK_KIND if payload.len() >= 16 && (payload.len() - 16).is_multiple_of(4) => {
            let speech_id = le_u64(&payload[0..8])?;
            let sequence = le_u64(&payload[8..16])?;
            if playback.retired(speech_id).is_some() {
                return Ok(());
            }
            let active = playback
                .playing_mut(speech_id)
                .ok_or_else(|| "voice session sent audio for an inactive speech".to_string())?;
            let mut samples = Vec::with_capacity((payload.len() - 16) / 4);
            for sample in payload[16..].chunks_exact(4) {
                samples.push(f32::from_le_bytes(
                    sample.try_into().expect("four-byte chunk"),
                ));
            }
            if let Err(message) = active.player.enqueue(&samples) {
                let played_frames = active.player.played_frames();
                playback.finish(speech_id, played_frames);
                return send_request(
                    writer,
                    &SessionRequest::AudioFailed {
                        speech_id,
                        played_frames,
                        message,
                    },
                );
            }
            send_request(
                writer,
                &SessionRequest::AudioChunkAccepted {
                    speech_id,
                    sequence,
                },
            )
        }
        AUDIO_END_KIND if payload.len() == 24 => {
            let speech_id = le_u64(&payload[0..8])?;
            let sequence = le_u64(&payload[8..16])?;
            if playback.retired(speech_id).is_some() {
                return Ok(());
            }
            let active = playback
                .playing_mut(speech_id)
                .ok_or_else(|| "voice session ended inactive audio".to_string())?;
            active.ended_sequence = Some(sequence);
            Ok(())
        }
        AUDIO_CANCEL_KIND if payload.len() == 8 => {
            let speech_id = le_u64(payload)?;
            if let Some(played_frames) = playback.retired(speech_id) {
                return send_request(
                    writer,
                    &SessionRequest::AudioCancelled {
                        speech_id,
                        played_frames,
                    },
                );
            }
            let active = playback
                .playing_mut(speech_id)
                .ok_or_else(|| "voice session cancelled inactive audio".to_string())?;
            let played_frames = active.player.played_frames();
            active.player.stop();
            playback.finish(speech_id, played_frames);
            send_request(
                writer,
                &SessionRequest::AudioCancelled {
                    speech_id,
                    played_frames,
                },
            )
        }
        _ => Err("voice session emitted an invalid audio record".into()),
    }
}

fn handle_audio_command(
    command: AudioCommand,
    writer: &Arc<Mutex<ChildStdin>>,
    playback: &mut AudioPlaybackState,
    pending_suspension: &mut Option<PendingSuspension>,
    suspension_latency: Duration,
) -> Result<(), String> {
    match command {
        AudioCommand::Drain(_) => unreachable!("the audio loop owns drain acknowledgements"),
        AudioCommand::Suspend(speech_id) => {
            if let Some(active) = playback.playing_mut(speech_id) {
                active.player.pause();
                *pending_suspension = Some(PendingSuspension {
                    speech_id,
                    ready_at: Instant::now() + suspension_latency,
                });
                Ok(())
            } else {
                send_request(
                    writer,
                    &SessionRequest::AudioSuspended {
                        speech_id,
                        played_frames: playback.played_frames(speech_id),
                    },
                )
            }
        }
        AudioCommand::Resume(speech_id) => {
            let played_frames = if let Some(active) = playback.playing_mut(speech_id) {
                active.player.resume();
                active.player.played_frames()
            } else {
                playback.played_frames(speech_id)
            };
            send_request(
                writer,
                &SessionRequest::AudioResumed {
                    speech_id,
                    played_frames,
                },
            )
        }
    }
}

fn le_u64(bytes: &[u8]) -> Result<u64, String> {
    Ok(u64::from_le_bytes(
        bytes.try_into().map_err(|_| "invalid u64 audio field")?,
    ))
}

fn le_u32(bytes: &[u8]) -> Result<u32, String> {
    Ok(u32::from_le_bytes(
        bytes.try_into().map_err(|_| "invalid u32 audio field")?,
    ))
}

fn stream_text(text: &str) -> String {
    text.replace(['\r', '\n', '\t'], " ")
}

fn estimated_spoken_text(text: &str, through_utf8: u64) -> &str {
    let mut end = usize::try_from(through_utf8)
        .unwrap_or(usize::MAX)
        .min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn should_notify_delivery(result: &Value) -> bool {
    result.get("status").and_then(Value::as_str) != Some("completed")
}

fn suspension_settle_time(route_latency: Duration) -> Duration {
    route_latency
}

fn utterance_origin_name(origin: UtteranceOrigin) -> &'static str {
    match origin {
        UtteranceOrigin::User => "user",
        UtteranceOrigin::Spokesperson => "spokesperson",
        UtteranceOrigin::Handoff => "handoff",
    }
}

fn not_admitted_reason_name(reason: NotAdmittedReason) -> &'static str {
    match reason {
        NotAdmittedReason::Paused => "paused",
        NotAdmittedReason::InProgress => "in_progress",
        NotAdmittedReason::Cancelled => "cancelled",
        NotAdmittedReason::EmptyText => "empty_text",
        NotAdmittedReason::InvalidHandoff => "invalid_handoff",
        NotAdmittedReason::InvalidVoice => "invalid_voice",
    }
}

/// The batch's events not already streamed as they happened.
fn unstreamed<'a>(
    events: &'a [RealtimeExpertDeliveryEvent],
    transcribed: &'a mut HashSet<u64>,
) -> impl Iterator<Item = &'a RealtimeExpertDeliveryEvent> {
    events.iter().filter(move |event| {
        !(event.role == RealtimeExpertDeliveryRole::User && transcribed.remove(&event.cursor))
    })
}

fn expert_delivery_role_name(role: RealtimeExpertDeliveryRole) -> &'static str {
    match role {
        RealtimeExpertDeliveryRole::User => "user",
        RealtimeExpertDeliveryRole::Spokesperson => "spokesperson",
        RealtimeExpertDeliveryRole::SpokespersonInterrupted => "spokesperson_interrupted",
        RealtimeExpertDeliveryRole::Handoff => "handoff",
        RealtimeExpertDeliveryRole::Lifecycle => "lifecycle",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expert_batches_leave_out_user_rows_already_streamed() {
        let event = |cursor, role| RealtimeExpertDeliveryEvent {
            cursor,
            role,
            text: format!("event {cursor}"),
            handoff_id: None,
        };
        let events = [
            event(1, RealtimeExpertDeliveryRole::User),
            event(2, RealtimeExpertDeliveryRole::User),
            event(3, RealtimeExpertDeliveryRole::Spokesperson),
        ];
        let mut transcribed = HashSet::from([1, 3]);
        let cursors: Vec<_> = unstreamed(&events, &mut transcribed)
            .map(|event| event.cursor)
            .collect();
        assert_eq!(cursors, [2, 3]);
        assert_eq!(transcribed, HashSet::from([3]));
    }

    #[test]
    fn microphone_teardown_reports_a_blocked_forwarder() {
        let (_release, blocked) = mpsc::sync_channel::<()>(1);
        let (started_tx, started) = mpsc::sync_channel(1);
        let forwarder = thread::spawn(move || {
            started_tx.send(()).unwrap();
            // Bounded test fixture: the production writer can block indefinitely.
            let _ = blocked.recv_timeout(Duration::from_secs(2));
        });
        started.recv().unwrap();
        let (_errors_tx, errors) = mpsc::sync_channel(1);
        let mut capture = InputCapture {
            stream: None,
            forwarder: Some(forwarder),
            errors,
            activity: Arc::new(CaptureActivity::new(Instant::now())),
        };
        let started = Instant::now();
        let result = capture.stop();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(
            result.is_err(),
            "blocked forwarding must abort recovery, not hang or reopen"
        );
    }

    #[test]
    fn silent_pcm_callback_keeps_capture_activity_alive() {
        let activity = Arc::new(CaptureActivity::new(
            Instant::now() - Duration::from_secs(3),
        ));
        let (frames, _queued) = mpsc::sync_channel(32);
        let (failures, errors) = mpsc::sync_channel(1);
        let capture = InputCapture {
            stream: None,
            forwarder: None,
            errors,
            activity: activity.clone(),
        };
        assert!(capture.failed(Instant::now()));
        let mut callback = capture_callback(
            activity,
            48_000,
            1,
            frames,
            failures,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicU64::new(0)),
            |x: f32| x,
        );
        let instant = cpal::StreamInstant::new(0, 0);
        let info = cpal::InputCallbackInfo::new(cpal::InputStreamTimestamp {
            callback: instant,
            capture: instant,
        });
        callback(&[0.0; INPUT_FRAME_SAMPLES], &info);
        assert!(!capture.failed(Instant::now()));
    }

    #[test]
    fn stalled_microphone_reopens_even_when_device_and_error_channel_are_unchanged() {
        let now = Instant::now();
        let (_errors_tx, errors) = mpsc::sync_channel(1);
        let activity = Arc::new(CaptureActivity::new(now));
        let capture = InputCapture {
            stream: None,
            forwarder: None,
            errors,
            activity: activity.clone(),
        };
        let mut recovery =
            crate::microphone_recovery::MicrophoneRecovery::new("same-device".into(), capture);
        assert!(!recovery
            .capture()
            .unwrap()
            .failed(now + Duration::from_secs(1)));
        // Silent PCM callbacks still count as live capture; signal RMS is irrelevant.
        activity.record(now + Duration::from_secs(1));
        assert!(!recovery
            .capture()
            .unwrap()
            .failed(now + Duration::from_secs(2)));
        let failed = recovery
            .capture()
            .unwrap()
            .failed(now + Duration::from_secs(4));
        let mut reopened = false;
        recovery
            .reconcile(
                now + Duration::from_secs(4),
                Ok("same-device".into()),
                failed,
                InputCapture::stop,
                || {
                    reopened = true;
                    Err("simulated reconnect still unavailable".into())
                },
            )
            .unwrap();
        assert!(
            reopened,
            "a silent callback stall must reopen the unchanged device"
        );
    }

    #[test]
    fn gesture_after_restart_preparation_reaches_replacement() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        let native_intent = actor.capture_muted.clone();
        let (response, _reply) = mpsc::sync_channel(1);
        let start = actor.restart_start(
            PendingRestart {
                arguments: vec!["session".into()],
                expert_spokesperson: false,
                tts: None,
                response,
            },
            InputDuringTtsPolicy::AllowBargeIn,
        );
        // Native mute changes during handoff must remain visible to the replacement session.
        native_intent.store(true, Ordering::SeqCst);
        drop(actor);
        assert!(child.wait().unwrap().success());
        assert!(
            start.muted.load(Ordering::SeqCst),
            "restart discarded a later native mute gesture"
        );
    }

    #[test]
    fn restart_keeps_endpoint_overrides_out_of_saved_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        actor.saved = Some((
            path.clone(),
            crate::saved_settings::SavedSettings::default(),
        ));
        let arguments = [
            "session",
            "--mode",
            "chained",
            "--realtime-url",
            "ws://127.0.0.1:18870/realtime",
            "--stt-backend",
            "openai",
            "--stt-url",
            "ws://127.0.0.1:18870/stt",
            "--tts-backend",
            "openai",
            "--tts-url",
            "http://127.0.0.1:18870/tts",
        ]
        .map(str::to_string)
        .to_vec();
        let (response, _reply) = mpsc::sync_channel(1);
        let start = actor.restart_start(
            PendingRestart {
                arguments: arguments.clone(),
                expert_spokesperson: false,
                tts: None,
                response,
            },
            InputDuringTtsPolicy::AllowBargeIn,
        );
        assert_eq!(start.arguments, arguments);
        let (_, saved) = start.saved.unwrap();
        crate::saved_settings::save(&path, &saved).unwrap();
        assert_eq!(
            crate::saved_settings::load(&path).unwrap().arguments,
            [
                "--mode",
                "chained",
                "--stt-backend",
                "openai",
                "--tts-backend",
                "openai",
            ]
            .map(str::to_string)
        );
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn restart_keeps_the_saved_spokesperson_voice_for_later() {
        let restart = |arguments: &[&str]| {
            let mut child = Command::new("/bin/cat")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap();
            let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
            let (_events_tx, events) = mpsc::sync_channel(1);
            let (_commands_tx, commands) = mpsc::sync_channel(1);
            let (audio, _audio_rx) = mpsc::sync_channel(1);
            let mut actor = test_actor(writer, events, commands, audio);
            actor.saved = Some((
                "settings.json".into(),
                crate::saved_settings::SavedSettings {
                    arguments: [
                        "--spokesperson-voice",
                        "cedar",
                        "--spokesperson-rate",
                        "1.1",
                    ]
                    .map(str::to_string)
                    .to_vec(),
                    ..Default::default()
                },
            ));
            let (response, _reply) = mpsc::sync_channel(1);
            let start = actor.restart_start(
                PendingRestart {
                    arguments: arguments
                        .iter()
                        .map(|argument| argument.to_string())
                        .collect(),
                    expert_spokesperson: false,
                    tts: None,
                    response,
                },
                InputDuringTtsPolicy::AllowBargeIn,
            );
            drop(actor);
            assert!(child.wait().unwrap().success());
            (start.arguments, start.saved.unwrap().1.arguments)
        };
        let strings =
            |arguments: &[&str]| arguments.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        // A mode that can't take them leaves them saved only.
        let (arguments, saved) = restart(&["session", "--mode", "conventional"]);
        assert_eq!(arguments, strings(&["session", "--mode", "conventional"]));
        assert_eq!(
            saved,
            strings(&[
                "--spokesperson-voice",
                "cedar",
                "--spokesperson-rate",
                "1.1",
                "--mode",
                "conventional",
            ])
        );
        // One that can starts with the saved voice, not the default.
        let (arguments, saved) = restart(&[
            "session",
            "--mode",
            "expert-spokesperson",
            crate::DIRECT_AGENT_SPEECH,
        ]);
        assert_eq!(
            arguments,
            strings(&[
                "session",
                "--spokesperson-voice",
                "cedar",
                "--mode",
                "expert-spokesperson",
                crate::DIRECT_AGENT_SPEECH,
            ])
        );
        assert_eq!(
            saved[..4],
            strings(&[
                "--spokesperson-voice",
                "cedar",
                "--spokesperson-rate",
                "1.1"
            ])[..]
        );
        // Explicit flags win.
        let (arguments, saved) = restart(&[
            "session",
            "--spokesperson-voice",
            "marin",
            "--mode",
            "expert-spokesperson",
            crate::DIRECT_AGENT_SPEECH,
        ]);
        assert_eq!(
            arguments[1..3],
            strings(&["--spokesperson-voice", "marin"])[..]
        );
        assert_eq!(
            arguments
                .iter()
                .filter(|a| *a == "--spokesperson-voice")
                .count(),
            1
        );
        assert_eq!(saved[..2], strings(&["--spokesperson-rate", "1.1"])[..]);
        assert!(saved.ends_with(&strings(&[
            "--spokesperson-voice",
            "marin",
            "--mode",
            "expert-spokesperson"
        ])));
    }

    #[test]
    fn status_sounds_wait_for_a_reported_status_and_save_their_mode() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        actor.saved = Some((path.clone(), Default::default()));
        let mut set = |mode, status| {
            let (response, result) = mpsc::sync_channel(1);
            actor
                .handle_command(ControlCommand::StatusSounds {
                    mode,
                    status,
                    response,
                })
                .unwrap();
            result
        };

        // With no status reported yet, nothing is sent to the session.
        set(Some(berd_call::StatusSoundMode::WorkingAndWaiting), None)
            .try_recv()
            .unwrap()
            .unwrap();
        let reply = set(None, Some(berd_call::ConversationStatus::Working));
        assert!(reply.try_recv().is_err());
        let id = *actor.pending_settings.keys().next().unwrap();
        actor
            .handle_event(SessionMessage::ConversationStatusApplied {
                id,
                status: berd_call::ConversationStatus::Working,
                settings: berd_call::StatusSoundSettings {
                    mode: berd_call::StatusSoundMode::WorkingAndWaiting,
                    ..Default::default()
                },
            })
            .unwrap();
        reply.try_recv().unwrap().unwrap();
        assert_eq!(
            crate::saved_settings::load(&path).unwrap().status_sounds,
            Some(berd_call::StatusSoundMode::WorkingAndWaiting)
        );
        // A session started later, as after a restart, is sent the reported status.
        let sounds = *actor.status_sounds.lock().unwrap();
        assert!(actor.send_status_sounds(sounds).unwrap().is_some());
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn status_sounds_commit_only_when_the_session_applies_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        actor.saved = Some((path.clone(), Default::default()));
        *actor.status_sounds.lock().unwrap() = StatusSounds {
            mode: berd_call::StatusSoundMode::Working,
            status: Some(berd_call::ConversationStatus::Working),
        };
        fn set(
            actor: &mut SessionActor,
            mode: berd_call::StatusSoundMode,
        ) -> Receiver<Result<Value, String>> {
            let (response, result) = mpsc::sync_channel(1);
            actor
                .handle_command(ControlCommand::StatusSounds {
                    mode: Some(mode),
                    status: None,
                    response,
                })
                .unwrap();
            result
        }
        let committed = |actor: &SessionActor| actor.status_sounds.lock().unwrap().mode;

        // A session that stops before applying the change leaves it uncommitted.
        let failed = set(&mut actor, berd_call::StatusSoundMode::Off);
        assert!(failed.try_recv().is_err());
        actor.finish_pending("voice call stopped");
        assert!(failed.try_recv().unwrap().is_err());
        assert_eq!(committed(&actor), berd_call::StatusSoundMode::Working);
        assert_eq!(
            crate::saved_settings::load(&path).unwrap().status_sounds,
            None
        );

        // A later request that the session applies commits and saves its mode.
        let applied = set(&mut actor, berd_call::StatusSoundMode::WorkingAndWaiting);
        assert_eq!(committed(&actor), berd_call::StatusSoundMode::Working);
        let id = *actor.pending_settings.keys().next().unwrap();
        actor
            .handle_event(SessionMessage::ConversationStatusApplied {
                id,
                status: berd_call::ConversationStatus::Working,
                settings: berd_call::StatusSoundSettings {
                    mode: berd_call::StatusSoundMode::WorkingAndWaiting,
                    ..Default::default()
                },
            })
            .unwrap();
        applied.try_recv().unwrap().unwrap();
        assert_eq!(
            committed(&actor),
            berd_call::StatusSoundMode::WorkingAndWaiting
        );
        assert_eq!(
            crate::saved_settings::load(&path).unwrap().status_sounds,
            Some(berd_call::StatusSoundMode::WorkingAndWaiting)
        );
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn status_sounds_reported_while_stopping_wait_for_the_next_session() {
        let mut child = Command::new("/usr/bin/true")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        assert!(child.wait().unwrap().success());
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        actor.stopping = true;
        let (response, reply) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::StatusSounds {
                mode: None,
                status: Some(berd_call::ConversationStatus::Waiting),
                response,
            })
            .unwrap();
        reply.try_recv().unwrap().unwrap();
        assert_eq!(
            actor.status_sounds.lock().unwrap().status,
            Some(berd_call::ConversationStatus::Waiting)
        );
    }

    #[test]
    fn restart_preserves_native_intent_before_child_acknowledgement() {
        for requested in [true, false] {
            let mut child = Command::new("/bin/cat")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap();
            let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
            let (_events_tx, events) = mpsc::sync_channel(1);
            let (_commands_tx, commands) = mpsc::sync_channel(1);
            let (audio, _audio_rx) = mpsc::sync_channel(1);
            let mut actor = test_actor(writer, events, commands, audio);
            actor.muted.store(!requested, Ordering::SeqCst);
            // A native callback updates the capture gate before its child reply.
            actor.capture_muted.store(requested, Ordering::SeqCst);
            let (response, _reply) = mpsc::sync_channel(1);
            actor
                .handle_command(ControlCommand::Restart {
                    arguments: vec!["session".into()],
                    expert_spokesperson: false,
                    tts: None,
                    response,
                })
                .unwrap();
            let restart = actor.restart.take().unwrap();
            let start = actor.restart_start(restart, InputDuringTtsPolicy::AllowBargeIn);
            drop(actor);
            assert!(child.wait().unwrap().success());
            assert_eq!(start.muted.load(Ordering::SeqCst), requested);
        }
    }

    #[test]
    fn startup_preserves_unmute_intent_before_child_acknowledgement() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        actor.muted.store(true, Ordering::SeqCst);
        actor.capture_muted.store(false, Ordering::SeqCst);
        // Startup must preserve current capture intent rather than the
        // acknowledged mute state.
        let id = actor.next_id();
        let request = SessionRequest::SetInputMuted { id, active: false };
        send_request(&actor.writer, &request).unwrap();
        actor.restore_input_mute().unwrap();
        drop(actor);
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            output.stdout,
            encode_frame(JSON_FRAME_KIND, &serde_json::to_vec(&request).unwrap()).unwrap()
        );
    }

    #[test]
    fn muted_capture_never_queues_audio_for_later_unmute() {
        let (frames, queued) = mpsc::sync_channel(32);
        let (failures, _errors) = mpsc::sync_channel(1);
        let muted = Arc::new(AtomicBool::new(true));
        let mute_epoch = Arc::new(AtomicU64::new(0));
        let activity = Arc::new(CaptureActivity::new(
            Instant::now() - Duration::from_secs(3),
        ));
        let mut capture = capture_callback(
            activity.clone(),
            16_000,
            1,
            frames,
            failures,
            muted.clone(),
            mute_epoch.clone(),
            |x: f32| x,
        );
        let instant = cpal::StreamInstant::new(0, 0);
        let info = cpal::InputCallbackInfo::new(cpal::InputStreamTimestamp {
            callback: instant,
            capture: instant,
        });
        capture(&vec![0.75; INPUT_FRAME_SAMPLES * 2], &info);
        assert!(
            activity.last_callback_ms.load(Ordering::Relaxed) >= 3_000,
            "muted capture must still report callback activity"
        );
        crate::system_input_mute::update_mute_state(&muted, &mute_epoch, false);
        assert!(
            queued.try_recv().is_err(),
            "muted audio survived until unmute"
        );
        capture(&vec![0.25; INPUT_FRAME_SAMPLES * 2], &info);
        let frame = queued.try_recv().expect("unmuted capture must continue");
        assert!(frame
            .samples
            .iter()
            .all(|sample| (*sample - 0.25).abs() < 0.001));
    }

    #[test]
    fn queued_audio_is_invalidated_by_a_mute_unmute_cycle() {
        let (frames, queued) = mpsc::sync_channel(32);
        let (failures, _errors) = mpsc::sync_channel(1);
        let muted = Arc::new(AtomicBool::new(false));
        let mute_epoch = Arc::new(AtomicU64::new(0));
        let activity = Arc::new(CaptureActivity::new(Instant::now()));
        let mut capture = capture_callback(
            activity,
            16_000,
            1,
            frames,
            failures,
            muted.clone(),
            mute_epoch.clone(),
            |x: f32| x,
        );
        let instant = cpal::StreamInstant::new(0, 0);
        let info = cpal::InputCallbackInfo::new(cpal::InputStreamTimestamp {
            callback: instant,
            capture: instant,
        });
        capture(&vec![0.5; INPUT_FRAME_SAMPLES * 2], &info);
        crate::system_input_mute::update_mute_state(&muted, &mute_epoch, true);
        crate::system_input_mute::update_mute_state(&muted, &mute_epoch, false);

        let stale = queued
            .try_recv()
            .expect("fixture must queue pre-mute audio");
        assert!(!captured_frame_is_current(
            &stale,
            muted.load(Ordering::SeqCst),
            mute_epoch.load(Ordering::SeqCst),
        ));
    }

    #[test]
    fn partial_audio_is_not_relabelled_after_a_complete_mute_cycle() {
        let (frames, queued) = mpsc::sync_channel(32);
        let (failures, _errors) = mpsc::sync_channel(1);
        let muted = Arc::new(AtomicBool::new(false));
        let mute_epoch = Arc::new(AtomicU64::new(0));
        let mut capture = capture_callback(
            Arc::new(CaptureActivity::new(Instant::now())),
            48_000,
            1,
            frames,
            failures,
            muted.clone(),
            mute_epoch.clone(),
            |x: f32| x,
        );
        let instant = cpal::StreamInstant::new(0, 0);
        let info = cpal::InputCallbackInfo::new(cpal::InputStreamTimestamp {
            callback: instant,
            capture: instant,
        });

        capture(&vec![0.5; INPUT_FRAME_SAMPLES / 2], &info);
        crate::system_input_mute::update_mute_state(&muted, &mute_epoch, true);
        crate::system_input_mute::update_mute_state(&muted, &mute_epoch, false);
        capture(&vec![0.25; INPUT_FRAME_SAMPLES / 2], &info);
        assert!(
            queued.try_recv().is_err(),
            "pre-cycle partial audio was relabelled with the current epoch"
        );

        capture(&vec![0.25; INPUT_FRAME_SAMPLES / 2 + 1], &info);
        let frame = queued.try_recv().expect("post-cycle audio must continue");
        assert!(frame
            .samples
            .iter()
            .all(|sample| (*sample - 0.25).abs() < 0.001));
    }

    #[test]
    fn audio_is_discarded_when_a_complete_mute_cycle_races_with_capture() {
        let (frames, queued) = mpsc::sync_channel(32);
        let (failures, _errors) = mpsc::sync_channel(1);
        let muted = Arc::new(AtomicBool::new(false));
        let mute_epoch = Arc::new(AtomicU64::new(0));
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (resume_tx, resume_rx) = mpsc::sync_channel(1);
        let first_sample = AtomicBool::new(true);
        let mut capture = capture_callback(
            Arc::new(CaptureActivity::new(Instant::now())),
            16_000,
            1,
            frames,
            failures,
            muted.clone(),
            mute_epoch.clone(),
            move |x: f32| {
                if first_sample.swap(false, Ordering::SeqCst) {
                    started_tx.send(()).unwrap();
                    resume_rx.recv().unwrap();
                }
                x
            },
        );
        let worker = thread::spawn(move || {
            let instant = cpal::StreamInstant::new(0, 0);
            let info = cpal::InputCallbackInfo::new(cpal::InputStreamTimestamp {
                callback: instant,
                capture: instant,
            });
            capture(&vec![0.5; INPUT_FRAME_SAMPLES], &info);
        });

        started_rx.recv().unwrap();
        crate::system_input_mute::update_mute_state(&muted, &mute_epoch, true);
        crate::system_input_mute::update_mute_state(&muted, &mute_epoch, false);
        resume_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(
            queued.try_recv().is_err(),
            "audio captured across the mute cycle was accepted"
        );
    }

    #[test]
    fn queued_audio_is_revalidated_inside_the_writer_lock() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let guard = writer.lock().unwrap();
        let muted = Arc::new(AtomicBool::new(false));
        let mute_epoch = Arc::new(AtomicU64::new(0));
        let frame = CapturedFrame {
            samples: [0.5; INPUT_FRAME_SAMPLES],
            mute_epoch: 0,
        };
        let (started_tx, started) = mpsc::sync_channel(1);
        let worker_writer = writer.clone();
        let worker_muted = muted.clone();
        let worker_epoch = mute_epoch.clone();
        let worker = thread::spawn(move || {
            started_tx.send(()).unwrap();
            send_captured_pcm(&worker_writer, &frame, &worker_muted, &worker_epoch)
        });
        started.recv().unwrap();
        crate::system_input_mute::update_mute_state(&muted, &mute_epoch, true);
        crate::system_input_mute::update_mute_state(&muted, &mute_epoch, false);
        drop(guard);
        worker.join().unwrap().unwrap();
        drop(writer);

        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert!(output.stdout.is_empty(), "stale PCM crossed the mute cycle");
    }

    #[test]
    fn blocked_pcm_write_is_cancelled_by_a_mute_transition() {
        let mut child = Command::new("/bin/sleep")
            .arg("5")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let flags = unsafe { libc::fcntl(stdin.as_raw_fd(), libc::F_GETFL) };
        assert!(flags >= 0);
        assert_eq!(
            unsafe { libc::fcntl(stdin.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) },
            0
        );
        let mut stdin = stdin;
        let fill = [0_u8; 4096];
        loop {
            match stdin.write(&fill) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("could not fill child input pipe: {error}"),
            }
        }
        assert_eq!(
            unsafe { libc::fcntl(stdin.as_raw_fd(), libc::F_SETFL, flags) },
            0
        );

        let writer = Arc::new(Mutex::new(stdin));
        let muted = Arc::new(AtomicBool::new(false));
        let mute_epoch = Arc::new(AtomicU64::new(0));
        let frame = CapturedFrame {
            samples: [0.5; INPUT_FRAME_SAMPLES],
            mute_epoch: 0,
        };
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (finished_tx, finished_rx) = mpsc::sync_channel(1);
        let worker_writer = writer.clone();
        let worker_muted = muted.clone();
        let worker_epoch = mute_epoch.clone();
        let worker = thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = send_captured_pcm(&worker_writer, &frame, &worker_muted, &worker_epoch);
            finished_tx.send(result).unwrap();
        });
        started_rx.recv().unwrap();
        thread::sleep(Duration::from_millis(20));
        crate::system_input_mute::update_mute_state(&muted, &mute_epoch, true);
        let cancelled = finished_rx.recv_timeout(Duration::from_millis(100)).is_ok();
        child.kill().unwrap();
        let _ = child.wait();
        worker.join().unwrap();
        assert!(
            cancelled,
            "stale PCM remained blocked after the mute transition"
        );
    }

    #[test]
    fn current_pcm_frame_larger_than_pipe_buf_is_written_completely() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let muted = AtomicBool::new(false);
        let mute_epoch = AtomicU64::new(0);
        let frame = CapturedFrame {
            samples: [0.5; INPUT_FRAME_SAMPLES],
            mute_epoch: 0,
        };
        send_captured_pcm(&writer, &frame, &muted, &mute_epoch).unwrap();
        drop(writer);

        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert!(output.stdout.len() > libc::PIPE_BUF as usize);
        assert_eq!(output.stdout[3], PCM_FRAME_KIND);
    }

    #[test]
    fn mute_transition_after_partial_pcm_write_aborts_the_transport() {
        struct PartialWriter {
            fd: std::fs::File,
            mute_epoch: Arc<AtomicU64>,
            first_write: bool,
        }

        impl Write for PartialWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.first_write {
                    self.first_write = false;
                    self.mute_epoch.fetch_add(1, Ordering::SeqCst);
                    return Ok(1);
                }
                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        impl AsRawFd for PartialWriter {
            fn as_raw_fd(&self) -> RawFd {
                self.fd.as_raw_fd()
            }
        }

        let muted = AtomicBool::new(false);
        let mute_epoch = Arc::new(AtomicU64::new(0));
        let frame = CapturedFrame {
            samples: [0.5; INPUT_FRAME_SAMPLES],
            mute_epoch: 0,
        };
        let mut writer = PartialWriter {
            fd: std::fs::File::open("/dev/null").unwrap(),
            mute_epoch: mute_epoch.clone(),
            first_write: true,
        };

        let error = write_cancellable_pcm(&mut writer, &[0_u8; 16], &frame, &muted, &mute_epoch)
            .unwrap_err();
        assert!(error.contains("mute changed during a PCM frame"));
    }

    #[test]
    fn speak_waits_for_pending_delivery_and_shutdown_releases_waiters() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio_commands, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio_commands);
        let (first_tx, first_rx) = mpsc::sync_channel(1);
        actor.pending_speak = Some(PendingSpeak {
            prepare_id: 2,
            text: "first".into(),
            non_blocking: false,
            response: Some(first_tx),
        });
        let (next_tx, next_rx) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::Speak {
                text: "next".into(),
                acknowledgement: Some(7),
                resolved_handoff_ids: Vec::new(),
                voice: None,
                language: None,
                relay: false,
                non_blocking: true,
                response: next_tx,
            })
            .unwrap();
        assert!(matches!(next_rx.try_recv(), Err(TryRecvError::Empty)));
        assert_eq!(actor.waiting_speaks.len(), 1);
        actor.finish_pending("voice call stopped");
        assert!(first_rx.recv().unwrap().is_err());
        assert!(next_rx.recv().unwrap().is_err());
        assert!(actor.waiting_speaks.is_empty());
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    fn restart_command() -> (ControlCommand, Receiver<Result<Value, String>>) {
        let (response, reply) = mpsc::sync_channel(1);
        let command = ControlCommand::Restart {
            arguments: vec!["session".into(), "--mode".into(), "conventional".into()],
            expert_spokesperson: false,
            tts: None,
            response,
        };
        (command, reply)
    }

    fn acknowledge_drain(commands: &Receiver<AudioCommand>) {
        let AudioCommand::Drain(response) = commands.try_recv().unwrap() else {
            panic!("expected a drain request");
        };
        response.send(()).unwrap();
    }

    #[test]
    fn a_restart_waits_for_the_speech_in_progress_and_the_speech_queued_behind_it() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (events_tx, events) = mpsc::sync_channel(8);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        let (playing_tx, playing) = mpsc::sync_channel(1);
        actor.pending_speak = Some(PendingSpeak {
            prepare_id: 2,
            text: "playing".into(),
            non_blocking: false,
            response: Some(playing_tx),
        });
        let (queued_tx, queued) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::Speak {
                text: "queued".into(),
                acknowledgement: None,
                resolved_handoff_ids: Vec::new(),
                voice: None,
                language: None,
                relay: false,
                non_blocking: false,
                response: queued_tx,
            })
            .unwrap();
        let (restart, restarted) = restart_command();
        actor.handle_command(restart).unwrap();
        actor.poll().unwrap();
        // The reply keeps playing: the switch waits for it and for what follows it.
        assert!(!actor.stopping);
        assert!(actor.restart.is_some());
        assert!(matches!(restarted.try_recv(), Err(TryRecvError::Empty)));
        assert!(matches!(playing.try_recv(), Err(TryRecvError::Empty)));
        events_tx
            .send(SessionMessage::SpeechCompleted {
                id: 2,
                speech_id: 1,
            })
            .unwrap();
        actor.poll().unwrap();
        assert_eq!(
            playing.try_recv().unwrap().unwrap(),
            json!({"spoke":true,"status":"completed"})
        );
        // The queued reply is next, and the session is still the old one.
        assert!(!actor.stopping);
        let queued_id = actor.pending_prepare_id().unwrap();
        events_tx
            .send(SessionMessage::SpeechCompleted {
                id: queued_id,
                speech_id: 2,
            })
            .unwrap();
        actor.poll().unwrap();
        assert_eq!(
            queued.try_recv().unwrap().unwrap(),
            json!({"spoke":true,"status":"completed"})
        );
        // The actor waits for the host even after requested speech completes.
        assert!(!actor.stopping);
        acknowledge_drain(&audio_rx);
        actor.poll().unwrap();
        assert!(actor.stopping);
        assert!(actor.restart.is_some());
        actor.finish_pending("voice session restarted");
        assert!(actor.pending_speak.is_none());
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn a_restart_does_not_wait_for_speech_forever() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        let (playing_tx, playing) = mpsc::sync_channel(1);
        actor.pending_speak = Some(PendingSpeak {
            prepare_id: 2,
            text: "playing".into(),
            non_blocking: false,
            response: Some(playing_tx),
        });
        let (restart, _restarted) = restart_command();
        actor.handle_command(restart).unwrap();
        actor.poll().unwrap();
        assert!(!actor.stopping);
        // A second restart cannot queue behind the first.
        let (second, refused) = restart_command();
        actor.handle_command(second).unwrap();
        assert!(refused.try_recv().unwrap().is_err());
        actor.restart_not_after = Instant::now();
        actor.poll().unwrap();
        assert!(actor.stopping);
        actor.finish_pending("voice session restarted");
        assert_eq!(
            playing.try_recv().unwrap().unwrap_err(),
            "voice session restarted"
        );
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn a_restart_waits_for_audio_ingress_before_playing_is_published() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        // An audio begin has reached the host, but it has not published playing yet.
        let (accepted, ingress) = mpsc::sync_channel(1);
        let (release, paused) = mpsc::sync_channel(1);
        let (host_ready, drain_requested) = mpsc::sync_channel(1);
        let (finished, drain_finished) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let mut begin = Vec::new();
            begin.extend_from_slice(&AUDIO_FRAME_MAGIC);
            begin.extend_from_slice(&[AUDIO_FRAME_MARKER, AUDIO_BEGIN_KIND]);
            begin.extend_from_slice(&16_u32.to_le_bytes());
            begin.extend_from_slice(&7_u64.to_le_bytes());
            begin.extend_from_slice(&24_000_u32.to_le_bytes());
            begin.extend_from_slice(&1_f32.to_le_bytes());
            assert_eq!(
                take_audio_record(&mut begin).unwrap().unwrap().0,
                AUDIO_BEGIN_KIND
            );
            accepted.send(()).unwrap();
            paused.recv().unwrap();
            let AudioCommand::Drain(response) =
                audio_rx.recv_timeout(Duration::from_secs(2)).unwrap()
            else {
                panic!("expected a drain request");
            };
            host_ready.send(()).unwrap();
            drain_finished.recv().unwrap();
            response.send(()).unwrap();
        });
        ingress.recv().unwrap();
        let (restart, _restarted) = restart_command();
        actor.handle_command(restart).unwrap();
        let waited_for_ingress = !actor.stopping;
        release.send(()).unwrap();
        drain_requested
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        actor.poll().unwrap();
        let waited_for_playback = !actor.stopping;
        finished.send(()).unwrap();
        worker.join().unwrap();
        assert!(
            waited_for_ingress,
            "restart must wait for the audio host to acknowledge drain"
        );
        assert!(
            waited_for_playback,
            "accepted audio must finish before shutdown"
        );
        actor.poll().unwrap();
        assert!(actor.stopping);
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    #[ignore = "opens the default CoreAudio output and queues silent PCM"]
    fn audio_host_drain_waits_for_audio_end_and_playback() {
        use std::os::fd::IntoRawFd;
        use std::os::unix::net::UnixStream;

        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (requests_tx, requests) = mpsc::channel();
        let mut stdout = child.stdout.take().unwrap();
        let reader = thread::spawn(move || {
            let mut header = [0; crate::session_framing::FRAME_HEADER_BYTES];
            while stdout.read_exact(&mut header).is_ok() {
                assert_eq!(&header[..2], &crate::session_framing::FRAME_MAGIC);
                assert_eq!(header[3], JSON_FRAME_KIND);
                let length = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
                let mut payload = vec![0; length];
                stdout.read_exact(&mut payload).unwrap();
                let request: Value = serde_json::from_slice(&payload).unwrap();
                if requests_tx.send(request).is_err() {
                    break;
                }
            }
        });
        let receive = |kind: &str| loop {
            let request = requests
                .recv_timeout(Duration::from_secs(5))
                .unwrap_or_else(|error| panic!("waiting for {kind}: {error}"));
            if request["type"] == kind {
                break request;
            }
            assert_eq!(
                request["type"], "audio_played",
                "unexpected host response: {request}"
            );
        };
        let (host, mut session) = UnixStream::pair().unwrap();
        // SAFETY: ownership of the host socket descriptor transfers to File.
        let audio = unsafe { File::from_raw_fd(host.into_raw_fd()) };
        let (commands, commands_rx) = mpsc::channel();
        let (failures_tx, failures) = mpsc::sync_channel(1);
        spawn_audio_host(audio, Arc::clone(&writer), commands_rx, failures_tx).unwrap();
        let mut record = |kind, payload: &[u8]| {
            session.write_all(&AUDIO_FRAME_MAGIC).unwrap();
            session.write_all(&[AUDIO_FRAME_MARKER, kind]).unwrap();
            session
                .write_all(&(payload.len() as u32).to_le_bytes())
                .unwrap();
            session.write_all(payload).unwrap();
        };
        let speech_id = 7_u64.to_le_bytes();
        record(
            AUDIO_BEGIN_KIND,
            &[
                speech_id.as_slice(),
                &24_000_u32.to_le_bytes(),
                &1_f32.to_le_bytes(),
            ]
            .concat(),
        );
        assert_eq!(receive("audio_begin_accepted")["speech_id"], 7);
        commands.send(AudioCommand::Suspend(7)).unwrap();
        receive("audio_suspended");
        record(
            AUDIO_CHUNK_KIND,
            &[speech_id.as_slice(), &1_u64.to_le_bytes(), &[0; 960 * 4]].concat(),
        );
        receive("audio_chunk_accepted");

        let (acknowledge, drained) = mpsc::sync_channel(1);
        commands.send(AudioCommand::Drain(acknowledge)).unwrap();
        // Suspension acknowledgement is emitted after the drain guard in the
        // real host loop, proving it processed Drain while AUDIO_END is absent.
        commands.send(AudioCommand::Suspend(7)).unwrap();
        receive("audio_suspended");
        assert_eq!(drained.try_recv(), Err(TryRecvError::Empty));

        record(
            AUDIO_END_KIND,
            &[
                speech_id.as_slice(),
                &1_u64.to_le_bytes(),
                &960_u64.to_le_bytes(),
            ]
            .concat(),
        );
        commands.send(AudioCommand::Suspend(7)).unwrap();
        receive("audio_suspended");
        assert_eq!(
            drained.try_recv(),
            Err(TryRecvError::Empty),
            "ended audio still has paused playback queued"
        );
        commands.send(AudioCommand::Resume(7)).unwrap();
        receive("audio_resumed");
        let completed = receive("audio_drained");
        assert_eq!(completed["sequence"], 1);
        assert_eq!(completed["played_frames"], 960);
        drained.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(failures.try_recv().is_err());
        drop(commands);
        drop(session);
        drop(writer);
        assert!(child.wait().unwrap().success());
        reader.join().unwrap();
    }

    #[test]
    fn a_restart_waits_for_the_spokesperson_reply_playing_without_a_speak() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        // The Spokesperson is mid-reply: audio plays, but no speak was requested.
        assert!(actor.pending_speak.is_none() && actor.waiting_speaks.is_empty());
        let (restart, _restarted) = restart_command();
        actor.handle_command(restart).unwrap();
        actor.poll().unwrap();
        assert!(!actor.stopping);
        assert!(actor.restart.is_some());
        // Between replies, the restart goes ahead.
        acknowledge_drain(&audio_rx);
        actor.poll().unwrap();
        assert!(actor.stopping);
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn a_restart_does_not_wait_forever_for_audio_that_never_ends() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        let (restart, _restarted) = restart_command();
        actor.handle_command(restart).unwrap();
        actor.poll().unwrap();
        assert!(!actor.stopping);
        actor.restart_not_after = Instant::now();
        actor.poll().unwrap();
        assert!(actor.stopping);
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn an_idle_restart_starts_after_the_host_acknowledges_drain() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        let (restart, _restarted) = restart_command();
        actor.handle_command(restart).unwrap();
        assert!(!actor.stopping);
        acknowledge_drain(&audio_rx);
        actor.poll().unwrap();
        assert!(actor.stopping);
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn ending_the_call_still_cuts_off_speech_and_a_waiting_restart() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        let (playing_tx, _playing) = mpsc::sync_channel(1);
        actor.pending_speak = Some(PendingSpeak {
            prepare_id: 2,
            text: "playing".into(),
            non_blocking: false,
            response: Some(playing_tx),
        });
        let (restart, restarted) = restart_command();
        actor.handle_command(restart).unwrap();
        actor.stop().unwrap();
        assert!(actor.stopping);
        assert!(actor.restart.is_none());
        assert_eq!(
            restarted.try_recv().unwrap().unwrap_err(),
            "voice call stopped"
        );
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    fn test_snapshot() -> VoiceSessionSnapshot {
        VoiceSessionSnapshot {
            spokesperson: None,
            tts: berd_call::TtsConfigurationSnapshot {
                revision: 1,
                settings: berd_call::TtsSettings::Siri {
                    voice: "Aaron".into(),
                    language: "en-US".into(),
                    rate: 1.0,
                },
            },
            input_during_tts: berd_call::input::InputDuringTtsSnapshot {
                revision: 1,
                policy: InputDuringTtsPolicy::AllowBargeIn,
            },
        }
    }

    fn test_actor(
        writer: Arc<Mutex<ChildStdin>>,
        events: Receiver<SessionMessage>,
        commands: Receiver<ControlCommand>,
        audio_commands: SyncSender<AudioCommand>,
    ) -> SessionActor {
        let session = Arc::new(Mutex::new(test_snapshot()));
        SessionActor::new(
            writer,
            events,
            commands,
            audio_commands,
            session,
            Arc::new(Transcript::Stdout { live: false }),
            false,
        )
    }

    #[test]
    fn user_interim_stream_shows_words_and_clears_on_mute_and_reset() {
        const CHILD: &str = "BERD_CALL_TEST_INTERIM_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "host_session::tests::user_interim_stream_shows_words_and_clears_on_mute_and_reset", "--nocapture"])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let stdout = String::from_utf8(output.stdout).unwrap();
            let rows: Vec<Value> = stdout
                .lines()
                .filter_map(|line| {
                    line.strip_prefix("0\tuser_interim\t")
                        .map(|text| serde_json::from_str(text).unwrap())
                })
                .collect();
            let expected: Vec<_> = [
                (3, "you sh"),
                (3, "you should\tgo"),
                (3, ""),
                (4, "next"),
                (0, ""),
                (5, "back"),
                (0, ""),
            ]
            .into_iter()
            .map(|(cursor, text)| json!({"cursor": cursor, "text": text}))
            .collect();
            assert_eq!(rows, expected, "{stdout}");
            return;
        }
        for (transcript, expert) in [
            (Transcript::Stdout { live: false }, false),
            (Transcript::Silent, false),
            (Transcript::Stdout { live: true }, true),
        ] {
            let mut child = Command::new("/bin/cat")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap();
            let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
            let (_event_tx, events) = mpsc::sync_channel(1);
            let (_command_tx, commands) = mpsc::sync_channel(1);
            let (audio, _audio_rx) = mpsc::sync_channel(1);
            let mut actor = test_actor(writer, events, commands, audio);
            actor.transcript = Arc::new(transcript);
            actor.expert_spokesperson = expert;
            actor.muted.store(false, Ordering::SeqCst);
            let interim = |token, text: &str| SessionMessage::UserInterim {
                token,
                text: text.into(),
            };
            let mute = |active| SessionMessage::InputMuteApplied { id: 0, active };
            for event in [
                interim(3, "you sh"),
                interim(3, "you should\tgo"),
                interim(3, ""),
                interim(4, ""),
                interim(4, "next"),
                mute(true),
                interim(4, "muted words"),
                mute(false),
                interim(5, "back"),
            ] {
                actor.handle_event(event).unwrap();
            }
            actor.reset_input_activity().unwrap();
            actor.reset_input_activity().unwrap();
            assert!(actor.transcribed.is_empty());
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }

    #[test]
    fn input_activity_is_cursorless_and_preserves_both_states() {
        for speaking in [false, true] {
            for recognizing in [false, true] {
                let line = input_activity_line(speaking, recognizing);
                let fields: Vec<_> = line.split('\t').collect();
                assert_eq!(fields[..2], ["0", "input_activity"]);
                let state: Value = serde_json::from_str(fields[2]).unwrap();
                assert_eq!(
                    state,
                    json!({"speaking": speaking, "recognizing": recognizing})
                );
            }
        }
    }

    #[test]
    fn input_activity_stream_covers_transitions_mute_and_recovery() {
        const CHILD: &str = "BERD_CALL_TEST_ACTIVITY_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "host_session::tests::input_activity_stream_covers_transitions_mute_and_recovery", "--nocapture"])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let stdout = String::from_utf8(output.stdout).unwrap();
            let rows: Vec<Value> = stdout
                .lines()
                .filter_map(|line| {
                    line.strip_prefix("0\tinput_activity\t")
                        .map(|text| serde_json::from_str(text).unwrap())
                })
                .collect();
            let expected: Vec<_> = [
                (true, false),
                (true, true),
                (false, true),
                (false, false),
                (false, false),
                (false, false),
                (false, true),
                (true, true),
                (false, false),
                (true, false),
                (true, true),
                (false, false),
                (true, false),
                (true, true),
                (false, false),
            ]
            .into_iter()
            .map(|(speaking, recognizing)| json!({"speaking":speaking, "recognizing":recognizing}))
            .collect();
            assert_eq!(rows, expected, "{stdout}");
            return;
        }
        for stream in [true, false] {
            let mut child = Command::new("/bin/cat")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap();
            let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
            let (_event_tx, events) = mpsc::sync_channel(1);
            let (_command_tx, commands) = mpsc::sync_channel(1);
            let (audio, _audio_rx) = mpsc::sync_channel(1);
            let mut actor = test_actor(writer, events, commands, audio);
            if !stream {
                actor.transcript = Arc::new(Transcript::Silent);
            }
            actor.muted.store(false, Ordering::SeqCst);
            let next_id = actor.next_id;
            for event in [
                SessionMessage::InputSpeaking { active: true },
                SessionMessage::RecognitionPending { active: true },
                SessionMessage::InputSpeaking { active: false },
                SessionMessage::InputMuteApplied {
                    id: 0,
                    active: true,
                },
                SessionMessage::InputSpeaking { active: true },
                SessionMessage::InputSpeaking { active: false },
                SessionMessage::InputMuteApplied {
                    id: 0,
                    active: false,
                },
                SessionMessage::InputSpeaking { active: true },
            ] {
                actor.handle_event(event).unwrap();
            }
            actor.reset_input_activity().unwrap();
            actor
                .handle_event(SessionMessage::InputSpeaking { active: false })
                .unwrap();
            for device_missing in [true, false] {
                actor
                    .handle_event(SessionMessage::InputSpeaking { active: true })
                    .unwrap();
                actor
                    .handle_event(SessionMessage::RecognitionPending { active: true })
                    .unwrap();
                let mut recovery =
                    crate::microphone_recovery::MicrophoneRecovery::new("input".into(), ());
                let change = recovery
                    .reconcile(
                        Instant::now(),
                        if device_missing {
                            Err("unavailable".into())
                        } else {
                            Ok("input".into())
                        },
                        true,
                        |_| Ok(()),
                        || Err("replacement open failed".into()),
                    )
                    .unwrap();
                assert!(change.invalidated);
                assert!(!change.opened);
                if change.invalidated || change.opened {
                    actor.reset_input_activity().unwrap();
                }
                assert!(
                    !actor.input_speaking && !actor.recognition_pending,
                    "invalidated capture must clear activity before recovery retries"
                );
                assert!(recovery.capture().is_none());
            }
            assert_eq!(actor.next_id, next_id);
            assert!(actor.transcribed.is_empty());
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }

    #[test]
    fn polling_waits_for_finalized_input_and_releases_waiters_on_shutdown() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_event_tx, events) = mpsc::sync_channel(1);
        let (_command_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        let (response, result) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::PollInput {
                since: Some(0),
                wait: true,
                timeout_seconds: 30,
                response,
            })
            .unwrap();
        actor
            .handle_event(SessionMessage::InputSpeaking { active: true })
            .unwrap();
        actor.poll_input_requests().unwrap();
        assert!(actor.pending_polls[0].request_id.is_some());
        assert!(result.try_recv().is_err());
        actor
            .handle_event(SessionMessage::InputSpeaking { active: false })
            .unwrap();
        actor.poll_input_requests().unwrap();
        let id = actor.pending_polls[0].request_id.unwrap();
        actor
            .handle_event(SessionMessage::State {
                id,
                confirmed_token: 0,
                utterances_after: vec![berd_call::protocol::PendingUtterance {
                    token: 1,
                    text: "hello".into(),
                    origin: Some(UtteranceOrigin::Spokesperson),
                }],
                unresolved_handoff_ids: vec![],
            })
            .unwrap();
        assert!(
            result.try_recv().is_err(),
            "spokesperson speech must not wake input waiters"
        );
        actor.pending_polls[0].next_query = Instant::now();
        actor.poll_input_requests().unwrap();
        let id = actor.pending_polls[0].request_id.unwrap();
        actor
            .handle_event(SessionMessage::State {
                id,
                confirmed_token: 0,
                utterances_after: vec![berd_call::protocol::PendingUtterance {
                    token: 2,
                    text: "question".into(),
                    origin: Some(UtteranceOrigin::User),
                }],
                unresolved_handoff_ids: vec![],
            })
            .unwrap();
        let value = result.recv().unwrap().unwrap();
        assert_eq!(value["cursor"], 2);
        assert_eq!(value["utterances"][0]["text"], "question");
        let (response, result) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::PollInput {
                since: Some(2),
                wait: true,
                timeout_seconds: 30,
                response,
            })
            .unwrap();
        actor.poll_input_requests().unwrap();
        let id = actor.pending_polls[0].request_id.unwrap();
        let handoff = berd_call::protocol::PendingUtterance {
            token: 3,
            text: "Look up the branch".into(),
            origin: Some(UtteranceOrigin::Handoff),
        };
        actor
            .handle_event(SessionMessage::State {
                id: id + 100,
                confirmed_token: 2,
                utterances_after: vec![handoff.clone()],
                unresolved_handoff_ids: vec!["handoff-external-3".into()],
            })
            .unwrap();
        assert!(
            result.try_recv().is_err(),
            "unrelated state must not finish a poll"
        );
        actor
            .handle_event(SessionMessage::State {
                id,
                confirmed_token: 2,
                utterances_after: vec![handoff],
                unresolved_handoff_ids: vec!["handoff-external-3".into()],
            })
            .unwrap();
        let value = result.recv().unwrap().unwrap();
        assert_eq!(value["cursor"], 3);
        assert_eq!(value["utterances"][0]["text"], "Look up the branch");
        assert_eq!(value["unresolvedHandoffIds"], json!(["handoff-external-3"]));
        let (response, result) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::PollInput {
                since: Some(2),
                wait: true,
                timeout_seconds: 30,
                response,
            })
            .unwrap();
        actor.finish_pending("voice session restarted");
        assert_eq!(
            result.recv().unwrap().unwrap_err(),
            "voice session restarted"
        );
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn catch_up_waits_for_recognition_to_finalize() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_event_tx, events) = mpsc::sync_channel(1);
        let (_command_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        let (response, result) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::PollInput {
                since: Some(0),
                wait: false,
                timeout_seconds: 30,
                response,
            })
            .unwrap();
        actor
            .handle_event(SessionMessage::RecognitionPending { active: true })
            .unwrap();
        actor.poll_input_requests().unwrap();
        let id = actor.pending_polls[0].request_id.unwrap();
        actor
            .handle_event(SessionMessage::State {
                id,
                confirmed_token: 0,
                utterances_after: vec![],
                unresolved_handoff_ids: vec![],
            })
            .unwrap();
        assert!(
            result.try_recv().is_err(),
            "catch-up returned before recognition finalized"
        );
        actor
            .handle_event(SessionMessage::RecognitionPending { active: false })
            .unwrap();
        actor.pending_polls[0].next_query = Instant::now();
        actor.poll_input_requests().unwrap();
        let id = actor.pending_polls[0].request_id.unwrap();
        actor
            .handle_event(SessionMessage::State {
                id,
                confirmed_token: 0,
                utterances_after: vec![berd_call::protocol::PendingUtterance {
                    token: 1,
                    text: "recognized text".into(),
                    origin: Some(UtteranceOrigin::User),
                }],
                unresolved_handoff_ids: vec![],
            })
            .unwrap();
        assert_eq!(
            result.recv().unwrap().unwrap()["utterances"][0]["text"],
            "recognized text"
        );
        drop(actor);
        child.wait().unwrap();
    }

    #[test]
    fn timeout_without_known_acknowledged_cursor_does_not_fabricate_zero() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_event_tx, events) = mpsc::sync_channel(1);
        let (_command_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        let (response, result) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::PollInput {
                since: None,
                wait: true,
                timeout_seconds: 1,
                response,
            })
            .unwrap();
        actor.input_speaking = true;
        actor.pending_polls[0].deadline = Instant::now();
        actor.poll_input_requests().unwrap();
        assert!(
            result.recv().unwrap().is_err(),
            "unknown baseline must not become cursor zero"
        );
        drop(actor);
        child.wait().unwrap();
    }

    #[test]
    fn catch_up_uses_acknowledged_cursor_and_wait_timeout_does_not_acknowledge() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_event_tx, events) = mpsc::sync_channel(1);
        let (_command_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        let (response, result) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::PollInput {
                since: None,
                wait: false,
                timeout_seconds: 30,
                response,
            })
            .unwrap();
        actor.poll_input_requests().unwrap();
        let id = actor.pending_polls[0].request_id.unwrap();
        actor
            .handle_event(SessionMessage::State {
                id,
                confirmed_token: 2,
                utterances_after: vec![berd_call::protocol::PendingUtterance {
                    token: 2,
                    text: "already answered".into(),
                    origin: None,
                }],
                unresolved_handoff_ids: vec![],
            })
            .unwrap();
        let value = result.recv().unwrap().unwrap();
        assert_eq!(value["cursor"], 2);
        assert_eq!(value["utterances"], json!([]));
        let (response, result) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::PollInput {
                since: Some(2),
                wait: true,
                timeout_seconds: 30,
                response,
            })
            .unwrap();
        actor.pending_polls[0].deadline = Instant::now();
        actor.poll_input_requests().unwrap();
        let value = result.recv().unwrap().unwrap();
        assert_eq!(value["timedOut"], true);
        assert_eq!(value["cursor"], 2);
        assert!(actor.pending_polls.is_empty());
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn independent_calls_do_not_overwrite_other_saved_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let make_actor = || {
            let mut child = Command::new("/bin/cat")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap();
            let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
            let (_events, receiver) = mpsc::sync_channel(1);
            let (_commands, commands) = mpsc::sync_channel(1);
            let (audio, _audio_rx) = mpsc::sync_channel(1);
            let mut actor = test_actor(writer, receiver, commands, audio);
            actor.saved = Some((
                path.clone(),
                crate::saved_settings::SavedSettings::default(),
            ));
            (actor, child)
        };
        let (mut first, mut first_child) = make_actor();
        let (mut second, mut second_child) = make_actor();
        crate::saved_settings::save(
            &path,
            &crate::saved_settings::SavedSettings {
                arguments: [
                    "--tts-backend",
                    "siri",
                    "--voice",
                    "Aaron",
                    "--language",
                    "en-US",
                    "--stt-backend",
                    "openai",
                    "--mode",
                    "expert-spokesperson",
                ]
                .map(str::to_string)
                .to_vec(),
                ..crate::saved_settings::SavedSettings::default()
            },
        )
        .unwrap();
        first
            .handle_event(SessionMessage::InputMuteApplied {
                id: 1,
                active: true,
            })
            .unwrap();
        let mut snapshot = test_snapshot().tts;
        snapshot.settings = berd_call::TtsSettings::OpenAi {
            model: "gpt-4o-mini-tts".into(),
            voice: "marin".into(),
            rate: 1.5,
        };
        second
            .handle_event(SessionMessage::TtsSettingsResult {
                id: 2,
                outcome: berd_call::protocol::TtsSettingsOutcome::Applied,
                snapshot,
                message: None,
            })
            .unwrap();
        let saved = crate::saved_settings::load(&path).unwrap();
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("\"muted\""));
        assert!(matches!(
            saved.tts,
            Some(berd_call::TtsSettings::OpenAi { rate: 1.5, .. })
        ));
        assert!(saved
            .arguments
            .windows(2)
            .any(|pair| pair == ["--tts-backend", "openai"]));
        assert!(!saved.arguments.iter().any(|argument| argument == "siri"));
        assert!(saved
            .arguments
            .windows(2)
            .any(|pair| pair == ["--stt-backend", "openai"]));
        assert!(saved
            .arguments
            .windows(2)
            .any(|pair| pair == ["--mode", "expert-spokesperson"]));
        drop(first);
        drop(second);
        first_child.wait().unwrap();
        second_child.wait().unwrap();
    }

    #[test]
    fn spokesperson_results_change_and_save_only_its_voice() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events, receiver) = mpsc::sync_channel(1);
        let (_commands, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, receiver, commands, audio);
        let openai = |voice: &str, revision| berd_call::TtsConfigurationSnapshot {
            revision,
            settings: berd_call::TtsSettings::OpenAi {
                model: "gpt-realtime".into(),
                voice: voice.into(),
                rate: 1.25,
            },
        };
        actor.session.lock().unwrap().spokesperson = Some(openai("marin", 1));
        let saved = crate::saved_settings::SavedSettings {
            arguments: ["--voice", "Aaron", "--language", "en-US"]
                .map(str::to_string)
                .to_vec(),
            ..crate::saved_settings::SavedSettings::default()
        };
        crate::saved_settings::save(&path, &saved).unwrap();
        actor.saved = Some((path.clone(), saved));
        let (response, result) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::SpokespersonSettings {
                settings: openai("cedar", 1).settings,
                expected_revision: 1,
                response,
            })
            .unwrap();
        let id = *actor.spokesperson_settings.iter().next().unwrap();
        actor
            .handle_event(SessionMessage::TtsSettingsResult {
                id,
                outcome: berd_call::protocol::TtsSettingsOutcome::Applied,
                snapshot: openai("cedar", 2),
                message: None,
            })
            .unwrap();
        assert_eq!(result.recv().unwrap().unwrap()["outcome"], "applied");
        let session = actor.session.lock().unwrap().clone();
        assert_eq!(session.spokesperson, Some(openai("cedar", 2)));
        assert_eq!(session.tts, test_snapshot().tts);
        let saved = crate::saved_settings::load(&path).unwrap();
        assert_eq!(saved.tts, None);
        assert_eq!(
            saved.arguments,
            [
                "--voice",
                "Aaron",
                "--language",
                "en-US",
                "--spokesperson-voice",
                "cedar",
                "--spokesperson-rate",
                "1.25"
            ]
            .map(str::to_string)
        );
        drop(actor);
        child.wait().unwrap();
    }

    #[test]
    fn pocket_tts_save_preserves_the_active_bundle_path() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let bundle = directory.path().join("pocket-bundle");
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events, receiver) = mpsc::sync_channel(1);
        let (_commands, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, receiver, commands, audio);
        actor.saved = Some((
            path.clone(),
            crate::saved_settings::SavedSettings {
                arguments: [
                    "--tts-backend".to_string(),
                    "pocket".to_string(),
                    "--model-dir".to_string(),
                    bundle.display().to_string(),
                ]
                .to_vec(),
                ..crate::saved_settings::SavedSettings::default()
            },
        ));
        let mut snapshot = test_snapshot().tts;
        snapshot.settings = berd_call::TtsSettings::Pocket {
            model: "en_US-hfc_female-medium".into(),
            voice: "default".into(),
            rate: 1.2,
        };
        actor
            .handle_event(SessionMessage::TtsSettingsResult {
                id: 1,
                outcome: berd_call::protocol::TtsSettingsOutcome::Applied,
                snapshot,
                message: None,
            })
            .unwrap();

        let saved = crate::saved_settings::load(&path).unwrap();
        assert!(saved.arguments.windows(2).any(|pair| {
            pair == [
                "--model-dir",
                bundle.to_str().expect("temporary path is UTF-8"),
            ]
        }));
        drop(actor);
        child.wait().unwrap();
    }

    #[test]
    fn only_accepted_settings_are_saved_before_acknowledgement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_event_tx, events) = mpsc::sync_channel(1);
        let (_command_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        actor.saved = Some((
            path.clone(),
            crate::saved_settings::SavedSettings::default(),
        ));
        let mut snapshot = test_snapshot().tts;
        snapshot.settings = snapshot.settings.with_rate(1.5);
        actor
            .handle_event(SessionMessage::TtsSettingsResult {
                id: 42,
                outcome: berd_call::protocol::TtsSettingsOutcome::Rejected,
                snapshot: snapshot.clone(),
                message: Some("rejected".into()),
            })
            .unwrap();
        assert!(!path.exists());
        let (response, result) = mpsc::sync_channel(1);
        actor.pending_settings.insert(43, response);
        actor
            .handle_event(SessionMessage::TtsSettingsResult {
                id: 43,
                outcome: berd_call::protocol::TtsSettingsOutcome::Applied,
                snapshot,
                message: None,
            })
            .unwrap();
        result.recv().unwrap().unwrap();
        assert_eq!(
            crate::saved_settings::load(&path)
                .unwrap()
                .tts
                .unwrap()
                .rate(),
            1.5
        );
        let before_mute = std::fs::read(&path).unwrap();
        actor
            .handle_event(SessionMessage::InputMuteApplied {
                id: 44,
                active: true,
            })
            .unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before_mute,
            "transient microphone mute changed saved preferences"
        );
        assert_eq!(
            crate::saved_settings::load(&path).unwrap().input_policy,
            None,
            "saving unrelated settings must not freeze the route-derived policy"
        );
        actor
            .handle_event(SessionMessage::InputDuringTtsResult {
                id: 45,
                outcome: berd_call::protocol::InputDuringTtsOutcome::Applied,
                snapshot: berd_call::input::InputDuringTtsSnapshot {
                    revision: 2,
                    policy: InputDuringTtsPolicy::SuppressInput,
                },
            })
            .unwrap();
        assert_eq!(
            crate::saved_settings::load(&path).unwrap().input_policy,
            Some(InputDuringTtsPolicy::SuppressInput)
        );
        child.kill().unwrap();
        child.wait().unwrap();
    }

    fn saved_preferences_with_tts() -> crate::saved_settings::SavedSettings {
        crate::saved_settings::SavedSettings {
            arguments: [
                "--mode",
                "chained",
                "--stt-backend",
                "macos",
                "--tts-backend",
                "siri",
                "--voice",
                "Missing Voice",
                "--language",
                "en-US",
            ]
            .map(str::to_string)
            .to_vec(),
            tts: Some(berd_call::TtsSettings::Siri {
                voice: "Missing Voice".into(),
                language: "en-US".into(),
                rate: 1.0,
            }),
            input_policy: Some(InputDuringTtsPolicy::SuppressInput),
            status_sounds: None,
            ..Default::default()
        }
    }

    fn assert_only_tts_was_quarantined(path: &std::path::Path) {
        let saved = crate::saved_settings::load(path).unwrap();
        assert!(saved.tts.is_none());
        assert_eq!(
            saved.input_policy,
            Some(InputDuringTtsPolicy::SuppressInput)
        );
        assert!(saved
            .arguments
            .windows(2)
            .any(|pair| pair == ["--mode", "chained"]));
        assert!(saved
            .arguments
            .windows(2)
            .any(|pair| pair == ["--stt-backend", "macos"]));
        assert!(!saved.arguments.iter().any(|argument| {
            matches!(
                argument.as_str(),
                "--tts-backend" | "--voice" | "--language" | "--rate" | "--model-dir"
            )
        }));
    }

    #[test]
    fn rejected_saved_tts_does_not_block_startup_and_is_quarantined() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        crate::saved_settings::save(&path, &saved_preferences_with_tts()).unwrap();
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio_commands, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio_commands);
        actor.saved = Some((path.clone(), saved_preferences_with_tts()));
        events_tx
            .send(SessionMessage::TtsSettingsResult {
                id: 2,
                outcome: berd_call::protocol::TtsSettingsOutcome::Rejected,
                snapshot: test_snapshot().tts,
                message: Some("voice unavailable".into()),
            })
            .unwrap();

        actor
            .restore_saved_tts(
                saved_preferences_with_tts().tts.unwrap(),
                1,
                Duration::from_millis(50),
            )
            .unwrap();
        assert_only_tts_was_quarantined(&path);
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn timed_out_saved_tts_does_not_block_startup_and_is_quarantined() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        crate::saved_settings::save(&path, &saved_preferences_with_tts()).unwrap();
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio_commands, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio_commands);
        actor.saved = Some((path.clone(), saved_preferences_with_tts()));

        actor
            .restore_saved_tts(saved_preferences_with_tts().tts.unwrap(), 1, Duration::ZERO)
            .unwrap();
        assert_only_tts_was_quarantined(&path);
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn rejected_restore_does_not_overwrite_newer_saved_tts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let stale = saved_preferences_with_tts();
        crate::saved_settings::save(&path, &stale).unwrap();
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio_commands, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio_commands);
        actor.saved = Some((path.clone(), stale.clone()));

        let mut newer = stale;
        newer.tts = Some(berd_call::TtsSettings::Siri {
            voice: "Samantha".into(),
            language: "en-US".into(),
            rate: 1.25,
        });
        newer.arguments = crate::saved_settings::merge_arguments(
            &newer.arguments,
            &[
                "--tts-backend".into(),
                "siri".into(),
                "--voice".into(),
                "Samantha".into(),
                "--language".into(),
                "en-US".into(),
                "--rate".into(),
                "1.25".into(),
            ],
        );
        crate::saved_settings::save(&path, &newer).unwrap();
        events_tx
            .send(SessionMessage::TtsSettingsResult {
                id: 2,
                outcome: berd_call::protocol::TtsSettingsOutcome::Rejected,
                snapshot: test_snapshot().tts,
                message: Some("voice unavailable".into()),
            })
            .unwrap();

        actor
            .restore_saved_tts(
                saved_preferences_with_tts().tts.unwrap(),
                1,
                Duration::from_millis(50),
            )
            .unwrap();
        actor.persist_settings(SavedPreference::SessionStart);

        actor.saved.as_mut().unwrap().1.input_policy = Some(InputDuringTtsPolicy::SuppressInput);
        actor.persist_settings(SavedPreference::InputPolicy);

        let saved = crate::saved_settings::load(&path).unwrap();
        assert_eq!(saved.tts, newer.tts);
        assert_eq!(
            saved.input_policy,
            Some(InputDuringTtsPolicy::SuppressInput)
        );
        assert!(saved
            .arguments
            .windows(2)
            .any(|pair| pair == ["--voice", "Samantha"]));
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn failed_restore_never_persists_fallback_over_a_later_tts_save() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let stale = saved_preferences_with_tts();
        crate::saved_settings::save(&path, &stale).unwrap();
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio_commands, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio_commands);
        actor.saved = Some((path.clone(), stale));
        events_tx
            .send(SessionMessage::TtsSettingsResult {
                id: 2,
                outcome: berd_call::protocol::TtsSettingsOutcome::Rejected,
                snapshot: test_snapshot().tts,
                message: Some("voice unavailable".into()),
            })
            .unwrap();
        actor
            .restore_saved_tts(
                saved_preferences_with_tts().tts.unwrap(),
                1,
                Duration::from_millis(50),
            )
            .unwrap();

        let mut newer = saved_preferences_with_tts();
        newer.tts = Some(berd_call::TtsSettings::Siri {
            voice: "Samantha".into(),
            language: "en-US".into(),
            rate: 1.25,
        });
        crate::saved_settings::save(&path, &newer).unwrap();
        actor.persist_settings(SavedPreference::SessionStart);

        assert_eq!(crate::saved_settings::load(&path).unwrap().tts, newer.tts);
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    #[ignore = "changes this test process's macOS input mute state"]
    fn native_gesture_uses_actor_acknowledgement() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_event_tx, events) = mpsc::sync_channel(1);
        let (_command_tx, commands) = mpsc::sync_channel(1);
        let (audio, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio);
        actor.system_input_mute = Some(
            crate::system_input_mute::SystemInputMute::install(
                actor.capture_muted.clone(),
                actor.capture_mute_epoch.clone(),
            )
            .unwrap(),
        );
        let application = unsafe { objc2_avf_audio::AVAudioApplication::sharedInstance() };
        unsafe { application.setInputMuted_error(true) }.unwrap();
        actor.poll().unwrap();
        assert!(actor.capture_muted.load(Ordering::SeqCst));
        assert!(!actor.muted.load(Ordering::SeqCst));
        assert!(actor.pending_settings.is_empty());
        let id = actor.next_id - 1;
        actor
            .handle_event(SessionMessage::InputMuteApplied { id, active: true })
            .unwrap();
        assert!(actor.muted.load(Ordering::SeqCst));
        let (response, result) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::Muted {
                muted: false,
                response,
            })
            .unwrap();
        assert!(!actor.capture_muted.load(Ordering::SeqCst));
        assert!(!unsafe { application.isInputMuted() });
        let id = *actor.pending_settings.keys().next().unwrap();
        actor
            .handle_event(SessionMessage::InputMuteApplied { id, active: false })
            .unwrap();
        assert_eq!(result.recv().unwrap().unwrap()["muted"], false);
        actor.poll().unwrap();
        assert!(
            actor.pending_settings.is_empty(),
            "programmatic mute echoed as another command"
        );
        let (response, _reply) = mpsc::sync_channel(1);
        let start = actor.restart_start(
            PendingRestart {
                arguments: vec!["session".into()],
                expert_spokesperson: false,
                tts: None,
                response,
            },
            InputDuringTtsPolicy::AllowBargeIn,
        );
        assert!(start.system_input_mute.is_some());
        drop(actor);
        unsafe { application.setInputMuted_error(true) }.unwrap();
        assert!(start.muted.load(Ordering::SeqCst));
        unsafe { application.setInputMuted_error(false) }.unwrap();
        assert!(!start.muted.load(Ordering::SeqCst));
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn mute_is_committed_before_it_is_acknowledged() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio_commands, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio_commands);
        let muted = Arc::clone(&actor.muted);
        let (response, acknowledged) = mpsc::sync_channel(1);
        let id = actor.next_id;
        actor
            .handle_command(ControlCommand::Muted {
                muted: true,
                response,
            })
            .unwrap();
        actor
            .handle_event(SessionMessage::InputMuteApplied { id, active: true })
            .unwrap();
        acknowledged.recv().unwrap().unwrap();
        // The acknowledged mute state remains available across restart handoff.
        assert!(muted.load(Ordering::SeqCst));
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn hooks_hold_the_bound_session_to_answering_the_call() {
        let (commands, receiver) = mpsc::sync_channel(8);
        let input = Arc::new(Mutex::new(json!([])));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let worker = {
            let (input, seen) = (Arc::clone(&input), Arc::clone(&seen));
            thread::spawn(move || {
                while let Ok(command) = receiver.recv() {
                    let mut seen = seen.lock().unwrap();
                    match command {
                        ControlCommand::PollInput {
                            since: None,
                            wait: false,
                            response,
                            ..
                        } => {
                            let utterances = input.lock().unwrap().clone();
                            let _ = response.send(Ok(json!({
                                "utterances": utterances, "cursor": 4,
                                "unresolvedHandoffIds": [], "timedOut": false,
                            })));
                        }
                        ControlCommand::StatusSounds {
                            mode: None,
                            status: Some(status),
                            response,
                        } => {
                            seen.push(format!("{status:?}"));
                            let _ = response.send(Ok(json!({})));
                        }
                        ControlCommand::Speak { text, response, .. } => {
                            seen.push(text);
                            let _ = response.send(Ok(json!({"spoke":true,"status":"completed"})));
                        }
                        _ => panic!("unexpected command"),
                    }
                }
            })
        };
        let control = SessionControl {
            commands,
            running: Arc::new(AtomicBool::new(true)),
            ready: ReadyState {
                session: Arc::new(Mutex::new(test_snapshot())),
            },
            non_blocking: Arc::new(AtomicBool::new(false)),
            stop_requested: Arc::new(AtomicBool::new(false)),
            muted: Arc::new(AtomicBool::new(false)),
            status_sounds: Arc::default(),
            transcript: Arc::new(Transcript::Silent),
            speaks: true,
            session_arguments: vec!["session".into()],
            hooks: Arc::new(HookBinding::new(Some("main".into()), 5222)),
        };
        let hook = |event, session, subagent, call| {
            control.hook(event, session, subagent, call).unwrap()["block"]
                .as_str()
                .map(str::to_string)
        };

        // Other sessions and subagents go untouched.
        assert_eq!(hook(HookEvent::PreTool, "other", false, false), None);
        assert_eq!(hook(HookEvent::Stop, "main", true, false), None);
        assert!(seen.lock().unwrap().is_empty());

        *input.lock().unwrap() = json!([{"token": 4, "text": "check the build"}]);
        let refused = hook(HookEvent::PreTool, "main", false, false).unwrap();
        assert!(refused.contains("[4] check the build"));
        assert!(refused.ends_with("berd-call speak --re 4 'REPLY'"));
        // The agent can always answer.
        assert_eq!(hook(HookEvent::PreTool, "main", false, true), None);
        assert!(hook(HookEvent::Stop, "main", false, false)
            .unwrap()
            .contains("[4] check the build"));

        *input.lock().unwrap() = json!([]);
        assert_eq!(
            hook(HookEvent::Stop, "main", false, false).as_deref(),
            Some(Reply { relays: false, port: 5222 }.unspoken().as_str())
        );
        control
            .speak("Done.".into(), Some(4), Vec::new(), None, None, false)
            .unwrap();
        // Nothing delivers the transcript, so the agent waits for input.
        assert_eq!(
            hook(HookEvent::Stop, "main", false, false).as_deref(),
            Some(UNHEARD)
        );
        assert_eq!(hook(HookEvent::PermissionRequest, "main", false, false), None);
        drop(control);
        worker.join().unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            [
                "Working",
                "Done.",
                "Waiting",
                "Waiting",
                "I need you to review a permission request.",
            ]
        );
    }

    #[test]
    fn stop_is_recorded_even_when_the_session_never_reads_it() {
        let (commands, receiver) = mpsc::sync_channel(1);
        let stop_requested = Arc::new(AtomicBool::new(false));
        let control = SessionControl {
            commands,
            running: Arc::new(AtomicBool::new(false)),
            ready: ReadyState {
                session: Arc::new(Mutex::new(test_snapshot())),
            },
            non_blocking: Arc::new(AtomicBool::new(false)),
            stop_requested: Arc::clone(&stop_requested),
            muted: Arc::new(AtomicBool::new(false)),
            status_sounds: Arc::default(),
            transcript: Arc::new(Transcript::Silent),
            speaks: true,
            session_arguments: vec!["session".into()],
            hooks: Arc::new(HookBinding::new(None, 5222)),
        };
        drop(receiver);
        assert_eq!(control.stop().unwrap(), json!({"stopping":true}));
        assert!(stop_requested.load(Ordering::SeqCst));
    }

    #[test]
    fn turning_the_spokesperson_on_restarts_the_call_with_the_agents_current_voice() {
        let toggle = |transcript, rate| {
            let mut snapshot = test_snapshot();
            snapshot.tts.settings = snapshot.tts.settings.with_rate(rate);
            let (commands, receiver) = mpsc::sync_channel(1);
            let control = SessionControl {
                commands,
                running: Arc::new(AtomicBool::new(true)),
                ready: ReadyState {
                    session: Arc::new(Mutex::new(snapshot)),
                },
                non_blocking: Arc::new(AtomicBool::new(false)),
                stop_requested: Arc::new(AtomicBool::new(false)),
                muted: Arc::new(AtomicBool::new(false)),
                status_sounds: Arc::default(),
                transcript: Arc::new(transcript),
                speaks: true,
                session_arguments: [
                    "session",
                    "--voice",
                    "Samantha",
                    "--language",
                    "en-GB",
                    "--rate",
                    "2",
                    "--stt-backend",
                    "openai",
                    "--stt-url",
                    "ws://127.0.0.1:1/stt",
                ]
                .map(str::to_string)
                .to_vec(),
                hooks: Arc::new(HookBinding::new(None, 5222)),
            };
            let worker = thread::spawn(move || match receiver.recv().unwrap() {
                ControlCommand::Restart {
                    arguments,
                    expert_spokesperson,
                    tts,
                    response,
                } => {
                    response.send(Ok(json!({}))).unwrap();
                    assert!(expert_spokesperson);
                    (arguments, tts)
                }
                _ => panic!("expected a restart"),
            });
            control.set_spokesperson_mode(true).unwrap();
            worker.join().unwrap()
        };
        // Agents with their own voice keep the one they have now.
        let (arguments, tts) = toggle(Transcript::Stdout { live: true }, 1.25);
        assert_eq!(
            arguments,
            [
                "session",
                "--stt-backend",
                "openai",
                "--tts-backend",
                "siri",
                "--rate",
                "1.25",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
                "--mode",
                "expert-spokesperson",
                crate::DIRECT_AGENT_SPEECH,
            ]
        );
        assert_eq!(tts, Some(test_snapshot().tts.settings.with_rate(1.25)));
        // Otherwise only their speed carries over, which the Spokesperson keeps as close to as it can.
        let (arguments, tts) = toggle(Transcript::Silent, 1.75);
        assert_eq!(
            arguments,
            [
                "session",
                "--voice",
                "Samantha",
                "--language",
                "en-GB",
                "--stt-backend",
                "openai",
                "--rate",
                "1.75",
                "--mode",
                "expert-spokesperson",
            ]
        );
        assert_eq!(tts, None);
        assert!(crate::validate_session_arguments(&arguments).unwrap());
    }

    #[test]
    fn turning_the_spokesperson_off_drops_direct_speech_wherever_it_was_given() {
        let (commands, receiver) = mpsc::sync_channel(1);
        let control = SessionControl {
            commands,
            running: Arc::new(AtomicBool::new(true)),
            ready: ReadyState {
                session: Arc::new(Mutex::new(test_snapshot())),
            },
            non_blocking: Arc::new(AtomicBool::new(false)),
            stop_requested: Arc::new(AtomicBool::new(false)),
            muted: Arc::new(AtomicBool::new(false)),
            status_sounds: Arc::default(),
            transcript: Arc::new(Transcript::Stdout { live: true }),
            speaks: true,
            session_arguments: [
                "session",
                "--mode",
                "expert-spokesperson",
                crate::DIRECT_AGENT_SPEECH,
                "--voice",
                "Samantha",
                "--language",
                "en-GB",
            ]
            .map(str::to_string)
            .to_vec(),
            hooks: Arc::new(HookBinding::new(None, 5222)),
        };
        let worker = thread::spawn(move || match receiver.recv().unwrap() {
            ControlCommand::Restart {
                arguments,
                expert_spokesperson,
                response,
                ..
            } => {
                response.send(Ok(json!({}))).unwrap();
                assert!(!expert_spokesperson);
                arguments
            }
            _ => panic!("expected a restart"),
        });
        control.set_spokesperson_mode(false).unwrap();
        assert_eq!(
            worker.join().unwrap(),
            [
                "session",
                "--tts-backend",
                "siri",
                "--rate",
                "1",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
                "--mode",
                "conventional",
            ]
        );
    }

    #[test]
    fn the_expert_speaks_only_through_the_spokesperson_unless_allowed() {
        let (commands, receiver) = mpsc::sync_channel(1);
        let control = SessionControl {
            commands,
            running: Arc::new(AtomicBool::new(true)),
            ready: ReadyState {
                session: Arc::new(Mutex::new(test_snapshot())),
            },
            non_blocking: Arc::new(AtomicBool::new(false)),
            stop_requested: Arc::new(AtomicBool::new(false)),
            muted: Arc::new(AtomicBool::new(false)),
            status_sounds: Arc::default(),
            transcript: Arc::new(Transcript::Silent),
            speaks: false,
            session_arguments: vec!["session".into()],
            hooks: Arc::new(HookBinding::new(None, 5222)),
        };
        let refusal = control
            .speak("Hello".into(), None, Vec::new(), None, None, false)
            .unwrap_err();
        assert!(refusal.contains("message-spokesperson"), "{refusal}");
        assert!(receiver.try_recv().is_err());
        let worker = thread::spawn(move || match receiver.recv().unwrap() {
            ControlCommand::Speak {
                relay, response, ..
            } => {
                response.send(Ok(json!({}))).unwrap();
                relay
            }
            _ => panic!("expected a message to the Spokesperson"),
        });
        control
            .speak("Hello".into(), None, Vec::new(), None, None, true)
            .unwrap();
        assert!(worker.join().unwrap());
    }

    #[test]
    fn voice_updates_preserve_the_latest_rate_and_revision() {
        let (commands, receiver) = mpsc::sync_channel(1);
        let mut snapshot = test_snapshot();
        snapshot.tts.settings = snapshot.tts.settings.with_rate(1.5);
        let control = SessionControl {
            commands,
            running: Arc::new(AtomicBool::new(true)),
            ready: ReadyState {
                session: Arc::new(Mutex::new(snapshot)),
            },
            non_blocking: Arc::new(AtomicBool::new(false)),
            stop_requested: Arc::new(AtomicBool::new(false)),
            muted: Arc::new(AtomicBool::new(false)),
            status_sounds: Arc::default(),
            transcript: Arc::new(Transcript::Silent),
            speaks: true,
            session_arguments: vec!["session".into()],
            hooks: Arc::new(HookBinding::new(None, 5222)),
        };
        let worker = thread::spawn(move || match receiver.recv().unwrap() {
            ControlCommand::TtsSettings {
                settings,
                expected_revision,
                response,
            } => {
                response.send(Ok(json!({}))).unwrap();
                (settings, expected_revision)
            }
            _ => panic!("expected a settings update without a restart"),
        });
        control
            .set_voice("Daniel".into(), Some("en-GB".into()))
            .unwrap();
        assert_eq!(
            worker.join().unwrap(),
            (
                berd_call::TtsSettings::Siri {
                    voice: "Daniel".into(),
                    language: "en-GB".into(),
                    rate: 1.5,
                },
                1
            )
        );
    }

    #[test]
    fn rate_updates_keep_the_current_voice_and_revision() {
        let (commands, receiver) = mpsc::sync_channel(1);
        let control = SessionControl {
            commands,
            running: Arc::new(AtomicBool::new(true)),
            ready: ReadyState {
                session: Arc::new(Mutex::new(test_snapshot())),
            },
            non_blocking: Arc::new(AtomicBool::new(false)),
            stop_requested: Arc::new(AtomicBool::new(false)),
            muted: Arc::new(AtomicBool::new(false)),
            status_sounds: Arc::default(),
            transcript: Arc::new(Transcript::Silent),
            speaks: true,
            session_arguments: vec!["session".into()],
            hooks: Arc::new(HookBinding::new(None, 5222)),
        };
        let worker = thread::spawn(move || match receiver.recv().unwrap() {
            ControlCommand::TtsSettings {
                settings,
                expected_revision,
                response,
            } => {
                response.send(Ok(json!({}))).unwrap();
                (settings, expected_revision)
            }
            _ => panic!("expected a TTS settings command"),
        });
        control.set_rate(1.5).unwrap();
        assert_eq!(
            worker.join().unwrap(),
            (
                berd_call::TtsSettings::Siri {
                    voice: "Aaron".into(),
                    language: "en-US".into(),
                    rate: 1.5,
                },
                1
            )
        );
    }

    #[test]
    fn spokesperson_updates_keep_its_other_setting_and_revision() {
        let (commands, receiver) = mpsc::sync_channel(1);
        let mut snapshot = test_snapshot();
        let openai = |voice: &str, rate| berd_call::TtsSettings::OpenAi {
            model: "gpt-realtime".into(),
            voice: voice.into(),
            rate,
        };
        let session = Arc::new(Mutex::new(snapshot.clone()));
        let control = SessionControl {
            commands,
            running: Arc::new(AtomicBool::new(true)),
            ready: ReadyState {
                session: Arc::clone(&session),
            },
            non_blocking: Arc::new(AtomicBool::new(false)),
            stop_requested: Arc::new(AtomicBool::new(false)),
            muted: Arc::new(AtomicBool::new(false)),
            status_sounds: Arc::default(),
            transcript: Arc::new(Transcript::Silent),
            speaks: true,
            session_arguments: vec!["session".into()],
            hooks: Arc::new(HookBinding::new(None, 5222)),
        };
        let refusal = control.set_spokesperson(None, Some(1.5)).unwrap_err();
        assert!(
            refusal.contains("no separate Spokesperson voice"),
            "{refusal}"
        );
        snapshot.spokesperson = Some(berd_call::TtsConfigurationSnapshot {
            revision: 3,
            settings: openai("marin", 1.25),
        });
        *session.lock().unwrap() = snapshot;
        let worker = thread::spawn(move || {
            (0..2)
                .map(|_| match receiver.recv().unwrap() {
                    ControlCommand::SpokespersonSettings {
                        settings,
                        expected_revision,
                        response,
                    } => {
                        response.send(Ok(json!({}))).unwrap();
                        (settings, expected_revision)
                    }
                    _ => panic!("expected a Spokesperson settings command"),
                })
                .collect::<Vec<_>>()
        });
        control.set_spokesperson(None, Some(1.5)).unwrap();
        control
            .set_spokesperson(Some("cedar".into()), None)
            .unwrap();
        assert_eq!(
            worker.join().unwrap(),
            [(openai("marin", 1.5), 3), (openai("cedar", 1.25), 3)]
        );
    }

    #[test]
    fn the_speech_rate_keeps_the_spokesperson_as_close_to_the_agents_as_it_can() {
        let rates = |spokesperson, outcome: &'static str, spokesperson_outcome: &'static str| {
            let (commands, receiver) = mpsc::sync_channel(1);
            let mut snapshot = test_snapshot();
            snapshot.spokesperson = spokesperson;
            let control = SessionControl {
                commands,
                running: Arc::new(AtomicBool::new(true)),
                ready: ReadyState {
                    session: Arc::new(Mutex::new(snapshot)),
                },
                non_blocking: Arc::new(AtomicBool::new(false)),
                stop_requested: Arc::new(AtomicBool::new(false)),
                muted: Arc::new(AtomicBool::new(false)),
                status_sounds: Arc::default(),
                transcript: Arc::new(Transcript::Silent),
                speaks: true,
                session_arguments: vec!["session".into()],
                hooks: Arc::new(HookBinding::new(None, 5222)),
            };
            let worker = thread::spawn(move || {
                receiver
                    .iter()
                    .map(|command| match command {
                        ControlCommand::TtsSettings {
                            settings, response, ..
                        } => {
                            response
                                .send(Ok(json!({"outcome": outcome, "snapshot": {"revision": 2}})))
                                .unwrap();
                            ("agents", settings.rate())
                        }
                        ControlCommand::SpokespersonSettings {
                            settings, response, ..
                        } => {
                            response
                                .send(Ok(json!({"outcome": spokesperson_outcome})))
                                .unwrap();
                            ("spokesperson", settings.rate())
                        }
                        _ => panic!("expected a speech settings command"),
                    })
                    .collect::<Vec<_>>()
            });
            control.set_rate(2.0).unwrap();
            drop(control);
            worker.join().unwrap()
        };
        let spokesperson = berd_call::TtsConfigurationSnapshot {
            revision: 3,
            settings: berd_call::TtsSettings::OpenAi {
                model: "gpt-realtime".into(),
                voice: "marin".into(),
                rate: 1.0,
            },
        };
        assert_eq!(
            rates(Some(spokesperson.clone()), "applied", "applied"),
            [("agents", 2.0), ("spokesperson", 1.5)]
        );
        // A Spokesperson that refuses its speed puts the agents' back.
        assert_eq!(
            rates(Some(spokesperson.clone()), "applied", "rejected"),
            [("agents", 2.0), ("spokesperson", 1.5), ("agents", 1.0)]
        );
        assert_eq!(
            rates(Some(spokesperson), "rejected", "applied"),
            [("agents", 2.0)]
        );
        assert_eq!(rates(None, "applied", "applied"), [("agents", 2.0)]);
    }

    #[test]
    fn stop_cancels_a_pending_restart() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (_commands_tx, commands) = mpsc::sync_channel(1);
        let (audio_commands, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio_commands);
        let (restart_tx, restart_rx) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::Restart {
                arguments: vec!["session".into()],
                expert_spokesperson: false,
                tts: None,
                response: restart_tx,
            })
            .unwrap();
        let (stop_tx, stop_rx) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::Stop { response: stop_tx })
            .unwrap();
        assert!(actor.restart.is_none());
        assert!(restart_rx.recv().unwrap().is_err());
        assert!(stop_rx.recv().unwrap().is_ok());
        let (late_tx, late_rx) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::Restart {
                arguments: vec!["session".into()],
                expert_spokesperson: false,
                tts: None,
                response: late_tx,
            })
            .unwrap();
        assert!(actor.restart.is_none());
        assert!(late_rx.recv().unwrap().is_err());
        drop(actor);
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn non_blocking_delivery_assumes_success_but_reports_actionable_results() {
        assert!(!should_notify_delivery(
            &json!({"spoke":true,"status":"completed"})
        ));
        assert!(should_notify_delivery(
            &json!({"spoke":true,"status":"interrupted"})
        ));
        assert!(should_notify_delivery(
            &json!({"status":"failed","message":"output failed"})
        ));
        assert!(should_notify_delivery(
            &json!({"spoke":false,"utterances":[{"token":2,"text":"stop"}]})
        ));
    }

    #[test]
    fn estimated_speech_uses_utf8_bytes_without_splitting_characters() {
        assert_eq!(estimated_spoken_text("Hi, René!", 0), "");
        assert_eq!(estimated_spoken_text("Hi, René!", 8), "Hi, Ren");
        assert_eq!(estimated_spoken_text("Hi, René!", 9), "Hi, René");
        assert_eq!(estimated_spoken_text("Hi, René!", u64::MAX), "Hi, René!");
    }

    #[test]
    fn input_normalizer_emits_exact_twenty_millisecond_frames() {
        let mut normalizer = InputNormalizer::new(48_000, 2);
        let samples =
            (0..INPUT_FRAME_SAMPLES * 2 + 2).map(|index| if index % 2 == 0 { 0.25 } else { 0.75 });
        let frames = normalizer.push(samples);
        assert_eq!(frames.len(), 1);
        assert!(frames[0]
            .iter()
            .all(|sample| (*sample - 0.5).abs() < f32::EPSILON));
    }

    #[test]
    fn input_normalizer_resamples_and_keeps_partial_frames() {
        let mut normalizer = InputNormalizer::new(24_000, 1);
        let first = normalizer.push((0..480).map(|_| 0.2));
        assert!(first.is_empty());
        let second = normalizer.push((0..2).map(|_| 0.2));
        assert_eq!(second.len(), 1);
        assert!(second[0]
            .iter()
            .all(|sample| (*sample - 0.2).abs() < 0.0001));
    }

    #[test]
    fn audio_ingress_reads_past_one_chunk_and_retains_partial_records() {
        struct Available(std::io::Cursor<Vec<u8>>);
        impl Read for Available {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                match self.0.read(bytes) {
                    Ok(0) => Err(std::io::ErrorKind::WouldBlock.into()),
                    result => result,
                }
            }
        }
        let mut record = Vec::new();
        record.extend_from_slice(&AUDIO_FRAME_MAGIC);
        record.extend_from_slice(&[AUDIO_FRAME_MARKER, AUDIO_CHUNK_KIND]);
        record.extend_from_slice(&9000_u32.to_le_bytes());
        record.extend_from_slice(&vec![0; 9000]);
        let mut ingress = record.clone();
        ingress.extend_from_slice(&record[..5]);
        let mut audio = Available(std::io::Cursor::new(ingress.clone()));
        let mut bytes = Vec::new();
        assert!(read_available_audio(&mut audio, &mut bytes).unwrap());
        assert_eq!(
            bytes, ingress,
            "a drain must inspect more than one read buffer"
        );
        assert_eq!(
            take_audio_record(&mut bytes).unwrap().unwrap().1.len(),
            9000
        );
        assert!(take_audio_record(&mut bytes).unwrap().is_none());
        assert_eq!(bytes, record[..5]);
        audio.0.get_mut().extend_from_slice(&record[5..]);
        assert!(read_available_audio(&mut audio, &mut bytes).unwrap());
        assert!(take_audio_record(&mut bytes).unwrap().is_some());
        assert!(bytes.is_empty());
    }

    #[test]
    fn audio_decoder_waits_for_complete_records() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&AUDIO_FRAME_MAGIC);
        bytes.push(AUDIO_FRAME_MARKER);
        bytes.push(AUDIO_CANCEL_KIND);
        bytes.extend_from_slice(&8_u32.to_le_bytes());
        bytes.extend_from_slice(&7_u64.to_le_bytes());
        let tail = bytes.split_off(5);
        assert_eq!(take_audio_record(&mut bytes).unwrap(), None);
        bytes.extend_from_slice(&tail);
        assert_eq!(
            take_audio_record(&mut bytes).unwrap(),
            Some((AUDIO_CANCEL_KIND, 7_u64.to_le_bytes().to_vec()))
        );
    }

    #[test]
    fn drained_audio_retains_progress_for_late_suspend_and_resume() {
        let playback = AudioPlaybackState::Finished(RetiredAudio {
            speech_id: 17,
            played_frames: 48_000,
        });
        assert_eq!(playback.played_frames(17), 48_000);
        assert_eq!(playback.played_frames(18), 0);
    }

    #[test]
    fn only_the_ended_speech_is_retired() {
        let playback = AudioPlaybackState::Finished(RetiredAudio {
            speech_id: 17,
            played_frames: 4_096,
        });
        assert_eq!(playback.retired(17), Some(4_096));
        assert_eq!(playback.retired(18), None);
        assert_eq!(AudioPlaybackState::Idle.retired(17), None);
    }

    #[test]
    fn suspension_settle_time_preserves_route_safety_duration() {
        assert_eq!(
            suspension_settle_time(Duration::from_secs(2)),
            Duration::from_secs(2)
        );
        assert_eq!(
            suspension_settle_time(Duration::from_millis(100)),
            Duration::from_millis(100)
        );
    }
}
