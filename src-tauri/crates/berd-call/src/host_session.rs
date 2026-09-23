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
use berd_call::protocol::SessionRequest;
use berd_call::PocketAudioPlayer;

use crate::host_control::{ControlServer, HostControl};
use crate::session_audio::{
    AUDIO_BEGIN_KIND, AUDIO_CANCEL_KIND, AUDIO_CHUNK_KIND, AUDIO_END_KIND,
    AUDIO_FRAME_HEADER_BYTES, AUDIO_FRAME_MAGIC, AUDIO_FRAME_MARKER,
};
use crate::session_framing::{
    encode_frame, JSON_FRAME_KIND, PCM_FRAME_KIND, SESSION_PROTOCOL_VERSION,
};
use crate::StartOptions;

const INPUT_FRAME_SAMPLES: usize = 960;
const MAX_AUDIO_RECORD_BYTES: usize = 4096 * std::mem::size_of::<f32>() + 16;

pub(crate) fn run(options: StartOptions) -> Result<(), String> {
    let server = ControlServer::bind(options.port)?;
    let mut child = SessionProcess::spawn(options.session_arguments)?;
    let writer = Arc::new(Mutex::new(child.take_stdin()?));
    let (event_tx, event_rx) = mpsc::sync_channel(128);
    spawn_stdout_reader(child.take_stdout()?, event_tx.clone())?;
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
            input_during_tts: default_input_during_tts_policy(),
            status_sound_output_device: None,
        },
    )?;
    let ready = receive_ready(&event_rx)?;
    let running = Arc::new(AtomicBool::new(true));
    let capture = InputCapture::start(Arc::clone(&writer), failure_tx)?;
    let (command_tx, command_rx) = mpsc::sync_channel(32);
    let control: Arc<dyn HostControl> = Arc::new(SessionControl {
        commands: command_tx,
        running: Arc::clone(&running),
        ready: ready.clone(),
    });

    if options.stream {
        println!("cursor\trole\ttext");
        std::io::stdout()
            .flush()
            .map_err(|error| format!("could not flush stream header: {error}"))?;
    }

    let mut actor = SessionActor::new(
        writer,
        event_rx,
        command_rx,
        audio_command_tx,
        options.stream,
        options.expert_spokesperson,
    );
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
    actor.finish_pending("voice call stopped");
    child.wait_for_exit()?;
    Ok(())
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
    session: Value,
}

enum ControlCommand {
    Speak {
        text: String,
        acknowledgement: Option<u64>,
        resolved_handoff_ids: Vec<String>,
        response: SyncSender<Result<Value, String>>,
    },
    Stop {
        response: SyncSender<Result<Value, String>>,
    },
}

struct SessionControl {
    commands: SyncSender<ControlCommand>,
    running: Arc<AtomicBool>,
    ready: ReadyState,
}

