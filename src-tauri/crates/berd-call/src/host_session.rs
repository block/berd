#![cfg(target_os = "macos")]

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
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
use crate::host_control::{ControlServer, HostControl};
use crate::session_audio::{
    AUDIO_BEGIN_KIND, AUDIO_CANCEL_KIND, AUDIO_CHUNK_KIND, AUDIO_END_KIND,
    AUDIO_FRAME_HEADER_BYTES, AUDIO_FRAME_MAGIC, AUDIO_FRAME_MARKER,
};
use crate::session_framing::{
    encode_frame, JSON_FRAME_KIND, PCM_FRAME_KIND, SESSION_PROTOCOL_VERSION,
};
use crate::StartOptions;

const NON_BLOCKING_REQUIRES_DELIVERY: &str =
    "non-blocking speech requires start --stream or --codex for delivery events";
const INPUT_FRAME_SAMPLES: usize = 960;
const MAX_AUDIO_RECORD_BYTES: usize = 4096 * std::mem::size_of::<f32>() + 16;

pub(crate) fn run(options: StartOptions) -> Result<(), String> {
    let server = ControlServer::bind(options.port)?;
    let transcript = Arc::new(Transcript::for_options(&options)?);
    transcript.start()?;
    let non_blocking = Arc::new(AtomicBool::new(options.non_blocking));
    let mut session = SessionStart {
        arguments: options.session_arguments,
        expert_spokesperson: options.expert_spokesperson,
        muted: false,
        input_during_tts: default_input_during_tts_policy(),
        restarted: None,
    };
    loop {
        match run_session(&server, session, &transcript, &non_blocking) {
            Ok(None) => {
                transcript.finish(
                    "Berd Call stopped after a stop request. This is a clean shutdown, not a crash. Do not restart it unless asked.",
                );
                return Ok(());
            }
            Ok(Some(next)) => {
                transcript.record(
                    Some(0),
                    "lifecycle",
                    None,
                    "session restarted; transcript cursors reset",
                )?;
                session = next;
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
    Stdout,
    Codex(CodexRelay),
}

impl Transcript {
    fn for_options(options: &StartOptions) -> Result<Self, String> {
        if options.codex {
            let target = CodexTarget::from_environment()?;
            let executable = std::env::current_exe()
                .map_err(|error| format!("could not resolve the berd-call executable: {error}"))?;
            return Ok(Self::Codex(CodexRelay::start(
                target,
                codex::guidance(&executable, options.port),
            )));
        }
        Ok(if options.stream {
            Self::Stdout
        } else {
            Self::Silent
        })
    }

    /// Whether interruption and failure reports reach the agent.
    fn delivers(&self) -> bool {
        !matches!(self, Self::Silent)
    }

    fn start(&self) -> Result<(), String> {
        match self {
            Self::Stdout => print_flushed("cursor\trole\ttext"),
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
            Self::Stdout => print_flushed(&format!(
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

    fn finish(&self, text: &str) {
        if let Self::Codex(relay) = self {
            relay.finish(Some(CodexRecord {
                cursor: None,
                role: "lifecycle".into(),
                handoff_id: None,
                text: text.to_string(),
            }));
        }
    }
}

fn print_flushed(line: &str) -> Result<(), String> {
    println!("{line}");
    std::io::stdout()
        .flush()
        .map_err(|error| format!("could not flush voice stream: {error}"))
}

struct SessionStart {
    arguments: Vec<String>,
    expert_spokesperson: bool,
    muted: bool,
    input_during_tts: InputDuringTtsPolicy,
    restarted: Option<SyncSender<Result<Value, String>>>,
}

fn run_session(
    server: &ControlServer,
    start: SessionStart,
    transcript: &Arc<Transcript>,
    non_blocking: &Arc<AtomicBool>,
) -> Result<Option<SessionStart>, String> {
    let SessionStart {
        arguments,
        expert_spokesperson,
        muted,
        input_during_tts,
        restarted,
    } = start;
    let started = start_session(
        arguments,
        expert_spokesperson,
        muted,
        input_during_tts,
        transcript,
        non_blocking,
    );
    let StartedSession {
        mut child,
        mut actor,
        control,
        capture,
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
        let _ = response.send(control.status());
    }
    let session_control = Arc::clone(&control);
    let control: Arc<dyn HostControl> = control;
    while running.load(Ordering::SeqCst) {
        server.poll(Arc::clone(&control))?;
        actor.poll()?;
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
    actor.close_commands()?;
    let restart = actor.restart.take();
    actor.finish_pending(if restart.is_some() {
        "voice session restarted"
    } else {
        "voice call stopped"
    });
    Ok(restart.map(|restart| SessionStart {
        arguments: restart.arguments,
        expert_spokesperson: restart.expert_spokesperson,
        muted: session_control.muted.load(Ordering::SeqCst),
        input_during_tts: session_control
            .ready
            .session
            .lock()
            .map(|session| session.input_during_tts.policy)
            .unwrap_or(input_during_tts),
        restarted: Some(restart.response),
    }))
}

struct StartedSession {
    child: SessionProcess,
    actor: SessionActor,
    control: Arc<SessionControl>,
    capture: InputCapture,
    failure_rx: Receiver<String>,
    running: Arc<AtomicBool>,
}

fn start_session(
    arguments: Vec<String>,
    expert_spokesperson: bool,
    muted: bool,
    input_during_tts: InputDuringTtsPolicy,
    transcript: &Arc<Transcript>,
    non_blocking: &Arc<AtomicBool>,
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
    let ready = receive_ready(&event_rx)?;
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
    if muted {
        // Requests and captured PCM share one ordered pipe, so the replacement
        // session is muted before it can receive any microphone input.
        let id = actor.next_id();
        send_request(&writer, &SessionRequest::SetInputMuted { id, active: true })?;
    }
    let capture = InputCapture::start(writer, failure_tx)?;
    let control = Arc::new(SessionControl {
        commands: command_tx,
        running: Arc::clone(&running),
        ready: ready.clone(),
        non_blocking: Arc::clone(non_blocking),
        muted: AtomicBool::new(muted),
        transcript: Arc::clone(transcript),
        session_arguments: arguments,
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
    if berd_call::macos_audio_route::output_device_is_builtin_speaker(None) {
        InputDuringTtsPolicy::SuppressInput
    } else {
        InputDuringTtsPolicy::AllowBargeIn
    }
}

#[derive(Clone)]
struct ReadyState {
    session: Arc<Mutex<VoiceSessionSnapshot>>,
}

enum ControlCommand {
    InputDuringTts {
        policy: InputDuringTtsPolicy,
        expected_revision: u64,
        response: SyncSender<Result<Value, String>>,
    },
    Muted {
        muted: bool,
        response: SyncSender<Result<Value, String>>,
    },
    TtsSettings {
        settings: berd_call::TtsSettings,
        expected_revision: u64,
        response: SyncSender<Result<Value, String>>,
    },
    Speak {
        text: String,
        acknowledgement: Option<u64>,
        resolved_handoff_ids: Vec<String>,
        non_blocking: bool,
        response: SyncSender<Result<Value, String>>,
    },
    Stop {
        response: SyncSender<Result<Value, String>>,
    },
    Restart {
        arguments: Vec<String>,
        expert_spokesperson: bool,
        response: SyncSender<Result<Value, String>>,
    },
}

impl ControlCommand {
    fn response(self) -> SyncSender<Result<Value, String>> {
        match self {
            Self::InputDuringTts { response, .. }
            | Self::Muted { response, .. }
            | Self::TtsSettings { response, .. }
            | Self::Speak { response, .. }
            | Self::Stop { response }
            | Self::Restart { response, .. } => response,
        }
    }
}

struct PendingRestart {
    arguments: Vec<String>,
    expert_spokesperson: bool,
    response: SyncSender<Result<Value, String>>,
}

struct SessionControl {
    commands: SyncSender<ControlCommand>,
    running: Arc<AtomicBool>,
    ready: ReadyState,
    non_blocking: Arc<AtomicBool>,
    muted: AtomicBool,
    transcript: Arc<Transcript>,
    session_arguments: Vec<String>,
}

impl SessionControl {
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
        self.muted.store(muted, Ordering::SeqCst);
        self.status()
    }

    fn restart(&self, session_arguments: Vec<String>) -> Result<Value, String> {
        let expert_spokesperson = crate::validate_session_arguments(&session_arguments)?;
        let (response, result) = mpsc::sync_channel(1);
        self.commands
            .send(ControlCommand::Restart {
                arguments: session_arguments,
                expert_spokesperson,
                response,
            })
            .map_err(|_| "voice call is not running")?;
        result
            .recv()
            .map_err(|_| "voice call stopped during restart".to_string())?
    }

    fn set_non_blocking(&self, enabled: bool) -> Result<Value, String> {
        if enabled && !self.transcript.delivers() {
            return Err(NON_BLOCKING_REQUIRES_DELIVERY.into());
        }
        self.non_blocking.store(enabled, Ordering::SeqCst);
        self.status()
    }

    fn status(&self) -> Result<Value, String> {
        Ok(json!({
            "running": self.running.load(Ordering::SeqCst),
            "session": *self.ready.session.lock().map_err(|_| "session settings lock failed")?,
            "nonBlocking": self.non_blocking.load(Ordering::SeqCst),
            "muted": self.muted.load(Ordering::SeqCst),
            "sessionArguments": &self.session_arguments[1..],
        }))
    }

    fn speak(
        &self,
        text: String,
        acknowledgement: Option<u64>,
        resolved_handoff_ids: Vec<String>,
    ) -> Result<Value, String> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.commands
            .send(ControlCommand::Speak {
                text,
                acknowledgement,
                resolved_handoff_ids,
                non_blocking: self.non_blocking.load(Ordering::SeqCst),
                response: tx,
            })
            .map_err(|_| "voice call is not running".to_string())?;
        rx.recv()
            .map_err(|_| "voice call stopped before speech completed".to_string())?
    }

    fn stop(&self) -> Result<Value, String> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.commands
            .send(ControlCommand::Stop { response: tx })
            .map_err(|_| "voice call is not running".to_string())?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "timed out stopping voice call".to_string())?
    }
}

struct PendingSpeak {
    prepare_id: u64,
    text: String,
    non_blocking: bool,
    response: Option<SyncSender<Result<Value, String>>>,
}

enum AudioCommand {
    Suspend(u64),
    Resume(u64),
}

struct SessionActor {
    writer: Arc<Mutex<ChildStdin>>,
    events: Receiver<SessionMessage>,
    commands: Receiver<ControlCommand>,
    audio_commands: SyncSender<AudioCommand>,
    next_id: u64,
    pending_speak: Option<PendingSpeak>,
    pending_settings: std::collections::HashMap<u64, SyncSender<Result<Value, String>>>,
    waiting_speaks: VecDeque<ControlCommand>,
    session: Arc<Mutex<VoiceSessionSnapshot>>,
    transcript: Arc<Transcript>,
    expert_spokesperson: bool,
    stopping: bool,
    restart: Option<PendingRestart>,
}

impl SessionActor {
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
            writer,
            events,
            commands,
            audio_commands,
            next_id: 2,
            pending_speak: None,
            pending_settings: std::collections::HashMap::new(),
            waiting_speaks: VecDeque::new(),
            session,
            transcript,
            expert_spokesperson,
            stopping: false,
            restart: None,
        }
    }

    fn poll(&mut self) -> Result<(), String> {
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
        if !self.stopping && self.pending_speak.is_none() {
            if let Some(command) = self.waiting_speaks.pop_front() {
                self.handle_command(command)?;
            }
        }
        Ok(())
    }

    /// Answers commands that arrived after the session loop stopped polling,
    /// so a stop during a restart handoff cancels the restart instead of
    /// waiting on a session that will never read it.
    fn close_commands(&mut self) -> Result<(), String> {
        let (_, closed) = mpsc::sync_channel(0);
        let commands = std::mem::replace(&mut self.commands, closed);
        while let Ok(command) = commands.try_recv() {
            match command {
                ControlCommand::Stop { .. } => self.handle_command(command)?,
                command => {
                    let _ = command
                        .response()
                        .send(Err("voice call is stopping".into()));
                }
            }
        }
        Ok(())
    }

    fn handle_command(&mut self, command: ControlCommand) -> Result<(), String> {
        match command {
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
                let id = self.next_id();
                send_request(
                    &self.writer,
                    &SessionRequest::SetInputMuted { id, active: muted },
                )?;
                self.pending_settings.insert(id, response);
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
            ControlCommand::Speak {
                text,
                acknowledgement,
                resolved_handoff_ids,
                non_blocking,
                response,
            } => {
                if non_blocking && !self.transcript.delivers() {
                    let _ = response.send(Err(NON_BLOCKING_REQUIRES_DELIVERY.into()));
                    return Ok(());
                }
                if self.pending_speak.is_some() {
                    self.waiting_speaks.push_back(ControlCommand::Speak {
                        text,
                        acknowledgement,
                        resolved_handoff_ids,
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
                response,
            } => {
                if self.stopping {
                    let _ = response.send(Err("voice call is stopping".into()));
                    return Ok(());
                }
                send_request(&self.writer, &SessionRequest::Shutdown)?;
                self.stopping = true;
                self.restart = Some(PendingRestart {
                    arguments,
                    expert_spokesperson,
                    response,
                });
            }
            ControlCommand::Stop { response } => {
                if let Some(restart) = self.restart.take() {
                    let _ = restart.response.send(Err("voice call stopped".into()));
                }
                if !self.stopping {
                    send_request(&self.writer, &SessionRequest::Shutdown)?;
                    self.stopping = true;
                }
                let _ = response.send(Ok(json!({"stopping":true})));
            }
        }
        Ok(())
    }

    fn handle_event(&mut self, event: SessionMessage) -> Result<(), String> {
        match event {
            SessionMessage::TtsSettingsResult {
                id,
                outcome,
                snapshot,
                message,
            } => {
                if let Ok(mut session) = self.session.lock() {
                    if snapshot.revision >= session.tts.revision {
                        session.tts = snapshot.clone();
                    }
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
                if let Some(response) = self.pending_settings.remove(&id) {
                    let _ = response.send(Ok(json!({"outcome":outcome,"snapshot":snapshot})));
                }
            }
            SessionMessage::InputMuteApplied { id, active } => {
                if let Some(response) = self.pending_settings.remove(&id) {
                    let _ = response.send(Ok(json!({"muted":active})));
                }
            }
            SessionMessage::LiveEvent {
                token,
                text,
                origin,
            } if !self.expert_spokesperson => self.stream_live_event(token, origin, &text)?,
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

    fn stream_live_event(
        &self,
        token: u64,
        origin: Option<UtteranceOrigin>,
        text: &str,
    ) -> Result<(), String> {
        let role = utterance_origin_name(origin.unwrap_or(UtteranceOrigin::User));
        self.transcript.record(Some(token), role, None, text)
    }

    fn stream_expert_delivery(&self, events: &[RealtimeExpertDeliveryEvent]) -> Result<(), String> {
        for event in events {
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
        for (_, response) in self.pending_settings.drain() {
            let _ = response.send(Err(message.to_string()));
        }
        self.respond_speak(Err(message.to_string()));
        for command in self.waiting_speaks.drain(..) {
            if let ControlCommand::Speak { response, .. } = command {
                let _ = response.send(Err(message.to_string()));
            }
        }
    }
}

fn receive_ready(events: &Receiver<SessionMessage>) -> Result<ReadyState, String> {
    let event = events
        .recv_timeout(Duration::from_secs(60))
        .map_err(|error| {
            match error {
                mpsc::RecvTimeoutError::Timeout => "timed out waiting for voice session startup",
                mpsc::RecvTimeoutError::Disconnected => {
                    "voice session event stream closed during startup"
                }
            }
            .to_string()
        })?;
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
        let mut command = Command::new(executable);
        command
            .args(arguments)
            .arg("--pcm-output-fd")
            .arg(write_fd.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        unsafe {
            command.pre_exec(move || {
                libc::close(read_fd);
                let flags = libc::fcntl(write_fd, libc::F_GETFD);
                if flags < 0 || libc::fcntl(write_fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let result = command.spawn();
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

fn send_pcm(writer: &Arc<Mutex<ChildStdin>>, samples: &[f32]) -> Result<(), String> {
    let mut payload = Vec::with_capacity(samples.len() * 4);
    for sample in samples {
        payload.extend_from_slice(&sample.to_le_bytes());
    }
    write_frame(writer, PCM_FRAME_KIND, &payload)
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

struct InputCapture {
    _stream: cpal::Stream,
}

impl InputCapture {
    fn start(writer: Arc<Mutex<ChildStdin>>, failures: SyncSender<String>) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "no default microphone is available".to_string())?;
        let supported = device
            .default_input_config()
            .map_err(|error| format!("could not inspect the default microphone: {error}"))?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let channels = usize::from(config.channels);
        let sample_rate = config.sample_rate;
        let (frames_tx, frames_rx) = mpsc::sync_channel::<[f32; INPUT_FRAME_SAMPLES]>(32);
        let writer_failures = failures.clone();
        thread::Builder::new()
            .name("berd-call-microphone-writer".into())
            .spawn(move || {
                while let Ok(frame) = frames_rx.recv() {
                    if let Err(message) = send_pcm(&writer, &frame) {
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
                    sample_rate,
                    channels,
                    frames_tx.clone(),
                    failures.clone(),
                    |sample: f32| sample,
                ),
                capture_error(failures.clone()),
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config,
                capture_callback(
                    sample_rate,
                    channels,
                    frames_tx.clone(),
                    failures.clone(),
                    |sample: i16| f32::from(sample) / f32::from(i16::MAX),
                ),
                capture_error(failures.clone()),
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config,
                capture_callback(
                    sample_rate,
                    channels,
                    frames_tx,
                    failures.clone(),
                    |sample: u16| (f32::from(sample) / f32::from(u16::MAX)) * 2.0 - 1.0,
                ),
                capture_error(failures),
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
        Ok(Self { _stream: stream })
    }
}

fn capture_callback<T: Copy + Send + 'static>(
    sample_rate: u32,
    channels: usize,
    frames: SyncSender<[f32; INPUT_FRAME_SAMPLES]>,
    failures: SyncSender<String>,
    convert: impl Fn(T) -> f32 + Send + 'static,
) -> impl FnMut(&[T], &cpal::InputCallbackInfo) + Send + 'static {
    let mut normalizer = InputNormalizer::new(sample_rate, channels);
    move |data, _| {
        for frame in normalizer.push(data.iter().copied().map(&convert)) {
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
            let mut pending_suspension: Option<PendingSuspension> = None;
            let suspension_latency = suspension_settle_time(
                berd_call::macos_audio_route::playback_latency_safety_duration(None),
            );
            loop {
                let mut chunk = [0_u8; 8192];
                match audio.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => bytes.extend_from_slice(&chunk[..count]),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        report_failure(&failures, format!("berd-call audio pipe failed: {error}"));
                        return;
                    }
                }
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
                while let Ok(command) = commands.try_recv() {
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
            let active = playback
                .playing_mut(speech_id)
                .ok_or_else(|| "voice session ended inactive audio".to_string())?;
            active.ended_sequence = Some(sequence);
            Ok(())
        }
        AUDIO_CANCEL_KIND if payload.len() == 8 => {
            let speech_id = le_u64(payload)?;
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
    }
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

    fn test_actor(
        writer: Arc<Mutex<ChildStdin>>,
        events: Receiver<SessionMessage>,
        commands: Receiver<ControlCommand>,
        audio_commands: SyncSender<AudioCommand>,
    ) -> SessionActor {
        let session = Arc::new(Mutex::new(VoiceSessionSnapshot {
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
        }));
        SessionActor::new(
            writer,
            events,
            commands,
            audio_commands,
            session,
            Arc::new(Transcript::Stdout),
            false,
        )
    }

    #[test]
    fn stop_queued_during_restart_handoff_cancels_the_restart() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let writer = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let (_events_tx, events) = mpsc::sync_channel(1);
        let (commands_tx, commands) = mpsc::sync_channel(4);
        let (audio_commands, _audio_rx) = mpsc::sync_channel(1);
        let mut actor = test_actor(writer, events, commands, audio_commands);
        let (restart_tx, restart_rx) = mpsc::sync_channel(1);
        actor
            .handle_command(ControlCommand::Restart {
                arguments: vec!["session".into()],
                expert_spokesperson: false,
                response: restart_tx,
            })
            .unwrap();
        let (stop_tx, stop_rx) = mpsc::sync_channel(1);
        let (mute_tx, mute_rx) = mpsc::sync_channel(1);
        commands_tx
            .send(ControlCommand::Muted {
                muted: true,
                response: mute_tx,
            })
            .unwrap();
        commands_tx
            .send(ControlCommand::Stop { response: stop_tx })
            .unwrap();
        actor.close_commands().unwrap();
        assert!(actor.restart.is_none());
        assert!(restart_rx.recv().unwrap().is_err());
        assert!(mute_rx.recv().unwrap().is_err());
        assert!(stop_rx.recv().unwrap().is_ok());
        let (late_tx, _late_rx) = mpsc::sync_channel(1);
        assert!(commands_tx
            .send(ControlCommand::Stop { response: late_tx })
            .is_err());
        drop(actor);
        let _ = child.kill();
        let _ = child.wait();
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