impl HostControl for SessionControl {
    fn status(&self) -> Result<Value, String> {
        Ok(json!({
            "running": self.running.load(Ordering::SeqCst),
            "session": self.ready.session,
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
    response: SyncSender<Result<Value, String>>,
}

enum AudioCommand {
    Suspend(u64),
    Resume(u64),
}

struct SessionActor {
    writer: Arc<Mutex<ChildStdin>>,
    events: Receiver<Value>,
    commands: Receiver<ControlCommand>,
    audio_commands: SyncSender<AudioCommand>,
    next_id: u64,
    pending_speak: Option<PendingSpeak>,
    stream: bool,
    expert_spokesperson: bool,
    stopping: bool,
}

impl SessionActor {
    fn new(
        writer: Arc<Mutex<ChildStdin>>,
        events: Receiver<Value>,
        commands: Receiver<ControlCommand>,
        audio_commands: SyncSender<AudioCommand>,
        stream: bool,
        expert_spokesperson: bool,
    ) -> Self {
        Self {
            writer,
            events,
            commands,
            audio_commands,
            next_id: 2,
            pending_speak: None,
            stream,
            expert_spokesperson,
            stopping: false,
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
        Ok(())
    }

    fn handle_command(&mut self, command: ControlCommand) -> Result<(), String> {
        match command {
            ControlCommand::Speak {
                text,
                acknowledgement,
                resolved_handoff_ids,
                response,
            } => {
                if self.pending_speak.is_some() {
                    let _ = response.send(Err("speech is already in progress".into()));
                    return Ok(());
                }
                let id = self.next_id();
                send_request(
                    &self.writer,
                    &SessionRequest::PrepareSpeak {
                        id,
                        acknowledgement,
                        text,
                        resolved_handoff_ids,
                    },
                )?;
                self.pending_speak = Some(PendingSpeak {
                    prepare_id: id,
                    response,
                });
            }
            ControlCommand::Stop { response } => {
                send_request(&self.writer, &SessionRequest::Shutdown)?;
                self.stopping = true;
                let _ = response.send(Ok(json!({"stopping":true})));
            }
        }
        Ok(())
    }

    fn handle_event(&mut self, event: Value) -> Result<(), String> {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "voice session emitted an untyped event".to_string())?
            .to_string();
        match kind.as_str() {
            "live_event" if !self.expert_spokesperson => self.stream_live_event(&event)?,
            "expert_delivery" if self.expert_spokesperson => self.stream_expert_delivery(&event)?,
            "live_event" | "expert_delivery" => {}
            "pending"
            | "not_admitted"
            | "admitted"
            | "output_ready_result"
            | "speech_started"
            | "speech_completed"
            | "speech_interrupted"
            | "speech_failed" => self.handle_speech_event(&kind, event)?,
            "audio_suspend" | "audio_resume" => {
                let speech_id = required_u64(&event, "speech_id")?;
                let command = if kind == "audio_suspend" {
                    AudioCommand::Suspend(speech_id)
                } else {
                    AudioCommand::Resume(speech_id)
                };
                self.audio_commands
                    .send(command)
                    .map_err(|_| "audio host stopped".to_string())?;
            }
            "fatal" => {
                let message = event
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("voice session failed")
                    .to_string();
                self.finish_pending(&message);
                return Err(message);
            }
            "input_speaking"
            | "recognition_pending"
            | "conversation_status_applied"
            | "tts_settings_result"
            | "input_during_tts_result"
            | "input_mute_applied"
            | "input_reset_applied"
            | "state"
            | "dismiss_handoffs_result"
            | "expert_turn_result"
            | "cancel_result"
            | "spokesperson_speech" => {}
            "ready" => return Err("voice session emitted ready more than once".into()),
            other => return Err(format!("voice session emitted unknown event: {other}")),
        }
        Ok(())
    }

    fn handle_speech_event(&mut self, kind: &str, event: Value) -> Result<(), String> {
        let Some(pending) = self.pending_speak.as_mut() else {
            return Ok(());
        };
        let event_id = event.get("id").and_then(Value::as_u64);
        match kind {
            "pending" if event_id == Some(pending.prepare_id) => {
                let utterances = event
                    .get("utterances")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                self.respond_speak(Ok(json!({"spoke":false,"utterances":utterances})));
            }
            "not_admitted" if event_id == Some(pending.prepare_id) => {
                let reason = event
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("not admitted");
                self.respond_speak(Err(format!("speech was not admitted: {reason}")));
            }
            "admitted" if event_id == Some(pending.prepare_id) => {
                let speech_id = required_u64(&event, "speech_id")?;
                send_request(
                    &self.writer,
                    &SessionRequest::OutputReady {
                        id: pending.prepare_id,
                        speech_id,
                    },
                )?;
            }
            "output_ready_result" if event_id == Some(pending.prepare_id) => {
                if event.get("outcome").and_then(Value::as_str) != Some("accepted") {
                    self.respond_speak(Err("speech output reservation became stale".into()));
                }
            }
            "speech_completed" if event_id == Some(pending.prepare_id) => {
                self.respond_speak(Ok(json!({"spoke":true,"status":"completed"})));
            }
            "speech_interrupted" if event_id == Some(pending.prepare_id) => {
                self.respond_speak(Ok(json!({
                    "spoke":true,
                    "status":"interrupted",
                    "spokenThroughUtf8":event.get("spoken_through_utf8").cloned().unwrap_or(json!(0)),
                })));
            }
            "speech_failed" if event_id == Some(pending.prepare_id) => {
                let message = event
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("speech failed");
                self.respond_speak(Err(message.to_string()));
            }
            _ => {}
        }
        Ok(())
    }

    fn respond_speak(&mut self, result: Result<Value, String>) {
        if let Some(pending) = self.pending_speak.take() {
            let _ = pending.response.send(result);
        }
    }

    fn stream_live_event(&self, event: &Value) -> Result<(), String> {
        if !self.stream {
            return Ok(());
        }
        let token = required_u64(event, "token")?;
        let text = required_str(event, "text")?;
        let role = event
            .get("origin")
            .and_then(Value::as_str)
            .unwrap_or("user");
        println!("{token}\t{role}\t{}", stream_text(text));
        std::io::stdout()
            .flush()
            .map_err(|error| format!("could not flush voice stream: {error}"))
    }

    fn stream_expert_delivery(&self, event: &Value) -> Result<(), String> {
        if !self.stream {
            return Ok(());
        }
        for (cursor, role, text) in expert_delivery_rows(event)? {
            println!("{cursor}\t{role}\t{text}");
        }
        std::io::stdout()
            .flush()
            .map_err(|error| format!("could not flush expert delivery: {error}"))
    }

    fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn finish_pending(&mut self, message: &str) {
        self.respond_speak(Err(message.to_string()));
    }
}

fn expert_delivery_rows(event: &Value) -> Result<Vec<(u64, String, String)>, String> {
    event
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "expert delivery has invalid events".to_string())?
        .iter()
        .map(|entry| {
            Ok((
                required_u64(entry, "cursor")?,
                required_str(entry, "role")?.to_string(),
                stream_text(required_str(entry, "text")?),
            ))
        })
        .collect()
}

fn receive_ready(events: &Receiver<Value>) -> Result<ReadyState, String> {
    let event = events
        .recv_timeout(Duration::from_secs(60))
        .map_err(|_| "timed out waiting for voice session startup".to_string())?;
    if event.get("type").and_then(Value::as_str) == Some("fatal") {
        return Err(event
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("voice session failed during startup")
            .to_string());
    }
    if event.get("type").and_then(Value::as_str) != Some("ready")
        || event.get("id").and_then(Value::as_u64) != Some(1)
        || event.get("protocol").and_then(Value::as_u64)
            != Some(u64::from(SESSION_PROTOCOL_VERSION))
    {
        return Err("voice session returned an invalid ready handshake".into());
    }
    Ok(ReadyState {
        session: event.get("session").cloned().unwrap_or(Value::Null),
    })
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
    events: SyncSender<Value>,
) -> Result<(), String> {
    thread::Builder::new()
        .name("berd-call-session-events".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    break;
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
            let mut active: Option<ActiveAudio> = None;
            let mut retired: Option<RetiredAudio> = None;
            let suspension_latency =
                berd_call::macos_audio_route::playback_latency_safety_duration(None);
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
                            if let Err(error) = handle_audio_record(
                                kind,
                                &payload,
                                &writer,
                                &mut active,
                                &mut retired,
                            ) {
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
                        &mut active,
                        retired,
                        suspension_latency,
                    ) {
                        report_failure(&failures, error);
                        return;
                    }
                }
                if let Some(playback) = active.as_mut() {
                    if let Err(error) = playback.player.check_health() {
                        let speech_id = playback.speech_id;
                        let played_frames = playback.player.played_frames();
                        let _ = send_request(
                            &writer,
                            &SessionRequest::AudioFailed {
                                speech_id,
                                played_frames,
                                message: error,
                            },
                        );
                        retired = Some(RetiredAudio {
                            speech_id,
                            played_frames,
                        });
                        active = None;
                        continue;
                    }
                    let played = playback.player.played_frames();
                    if played > playback.last_played {
                        playback.last_played = played;
                        let _ = send_request(
                            &writer,
                            &SessionRequest::AudioPlayed {
                                speech_id: playback.speech_id,
                                played_frames: played,
                            },
                        );
                    }
                    if let Some(sequence) = playback.ended_sequence {
                        if playback.player.is_empty() {
                            let speech_id = playback.speech_id;
                            let played_frames = playback.player.completed_source_frames();
                            let _ = send_request(
                                &writer,
                                &SessionRequest::AudioDrained {
                                    speech_id,
                                    sequence,
                                    played_frames,
                                },
                            );
                            retired = Some(RetiredAudio {
                                speech_id,
                                played_frames,
                            });
                            active = None;
                        }
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
    active: &mut Option<ActiveAudio>,
    retired: &mut Option<RetiredAudio>,
) -> Result<(), String> {
    match kind {
        AUDIO_BEGIN_KIND if payload.len() == 16 => {
            if active.is_some() {
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
            *active = Some(ActiveAudio {
                speech_id,
                player,
                last_played: 0,
                ended_sequence: None,
            });
            *retired = None;
            send_request(writer, &SessionRequest::AudioBeginAccepted { speech_id })
        }
        AUDIO_CHUNK_KIND if payload.len() >= 16 && (payload.len() - 16).is_multiple_of(4) => {
            let speech_id = le_u64(&payload[0..8])?;
            let sequence = le_u64(&payload[8..16])?;
            let playback = active
                .as_mut()
                .filter(|value| value.speech_id == speech_id)
                .ok_or_else(|| "voice session sent audio for an inactive speech".to_string())?;
            let mut samples = Vec::with_capacity((payload.len() - 16) / 4);
            for sample in payload[16..].chunks_exact(4) {
                samples.push(f32::from_le_bytes(
                    sample.try_into().expect("four-byte chunk"),
                ));
            }
            if let Err(message) = playback.player.enqueue(&samples) {
                let played_frames = playback.player.played_frames();
                *active = None;
                *retired = Some(RetiredAudio {
                    speech_id,
                    played_frames,
                });
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
            let playback = active
                .as_mut()
                .filter(|value| value.speech_id == speech_id)
                .ok_or_else(|| "voice session ended inactive audio".to_string())?;
            playback.ended_sequence = Some(sequence);
            Ok(())
        }
        AUDIO_CANCEL_KIND if payload.len() == 8 => {
            let speech_id = le_u64(payload)?;
            let playback = active
                .take()
                .filter(|value| value.speech_id == speech_id)
                .ok_or_else(|| "voice session cancelled inactive audio".to_string())?;
            let played_frames = playback.player.played_frames();
            playback.player.stop();
            *retired = Some(RetiredAudio {
                speech_id,
                played_frames,
            });
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
    active: &mut Option<ActiveAudio>,
    retired: Option<RetiredAudio>,
    suspension_latency: Duration,
) -> Result<(), String> {
    match command {
        AudioCommand::Suspend(speech_id) => {
            let played_frames = if let Some(playback) =
                active.as_ref().filter(|value| value.speech_id == speech_id)
            {
                playback.player.pause();
                thread::sleep(suspension_latency);
                playback.player.played_frames()
            } else {
                retired_played_frames(retired, speech_id)
            };
            send_request(
                writer,
                &SessionRequest::AudioSuspended {
                    speech_id,
                    played_frames,
                },
            )
        }
        AudioCommand::Resume(speech_id) => {
            let played_frames = if let Some(playback) =
                active.as_ref().filter(|value| value.speech_id == speech_id)
            {
                playback.player.resume();
                playback.player.played_frames()
            } else {
                retired_played_frames(retired, speech_id)
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

fn retired_played_frames(retired: Option<RetiredAudio>, speech_id: u64) -> u64 {
    retired
        .filter(|value| value.speech_id == speech_id)
        .map_or(0, |value| value.played_frames)
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

fn required_u64(value: &Value, field: &str) -> Result<u64, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("voice session event has invalid {field}"))
}

fn required_str<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("voice session event has invalid {field}"))
}

fn stream_text(text: &str) -> String {
    text.replace(['\r', '\n', '\t'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn expert_delivery_preserves_causal_rows() {
        let rows = expert_delivery_rows(&json!({
            "events": [
                {"cursor": 4, "role": "user", "text": "hello"},
                {"cursor": 5, "role": "spokesperson_interrupted", "text": "hi\nthere"}
            ]
        }))
        .unwrap();
        assert_eq!(
            rows,
            vec![
                (4, "user".into(), "hello".into()),
                (5, "spokesperson_interrupted".into(), "hi there".into())
            ]
        );
    }

    #[test]
    fn drained_audio_retains_progress_for_late_suspend_and_resume() {
        let retired = Some(RetiredAudio {
            speech_id: 17,
            played_frames: 48_000,
        });
        assert_eq!(retired_played_frames(retired, 17), 48_000);
        assert_eq!(retired_played_frames(retired, 18), 0);
    }
}
