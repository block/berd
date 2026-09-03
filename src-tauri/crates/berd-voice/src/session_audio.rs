use std::collections::VecDeque;
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use berd_voice::{PcmAudioOutput, TtsPcmSpec};

pub const AUDIO_FRAME_MAGIC: [u8; 2] = *b"BA";
pub const AUDIO_FRAME_MARKER: u8 = 2;
pub const AUDIO_BEGIN_KIND: u8 = 1;
pub const AUDIO_CHUNK_KIND: u8 = 2;
pub const AUDIO_END_KIND: u8 = 3;
pub const AUDIO_CANCEL_KIND: u8 = 4;
pub const AUDIO_FRAME_HEADER_BYTES: usize = 8;
pub const MAX_AUDIO_CHUNK_FRAMES: usize = 4096;
const MIN_ACCEPTED_AUDIO_RUNWAY_MS: f64 = 400.0;
const MAX_ACCEPTED_NOT_PLAYED_CHUNKS: usize = 64;

const AUDIO_OPERATION_TIMEOUT: Duration = Duration::from_secs(2);
pub const AUDIO_CANCELLED: &str = "remote PCM output was cancelled";

#[derive(Clone, Debug, PartialEq)]
pub enum AudioHostAck {
    BeginAccepted,
    BeginFailed { played_frames: u64, message: String },
    ChunkAccepted { sequence: u64 },
    Played { played_frames: u64 },
    Suspended { played_frames: u64 },
    Resumed { played_frames: u64 },
    Drained { sequence: u64, played_frames: u64 },
    Failed { played_frames: u64, message: String },
    Cancelled { played_frames: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioOutputControlRequest {
    Suspend { speech_id: u64 },
    Resume { speech_id: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SuspensionPhase {
    Running,
    Suspending,
    Suspended,
    Resuming,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    New,
    WaitingBegin,
    Streaming,
    WaitingChunk,
    Ended,
    Cancelling,
    Drained,
    Cancelled,
    Failed,
}

struct State {
    phase: Phase,
    begin_accepted: bool,
    next_sequence: u64,
    pending_sequence: Option<u64>,
    total_frames: u64,
    accepted_frames: u64,
    first_chunk_accepted: bool,
    played_frames: u64,
    accepted_chunk_ends: VecDeque<u64>,
    ended_sequence: Option<u64>,
    failure: Option<String>,
    failure_quiescent: bool,
    suspension: SuspensionPhase,
    suspension_requested: bool,
    suspension_deadline: Option<Instant>,
}

pub struct AudioPipeTransport {
    file: Mutex<File>,
    poisoned: Mutex<Option<String>>,
}

impl AudioPipeTransport {
    /// Takes ownership of an inherited child-write file descriptor.
    pub unsafe fn from_raw_fd(fd: RawFd) -> Result<Self, String> {
        if fd < 3 {
            return Err("PCM output file descriptor must be at least 3".into());
        }
        let file = File::from_raw_fd(fd);
        let flags = libc::fcntl(file.as_raw_fd(), libc::F_GETFL);
        if flags < 0 {
            return Err(format!(
                "could not configure PCM output descriptor: {}",
                io::Error::last_os_error()
            ));
        }
        if flags & libc::O_ACCMODE == libc::O_RDONLY {
            return Err("PCM output file descriptor is not writable".into());
        }
        if libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(format!(
                "could not configure PCM output descriptor: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(Self {
            file: Mutex::new(file),
            poisoned: Mutex::new(None),
        })
    }

    fn write_record(&self, kind: u8, payload: &[u8]) -> Result<(), String> {
        if let Some(message) = self.poisoned.lock().expect("audio poison lock").clone() {
            return Err(message);
        }
        let length = u32::try_from(payload.len())
            .map_err(|_| "PCM output record is too large".to_string())?;
        let mut record = Vec::with_capacity(AUDIO_FRAME_HEADER_BYTES + payload.len());
        record.extend_from_slice(&AUDIO_FRAME_MAGIC);
        record.push(AUDIO_FRAME_MARKER);
        record.push(kind);
        record.extend_from_slice(&length.to_le_bytes());
        record.extend_from_slice(payload);

        let deadline = Instant::now() + AUDIO_OPERATION_TIMEOUT;
        let file = self.file.lock().expect("audio pipe lock");
        let fd = file.as_raw_fd();
        let mut offset = 0;
        while offset < record.len() {
            let written =
                unsafe { libc::write(fd, record[offset..].as_ptr().cast(), record.len() - offset) };
            if written > 0 {
                offset += usize::try_from(written).expect("positive write fits usize");
                continue;
            }
            if written < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                if error.kind() != io::ErrorKind::WouldBlock {
                    return self.poison(format!("PCM output pipe write failed: {error}"));
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return self.poison(if offset == 0 {
                    "PCM output host did not read within 2 seconds".into()
                } else {
                    "PCM output host left a partial frame unread for 2 seconds".into()
                });
            }
            let timeout_ms = i32::try_from(remaining.as_millis().max(1).min(i32::MAX as u128))
                .expect("bounded poll timeout");
            let mut poll_fd = libc::pollfd {
                fd,
                events: libc::POLLOUT,
                revents: 0,
            };
            let result = unsafe { libc::poll(&mut poll_fd, 1, timeout_ms) };
            if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return self.poison(format!(
                    "PCM output pipe polling failed: {}",
                    io::Error::last_os_error()
                ));
            }
        }
        Ok(())
    }

    fn poison<T>(&self, message: String) -> Result<T, String> {
        *self.poisoned.lock().expect("audio poison lock") = Some(message.clone());
        Err(message)
    }
}

pub struct RemotePcmAudioOutput {
    speech_id: u64,
    spec: TtsPcmSpec,
    transport: Arc<AudioPipeTransport>,
    active: Arc<AtomicBool>,
    control_sender: mpsc::Sender<AudioOutputControlRequest>,
    operation_timeout: Duration,
    minimum_accepted_runway_frames: u64,
    pending_samples: Mutex<Vec<f32>>,
    state: Mutex<State>,
    changed: Condvar,
}

impl RemotePcmAudioOutput {
    pub fn new(
        speech_id: u64,
        spec: TtsPcmSpec,
        transport: Arc<AudioPipeTransport>,
        active: Arc<AtomicBool>,
        control_sender: mpsc::Sender<AudioOutputControlRequest>,
    ) -> Result<Self, String> {
        Self::new_with_timeout(
            speech_id,
            spec,
            transport,
            active,
            control_sender,
            AUDIO_OPERATION_TIMEOUT,
        )
    }

    fn new_with_timeout(
        speech_id: u64,
        spec: TtsPcmSpec,
        transport: Arc<AudioPipeTransport>,
        active: Arc<AtomicBool>,
        control_sender: mpsc::Sender<AudioOutputControlRequest>,
        operation_timeout: Duration,
    ) -> Result<Self, String> {
        if speech_id == 0
            || !matches!(spec.sample_rate, 24_000 | 48_000)
            || !spec.playback_rate.is_finite()
            || !(0.5..=2.0).contains(&spec.playback_rate)
        {
            return Err("remote PCM output configuration is invalid".into());
        }
        Ok(Self {
            speech_id,
            spec,
            transport,
            active,
            control_sender,
            operation_timeout,
            minimum_accepted_runway_frames: accepted_audio_runway_frames(spec),
            pending_samples: Mutex::new(Vec::with_capacity(MAX_AUDIO_CHUNK_FRAMES)),
            state: Mutex::new(State {
                phase: Phase::New,
                begin_accepted: false,
                next_sequence: 1,
                pending_sequence: None,
                total_frames: 0,
                accepted_frames: 0,
                first_chunk_accepted: false,
                played_frames: 0,
                accepted_chunk_ends: VecDeque::new(),
                ended_sequence: None,
                failure: None,
                failure_quiescent: false,
                suspension: SuspensionPhase::Running,
                suspension_requested: false,
                suspension_deadline: None,
            }),
            changed: Condvar::new(),
        })
    }

    pub fn start(&self) -> Result<(), String> {
        {
            let mut state = self.state.lock().expect("remote output state");
            if state.phase != Phase::New {
                return Err("remote PCM output begin is not in a new state".into());
            }
            state.phase = Phase::WaitingBegin;
        }
        let mut payload = Vec::with_capacity(16);
        payload.extend_from_slice(&self.speech_id.to_le_bytes());
        payload.extend_from_slice(&self.spec.sample_rate.to_le_bytes());
        payload.extend_from_slice(&self.spec.playback_rate.to_le_bytes());
        self.transport.write_record(AUDIO_BEGIN_KIND, &payload)?;
        self.wait_for(
            |state| state.phase != Phase::WaitingBegin,
            "audio begin acknowledgement",
            true,
        )?;
        self.check_health()?;
        self.wait_for_running()
    }

    pub fn finish_writes(&self) -> Result<(), String> {
        let final_samples = std::mem::take(
            &mut *self
                .pending_samples
                .lock()
                .expect("remote pending PCM lock"),
        );
        if !final_samples.is_empty() {
            self.write_chunk(&final_samples)?;
        }
        self.wait_for_running()?;
        let (last_sequence, total_frames) = {
            let mut state = self.state.lock().expect("remote output state");
            if state.suspension_requested || state.suspension != SuspensionPhase::Running {
                drop(state);
                self.wait_for_running()?;
                state = self.state.lock().expect("remote output state");
            }
            if state.phase != Phase::Streaming {
                return Err("remote PCM output cannot end before streaming is ready".into());
            }
            if state.total_frames == 0 {
                return Err("remote PCM output produced no audio frames".into());
            }
            state.phase = Phase::Ended;
            state.ended_sequence = Some(state.next_sequence - 1);
            (state.next_sequence - 1, state.total_frames)
        };
        let mut payload = Vec::with_capacity(24);
        payload.extend_from_slice(&self.speech_id.to_le_bytes());
        payload.extend_from_slice(&last_sequence.to_le_bytes());
        payload.extend_from_slice(&total_frames.to_le_bytes());
        self.transport.write_record(AUDIO_END_KIND, &payload)
    }

    /// Wakes the playback worker so it can serialize Cancel on the audio pipe.
    /// The caller owns only the cancellation flag; pipe writes remain worker-owned.
    pub fn notify_cancel_requested(&self) {
        self.changed.notify_all();
    }

    pub fn request_suspend(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("remote output state");
        state.suspension_requested = true;
        if state.suspension == SuspensionPhase::Running
            && !matches!(
                state.phase,
                Phase::Drained | Phase::Cancelled | Phase::Failed
            )
        {
            state.suspension = SuspensionPhase::Suspending;
            state.suspension_deadline = Some(Instant::now() + self.operation_timeout);
            self.control_sender
                .send(AudioOutputControlRequest::Suspend {
                    speech_id: self.speech_id,
                })
                .map_err(|_| "audio control receiver disconnected".to_string())?;
        }
        self.changed.notify_all();
        Ok(())
    }

    pub fn request_resume(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("remote output state");
        if !self.active.load(Ordering::SeqCst) {
            return Ok(());
        }
        state.suspension_requested = false;
        if state.suspension == SuspensionPhase::Suspended {
            state.suspension = SuspensionPhase::Resuming;
            state.suspension_deadline = Some(Instant::now() + self.operation_timeout);
            self.control_sender
                .send(AudioOutputControlRequest::Resume {
                    speech_id: self.speech_id,
                })
                .map_err(|_| "audio control receiver disconnected".to_string())?;
        }
        self.changed.notify_all();
        Ok(())
    }

    pub fn control_request_is_outstanding(&self, request: AudioOutputControlRequest) -> bool {
        let state = self.state.lock().expect("remote output state");
        matches!(
            (request, state.suspension),
            (
                AudioOutputControlRequest::Suspend { speech_id },
                SuspensionPhase::Suspending
            ) if speech_id == self.speech_id
        ) || matches!(
            (request, state.suspension),
            (
                AudioOutputControlRequest::Resume { speech_id },
                SuspensionPhase::Resuming
            ) if speech_id == self.speech_id
        )
    }

    pub fn check_suspension_deadline(&self, now: Instant) -> Result<(), String> {
        let mut state = self.state.lock().expect("remote output state");
        if state
            .suspension_deadline
            .is_some_and(|deadline| now >= deadline)
            && matches!(
                state.suspension,
                SuspensionPhase::Suspending | SuspensionPhase::Resuming
            )
        {
            state.phase = Phase::Failed;
            state.failure = Some("host did not settle audio suspension before its deadline".into());
            self.changed.notify_all();
            return Err(state.failure.clone().expect("suspension deadline failure"));
        }
        Ok(())
    }

    pub fn failure_is_quiescent(&self) -> bool {
        let state = self.state.lock().expect("remote output state");
        state.phase == Phase::Failed && state.failure_quiescent
    }

    pub fn handle_ack(&self, ack: AudioHostAck) -> Result<bool, String> {
        let mut state = self.state.lock().expect("remote output state");
        let mut started = false;
        match ack {
            AudioHostAck::BeginAccepted
                if state.phase == Phase::WaitingBegin
                    || (state.phase == Phase::Cancelling && !state.begin_accepted) =>
            {
                state.begin_accepted = true;
                if state.phase == Phase::WaitingBegin {
                    state.phase = Phase::Streaming;
                }
            }
            AudioHostAck::BeginFailed {
                played_frames,
                message,
            } if matches!(state.phase, Phase::WaitingBegin | Phase::Cancelling)
                && !state.begin_accepted
                && played_frames == 0 =>
            {
                if state.phase == Phase::WaitingBegin {
                    state.phase = Phase::Failed;
                    state.failure_quiescent = true;
                }
                state.failure = Some(public_host_failure(message));
            }
            AudioHostAck::ChunkAccepted { sequence }
                if matches!(state.phase, Phase::WaitingChunk | Phase::Cancelling)
                    && state.pending_sequence == Some(sequence) =>
            {
                let cancelling = state.phase == Phase::Cancelling;
                state.pending_sequence = None;
                state.next_sequence = state
                    .next_sequence
                    .checked_add(1)
                    .ok_or_else(|| "audio chunk sequence space is exhausted".to_string())?;
                let total_frames = state.total_frames;
                state.accepted_frames = total_frames;
                state.accepted_chunk_ends.push_back(total_frames);
                if !state.first_chunk_accepted {
                    state.first_chunk_accepted = true;
                    started = !cancelling;
                }
                if !cancelling {
                    state.phase = Phase::Streaming;
                }
            }
            AudioHostAck::Played { played_frames }
                if matches!(
                    state.phase,
                    Phase::Streaming | Phase::WaitingChunk | Phase::Ended | Phase::Cancelling
                ) && played_frames >= state.played_frames
                    && played_frames <= state.accepted_frames =>
            {
                state.played_frames = played_frames;
                while state
                    .accepted_chunk_ends
                    .front()
                    .is_some_and(|end| *end <= played_frames)
                {
                    state.accepted_chunk_ends.pop_front();
                }
            }
            AudioHostAck::Suspended { played_frames }
                if state.suspension == SuspensionPhase::Suspending
                    && !matches!(state.phase, Phase::Cancelled | Phase::Failed)
                    && played_frames >= state.played_frames
                    && played_frames <= state.accepted_frames =>
            {
                state.played_frames = played_frames;
                while state
                    .accepted_chunk_ends
                    .front()
                    .is_some_and(|end| *end <= played_frames)
                {
                    state.accepted_chunk_ends.pop_front();
                }
                state.suspension = SuspensionPhase::Suspended;
                state.suspension_deadline = None;
                if !state.suspension_requested && self.active.load(Ordering::SeqCst) {
                    state.suspension = SuspensionPhase::Resuming;
                    state.suspension_deadline = Some(Instant::now() + self.operation_timeout);
                    self.control_sender
                        .send(AudioOutputControlRequest::Resume {
                            speech_id: self.speech_id,
                        })
                        .map_err(|_| "audio control receiver disconnected".to_string())?;
                }
            }
            AudioHostAck::Resumed { played_frames }
                if state.suspension == SuspensionPhase::Resuming
                    && played_frames == state.played_frames =>
            {
                state.suspension = SuspensionPhase::Running;
                state.suspension_deadline = None;
                if state.suspension_requested && self.active.load(Ordering::SeqCst) {
                    state.suspension = SuspensionPhase::Suspending;
                    state.suspension_deadline = Some(Instant::now() + self.operation_timeout);
                    self.control_sender
                        .send(AudioOutputControlRequest::Suspend {
                            speech_id: self.speech_id,
                        })
                        .map_err(|_| "audio control receiver disconnected".to_string())?;
                }
            }
            AudioHostAck::Drained {
                sequence,
                played_frames,
            } if matches!(state.phase, Phase::Ended | Phase::Cancelling)
                && state.ended_sequence == Some(sequence)
                && played_frames == state.total_frames =>
            {
                state.played_frames = played_frames;
                state.accepted_chunk_ends.clear();
                if state.phase == Phase::Ended {
                    state.phase = Phase::Drained;
                }
                if state.phase == Phase::Drained && state.suspension == SuspensionPhase::Running {
                    state.suspension = SuspensionPhase::Running;
                    state.suspension_deadline = None;
                }
            }
            AudioHostAck::Failed {
                played_frames,
                message,
            } if matches!(
                state.phase,
                Phase::Streaming | Phase::WaitingChunk | Phase::Ended | Phase::Cancelling
            ) && played_frames >= state.played_frames
                && played_frames <= state.accepted_frames =>
            {
                state.played_frames = played_frames;
                if state.phase != Phase::Cancelling {
                    state.phase = Phase::Failed;
                    state.failure_quiescent = true;
                    state.suspension = SuspensionPhase::Running;
                    state.suspension_deadline = None;
                }
                state.failure = Some(public_host_failure(message));
            }
            AudioHostAck::Cancelled { played_frames }
                if state.phase == Phase::Cancelling
                    && played_frames >= state.played_frames
                    && played_frames <= state.accepted_frames =>
            {
                state.played_frames = played_frames;
                state.phase = if state.failure.is_some() {
                    state.failure_quiescent = true;
                    Phase::Failed
                } else {
                    Phase::Cancelled
                };
                state.suspension = SuspensionPhase::Running;
                state.suspension_deadline = None;
            }
            AudioHostAck::Played { played_frames }
                if matches!(
                    state.phase,
                    Phase::Streaming | Phase::WaitingChunk | Phase::Ended | Phase::Cancelling
                ) && played_frames == state.played_frames =>
            {
                return Ok(false)
            }
            _ => {
                return Err(
                    "audio host acknowledgement is stale, out of order, or impossible".into(),
                )
            }
        }
        self.changed.notify_all();
        Ok(started)
    }

    fn wait_for(
        &self,
        predicate: impl Fn(&State) -> bool,
        operation: &str,
        observe_cancellation: bool,
    ) -> Result<(), String> {
        let deadline = Instant::now() + self.operation_timeout;
        let mut state = self.state.lock().expect("remote output state");
        while !predicate(&state) && state.phase != Phase::Failed {
            if observe_cancellation
                && !self.active.load(Ordering::SeqCst)
                && state.phase != Phase::Cancelling
            {
                drop(state);
                self.cancel_settled()?;
                return Err(AUDIO_CANCELLED.into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.phase = Phase::Failed;
                let message = format!("host did not complete {operation} before its deadline");
                state.failure = Some(message.clone());
                self.changed.notify_all();
                return Err(message);
            }
            let (next, _) = self
                .changed
                .wait_timeout(state, remaining)
                .expect("remote output wait");
            state = next;
        }
        if state.phase == Phase::Failed {
            Err(state
                .failure
                .clone()
                .unwrap_or_else(|| "host audio output failed".into()))
        } else {
            Ok(())
        }
    }

    fn cancel_settled(&self) -> Result<u64, String> {
        {
            let mut state = self.state.lock().expect("remote output state");
            while matches!(
                state.suspension,
                SuspensionPhase::Suspending | SuspensionPhase::Resuming
            ) && state.phase != Phase::Failed
            {
                let remaining = state
                    .suspension_deadline
                    .map_or(Duration::ZERO, |deadline| {
                        deadline.saturating_duration_since(Instant::now())
                    });
                if remaining.is_zero() {
                    state.phase = Phase::Failed;
                    state.failure =
                        Some("host did not settle audio suspension before cancellation".into());
                    self.changed.notify_all();
                    return Err(state.failure.clone().expect("suspension cancel failure"));
                }
                let (next, _) = self
                    .changed
                    .wait_timeout(state, remaining)
                    .expect("remote output cancellation wait");
                state = next;
            }
        }
        let should_send = {
            let mut state = self.state.lock().expect("remote output state");
            match state.phase {
                Phase::Drained if state.suspension == SuspensionPhase::Running => {
                    return Ok(state.played_frames)
                }
                Phase::Cancelled => return Ok(state.played_frames),
                Phase::Failed => {
                    if state.failure_quiescent {
                        return Ok(state.played_frames);
                    }
                    return Err(state
                        .failure
                        .clone()
                        .unwrap_or_else(|| "host audio output failed".into()));
                }
                Phase::Cancelling => false,
                Phase::WaitingBegin
                | Phase::Streaming
                | Phase::WaitingChunk
                | Phase::Ended
                | Phase::Drained => {
                    state.phase = Phase::Cancelling;
                    true
                }
                Phase::New => {
                    return Err(
                        "remote PCM output cannot cancel during an unfinished record".into(),
                    )
                }
            }
        };
        if should_send {
            self.transport
                .write_record(AUDIO_CANCEL_KIND, &self.speech_id.to_le_bytes())?;
        }
        self.wait_for(
            |state| state.phase == Phase::Cancelled,
            "audio cancellation acknowledgement",
            false,
        )?;
        Ok(self
            .state
            .lock()
            .expect("remote output state")
            .played_frames)
    }

    fn wait_for_running(&self) -> Result<(), String> {
        loop {
            {
                let state = self.state.lock().expect("remote output state");
                match state.phase {
                    Phase::Cancelled => return Err(AUDIO_CANCELLED.into()),
                    Phase::Failed => {
                        return Err(state
                            .failure
                            .clone()
                            .unwrap_or_else(|| "host audio output failed".into()))
                    }
                    Phase::Drained => return Err("remote PCM output is already drained".into()),
                    _ => {}
                }
                if !self.active.load(Ordering::SeqCst) {
                    drop(state);
                    self.cancel_settled()?;
                    return Err(AUDIO_CANCELLED.into());
                }
                if let (SuspensionPhase::Running, false) =
                    (state.suspension, state.suspension_requested)
                {
                    return Ok(());
                }
            }
            let mut state = self.state.lock().expect("remote output state");
            loop {
                let settled = matches!(
                    (state.suspension, state.suspension_requested),
                    (SuspensionPhase::Running, false)
                        | (SuspensionPhase::Suspended, true)
                        | (SuspensionPhase::Suspended, false)
                );
                if settled || state.phase == Phase::Failed {
                    break;
                }
                let remaining = state
                    .suspension_deadline
                    .map_or(self.operation_timeout, |deadline| {
                        deadline.saturating_duration_since(Instant::now())
                    });
                if remaining.is_zero() {
                    state.phase = Phase::Failed;
                    state.failure =
                        Some("host did not settle audio suspension before its deadline".into());
                    self.changed.notify_all();
                    return Err(state.failure.clone().expect("suspension failure"));
                }
                let (next, _) = self
                    .changed
                    .wait_timeout(state, remaining)
                    .expect("remote output suspension wait");
                state = next;
            }
            if state.phase == Phase::Failed {
                return Err(state
                    .failure
                    .clone()
                    .unwrap_or_else(|| "host audio output failed".into()));
            }
            if state.suspension == SuspensionPhase::Suspended && state.suspension_requested {
                while state.suspension_requested && self.active.load(Ordering::SeqCst) {
                    state = self
                        .changed
                        .wait(state)
                        .expect("remote output suspended wait");
                }
                if !self.active.load(Ordering::SeqCst) {
                    drop(state);
                    self.cancel_settled()?;
                    return Err(AUDIO_CANCELLED.into());
                }
            }
        }
    }

    fn write_chunk(&self, chunk: &[f32]) -> Result<(), String> {
        debug_assert!(!chunk.is_empty() && chunk.len() <= MAX_AUDIO_CHUNK_FRAMES);
        self.wait_for_running()?;
        {
            let deadline = Instant::now() + self.operation_timeout;
            let mut state = self.state.lock().expect("remote output state");
            while (state.accepted_frames.saturating_sub(state.played_frames)
                >= self.minimum_accepted_runway_frames
                || state.accepted_chunk_ends.len() >= MAX_ACCEPTED_NOT_PLAYED_CHUNKS)
                && state.phase == Phase::Streaming
            {
                if !self.active.load(Ordering::SeqCst) {
                    drop(state);
                    self.cancel_settled()?;
                    return Err(AUDIO_CANCELLED.into());
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    state.phase = Phase::Failed;
                    state.failure =
                        Some("host audio queue did not release credit before its deadline".into());
                    self.changed.notify_all();
                    return Err(state.failure.clone().expect("credit failure"));
                }
                let (next, _) = self
                    .changed
                    .wait_timeout(state, remaining)
                    .expect("remote output credit wait");
                state = next;
                if state.suspension_requested {
                    drop(state);
                    self.wait_for_running()?;
                    state = self.state.lock().expect("remote output state");
                }
            }
            if state.phase != Phase::Streaming {
                return Err(state
                    .failure
                    .clone()
                    .unwrap_or_else(|| "remote PCM output is not streaming".into()));
            }
            state.pending_sequence = Some(state.next_sequence);
            state.total_frames = state
                .total_frames
                .checked_add(u64::try_from(chunk.len()).expect("chunk length fits u64"))
                .ok_or_else(|| "audio source-frame count is exhausted".to_string())?;
            state.phase = Phase::WaitingChunk;
        }
        let sequence = self
            .state
            .lock()
            .expect("remote output state")
            .pending_sequence
            .expect("pending audio sequence");
        let mut payload = Vec::with_capacity(16 + chunk.len() * 4);
        payload.extend_from_slice(&self.speech_id.to_le_bytes());
        payload.extend_from_slice(&sequence.to_le_bytes());
        for sample in chunk {
            payload.extend_from_slice(&sample.to_le_bytes());
        }
        self.transport.write_record(AUDIO_CHUNK_KIND, &payload)?;
        self.wait_for(
            |state| state.pending_sequence.is_none(),
            "audio chunk acknowledgement",
            true,
        )
    }
}

impl PcmAudioOutput for RemotePcmAudioOutput {
    fn write(&self, samples: &[f32]) -> Result<(), String> {
        if samples
            .iter()
            .any(|sample| !sample.is_finite() || !(-1.0..=1.0).contains(sample))
        {
            return Err("remote PCM output requires finite unit-scale samples".into());
        }
        let complete_samples = {
            let mut pending = self
                .pending_samples
                .lock()
                .expect("remote pending PCM lock");
            pending.extend_from_slice(samples);
            let complete_len = pending.len() / MAX_AUDIO_CHUNK_FRAMES * MAX_AUDIO_CHUNK_FRAMES;
            let tail = pending.split_off(complete_len);
            std::mem::replace(&mut *pending, tail)
        };
        for chunk in complete_samples.chunks_exact(MAX_AUDIO_CHUNK_FRAMES) {
            self.write_chunk(chunk)?;
        }
        Ok(())
    }

    fn cancel(&self) {
        let _ = self.cancel_settled();
    }

    fn cancel_and_snapshot(&self) -> Result<u64, String> {
        self.cancel_settled()
    }

    fn is_drained(&self) -> bool {
        let state = self.state.lock().expect("remote output state");
        state.phase == Phase::Drained && state.suspension == SuspensionPhase::Running
    }

    fn check_health(&self) -> Result<(), String> {
        let state = self.state.lock().expect("remote output state");
        if state.phase == Phase::Failed {
            Err(state
                .failure
                .clone()
                .unwrap_or_else(|| "host audio output failed".into()))
        } else {
            Ok(())
        }
    }

    fn played_frames(&self) -> u64 {
        self.state
            .lock()
            .expect("remote output state")
            .played_frames
    }
}

fn accepted_audio_runway_frames(spec: TtsPcmSpec) -> u64 {
    let runway_frames =
        (f64::from(spec.sample_rate) * f64::from(spec.playback_rate) * MIN_ACCEPTED_AUDIO_RUNWAY_MS
            / 1_000.0)
            .ceil() as usize;
    u64::try_from(runway_frames).expect("closed PCM runway fits u64")
}

fn public_host_failure(_message: String) -> String {
    "host audio output failed".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::fd::IntoRawFd;
    use std::os::unix::net::UnixStream;
    use std::sync::Arc;
    use std::thread;

    fn fixture() -> (Arc<RemotePcmAudioOutput>, UnixStream) {
        fixture_with_timeout(AUDIO_OPERATION_TIMEOUT)
    }

    fn fixture_with_timeout(timeout: Duration) -> (Arc<RemotePcmAudioOutput>, UnixStream) {
        fixture_with_spec_and_timeout(
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            },
            timeout,
        )
    }

    fn fixture_with_spec_and_timeout(
        spec: TtsPcmSpec,
        timeout: Duration,
    ) -> (Arc<RemotePcmAudioOutput>, UnixStream) {
        let (output, host, _control_receiver) = fixture_with_control(spec, timeout);
        (output, host)
    }

    fn fixture_with_control(
        spec: TtsPcmSpec,
        timeout: Duration,
    ) -> (
        Arc<RemotePcmAudioOutput>,
        UnixStream,
        mpsc::Receiver<AudioOutputControlRequest>,
    ) {
        let (child, host) = UnixStream::pair().unwrap();
        let (control_sender, control_receiver) = mpsc::channel();
        let transport = unsafe { AudioPipeTransport::from_raw_fd(child.into_raw_fd()) }.unwrap();
        let output = Arc::new(
            RemotePcmAudioOutput::new_with_timeout(
                7,
                spec,
                Arc::new(transport),
                Arc::new(AtomicBool::new(true)),
                control_sender,
                timeout,
            )
            .unwrap(),
        );
        (output, host, control_receiver)
    }

    fn read_record(reader: &mut impl Read) -> (u8, Vec<u8>) {
        let mut header = [0; AUDIO_FRAME_HEADER_BYTES];
        reader.read_exact(&mut header).unwrap();
        assert_eq!(header[..2], AUDIO_FRAME_MAGIC);
        assert_eq!(header[2], AUDIO_FRAME_MARKER);
        let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        let mut payload = vec![0; length];
        reader.read_exact(&mut payload).unwrap();
        (header[3], payload)
    }

    fn start(output: &Arc<RemotePcmAudioOutput>, host: &mut UnixStream) {
        let current = Arc::clone(output);
        let worker = thread::spawn(move || current.start());
        let (kind, payload) = read_record(host);
        assert_eq!(kind, AUDIO_BEGIN_KIND);
        assert_eq!(payload.len(), 16);
        assert_eq!(u64::from_le_bytes(payload[..8].try_into().unwrap()), 7);
        assert_eq!(
            u32::from_le_bytes(payload[8..12].try_into().unwrap()),
            output.spec.sample_rate
        );
        output.handle_ack(AudioHostAck::BeginAccepted).unwrap();
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn chunks_split_at_4096_wait_for_exact_acceptance_and_end_explicitly() {
        let (output, mut host) = fixture();
        start(&output, &mut host);
        let current = Arc::clone(&output);
        let worker = thread::spawn(move || current.write(&vec![0.25; 5_000]));
        let (kind, first) = read_record(&mut host);
        assert_eq!(kind, AUDIO_CHUNK_KIND);
        assert_eq!(first.len(), 16 + 4096 * 4);
        let started = output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 1 })
            .unwrap();
        assert!(started);
        worker.join().unwrap().unwrap();

        let current = Arc::clone(&output);
        let finisher = thread::spawn(move || current.finish_writes());
        let (kind, second) = read_record(&mut host);
        assert_eq!(kind, AUDIO_CHUNK_KIND);
        assert_eq!(second.len(), 16 + 904 * 4);
        output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 2 })
            .unwrap();
        let (kind, end) = read_record(&mut host);
        assert_eq!(kind, AUDIO_END_KIND);
        assert_eq!(u64::from_le_bytes(end[8..16].try_into().unwrap()), 2);
        assert_eq!(u64::from_le_bytes(end[16..24].try_into().unwrap()), 5_000);
        finisher.join().unwrap().unwrap();
        output
            .handle_ack(AudioHostAck::Drained {
                sequence: 2,
                played_frames: 5_000,
            })
            .unwrap();
        assert!(output.is_drained());
        assert_eq!(output.played_frames(), 5_000);
    }

    #[test]
    fn first_chunk_starts_before_a_larger_write_waits_for_played_credit() {
        let (output, mut host) = fixture();
        start(&output, &mut host);
        let current = Arc::clone(&output);
        let worker = thread::spawn(move || current.write(&vec![0.25; 4096 * 4]));
        for sequence in 1..=3 {
            let (kind, _) = read_record(&mut host);
            assert_eq!(kind, AUDIO_CHUNK_KIND);
            let started = output
                .handle_ack(AudioHostAck::ChunkAccepted { sequence })
                .unwrap();
            assert_eq!(started, sequence == 1);
        }
        host.set_read_timeout(Some(Duration::from_millis(30)))
            .unwrap();
        let mut byte = [0];
        assert!(host.read(&mut byte).is_err());
        output
            .handle_ack(AudioHostAck::Played {
                played_frames: 4096,
            })
            .unwrap();
        host.set_read_timeout(None).unwrap();
        let (kind, _) = read_record(&mut host);
        assert_eq!(kind, AUDIO_CHUNK_KIND);
        output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 4 })
            .unwrap();
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn suspension_quiesces_and_resumes_the_same_remote_stream() {
        let (output, mut host, controls) = fixture_with_control(
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            },
            AUDIO_OPERATION_TIMEOUT,
        );
        start(&output, &mut host);
        let current = Arc::clone(&output);
        let worker = thread::spawn(move || current.write(&vec![0.25; 4096 * 2]));
        let (kind, _) = read_record(&mut host);
        assert_eq!(kind, AUDIO_CHUNK_KIND);

        output.request_suspend().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Suspend { speech_id: 7 }
        );
        assert!(output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 1 })
            .unwrap());
        output
            .handle_ack(AudioHostAck::Suspended {
                played_frames: 4096,
            })
            .unwrap();
        host.set_read_timeout(Some(Duration::from_millis(30)))
            .unwrap();
        let mut byte = [0];
        assert!(host.read(&mut byte).is_err());

        output.request_resume().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Resume { speech_id: 7 }
        );
        output
            .handle_ack(AudioHostAck::Resumed {
                played_frames: 4096,
            })
            .unwrap();
        host.set_read_timeout(None).unwrap();
        let (kind, _) = read_record(&mut host);
        assert_eq!(kind, AUDIO_CHUNK_KIND);
        output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 2 })
            .unwrap();
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn suspension_before_begin_and_early_settlement_are_correlated() {
        let (output, mut host, controls) = fixture_with_control(
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            },
            AUDIO_OPERATION_TIMEOUT,
        );
        output.request_suspend().unwrap();
        output.request_resume().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Suspend { speech_id: 7 }
        );
        output
            .handle_ack(AudioHostAck::Suspended { played_frames: 0 })
            .unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Resume { speech_id: 7 }
        );
        output
            .handle_ack(AudioHostAck::Resumed { played_frames: 0 })
            .unwrap();

        start(&output, &mut host);
    }

    #[test]
    fn renewed_speaking_while_resume_is_in_flight_reissues_suspend() {
        let (output, mut host, controls) = fixture_with_control(
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            },
            AUDIO_OPERATION_TIMEOUT,
        );
        start(&output, &mut host);
        output.request_suspend().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Suspend { speech_id: 7 }
        );
        output
            .handle_ack(AudioHostAck::Suspended { played_frames: 0 })
            .unwrap();
        output.request_resume().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Resume { speech_id: 7 }
        );

        output.request_suspend().unwrap();
        output
            .handle_ack(AudioHostAck::Resumed { played_frames: 0 })
            .unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Suspend { speech_id: 7 }
        );
        assert!(output
            .control_request_is_outstanding(AudioOutputControlRequest::Suspend { speech_id: 7 }));
    }

    #[test]
    fn cancellation_waits_for_an_in_flight_suspension_barrier() {
        let (output, mut host, controls) = fixture_with_control(
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            },
            AUDIO_OPERATION_TIMEOUT,
        );
        start(&output, &mut host);
        output.request_suspend().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Suspend { speech_id: 7 }
        );
        let current = Arc::clone(&output);
        let canceller = thread::spawn(move || current.cancel_settled());
        host.set_read_timeout(Some(Duration::from_millis(30)))
            .unwrap();
        let mut byte = [0];
        assert!(host.read(&mut byte).is_err());
        output
            .handle_ack(AudioHostAck::Suspended { played_frames: 0 })
            .unwrap();
        host.set_read_timeout(None).unwrap();
        let (kind, _) = read_record(&mut host);
        assert_eq!(kind, AUDIO_CANCEL_KIND);
        output
            .handle_ack(AudioHostAck::Cancelled { played_frames: 0 })
            .unwrap();
        assert_eq!(canceller.join().unwrap().unwrap(), 0);
    }

    #[test]
    fn cancellation_authority_suppresses_resume_after_a_late_suspend_ack() {
        let (child, mut host) = UnixStream::pair().unwrap();
        let transport = unsafe { AudioPipeTransport::from_raw_fd(child.into_raw_fd()) }.unwrap();
        let active = Arc::new(AtomicBool::new(true));
        let (control_sender, controls) = mpsc::channel();
        let output = Arc::new(
            RemotePcmAudioOutput::new_with_timeout(
                7,
                TtsPcmSpec {
                    sample_rate: 24_000,
                    playback_rate: 1.0,
                },
                Arc::new(transport),
                Arc::clone(&active),
                control_sender,
                AUDIO_OPERATION_TIMEOUT,
            )
            .unwrap(),
        );
        start(&output, &mut host);
        output.request_suspend().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Suspend { speech_id: 7 }
        );
        output.request_resume().unwrap();

        active.store(false, Ordering::SeqCst);
        output.notify_cancel_requested();
        let current = Arc::clone(&output);
        let canceller = thread::spawn(move || current.cancel_settled());
        output
            .handle_ack(AudioHostAck::Suspended { played_frames: 0 })
            .unwrap();
        assert!(controls.try_recv().is_err());
        assert_eq!(read_record(&mut host).0, AUDIO_CANCEL_KIND);
        output
            .handle_ack(AudioHostAck::Cancelled { played_frames: 0 })
            .unwrap();
        assert_eq!(canceller.join().unwrap().unwrap(), 0);
    }

    #[test]
    fn cancellation_authority_suppresses_resuspend_after_a_late_resume_ack() {
        let (child, mut host) = UnixStream::pair().unwrap();
        let transport = unsafe { AudioPipeTransport::from_raw_fd(child.into_raw_fd()) }.unwrap();
        let active = Arc::new(AtomicBool::new(true));
        let (control_sender, controls) = mpsc::channel();
        let output = Arc::new(
            RemotePcmAudioOutput::new_with_timeout(
                7,
                TtsPcmSpec {
                    sample_rate: 24_000,
                    playback_rate: 1.0,
                },
                Arc::new(transport),
                Arc::clone(&active),
                control_sender,
                AUDIO_OPERATION_TIMEOUT,
            )
            .unwrap(),
        );
        start(&output, &mut host);
        output.request_suspend().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Suspend { speech_id: 7 }
        );
        output
            .handle_ack(AudioHostAck::Suspended { played_frames: 0 })
            .unwrap();
        output.request_resume().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Resume { speech_id: 7 }
        );
        output.request_suspend().unwrap();

        active.store(false, Ordering::SeqCst);
        output.notify_cancel_requested();
        let current = Arc::clone(&output);
        let canceller = thread::spawn(move || current.cancel_settled());
        output
            .handle_ack(AudioHostAck::Resumed { played_frames: 0 })
            .unwrap();
        assert!(controls.try_recv().is_err());
        assert_eq!(read_record(&mut host).0, AUDIO_CANCEL_KIND);
        output
            .handle_ack(AudioHostAck::Cancelled { played_frames: 0 })
            .unwrap();
        assert_eq!(canceller.join().unwrap().unwrap(), 0);
    }

    #[test]
    fn cancellation_waits_for_an_in_flight_resume_barrier() {
        let (output, mut host, controls) = fixture_with_control(
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            },
            AUDIO_OPERATION_TIMEOUT,
        );
        start(&output, &mut host);
        output.request_suspend().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Suspend { speech_id: 7 }
        );
        output
            .handle_ack(AudioHostAck::Suspended { played_frames: 0 })
            .unwrap();
        output.request_resume().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Resume { speech_id: 7 }
        );

        let current = Arc::clone(&output);
        let canceller = thread::spawn(move || current.cancel_settled());
        host.set_read_timeout(Some(Duration::from_millis(30)))
            .unwrap();
        let mut byte = [0];
        assert!(host.read(&mut byte).is_err());
        output
            .handle_ack(AudioHostAck::Resumed { played_frames: 0 })
            .unwrap();
        host.set_read_timeout(None).unwrap();
        assert_eq!(read_record(&mut host).0, AUDIO_CANCEL_KIND);
        output
            .handle_ack(AudioHostAck::Cancelled { played_frames: 0 })
            .unwrap();
        assert_eq!(canceller.join().unwrap().unwrap(), 0);
    }

    #[test]
    fn terminal_output_rejects_a_late_suspension_ack() {
        let (output, mut host, _controls) = fixture_with_control(
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            },
            AUDIO_OPERATION_TIMEOUT,
        );
        start(&output, &mut host);
        output.request_suspend().unwrap();
        output
            .handle_ack(AudioHostAck::Failed {
                played_frames: 0,
                message: "route failed".into(),
            })
            .unwrap();
        assert_eq!(
            output
                .handle_ack(AudioHostAck::Suspended { played_frames: 0 })
                .unwrap_err(),
            "audio host acknowledgement is stale, out of order, or impossible"
        );
    }

    #[test]
    fn drained_before_suspend_ack_stays_held_until_resume() {
        let (output, mut host, controls) = fixture_with_control(
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            },
            AUDIO_OPERATION_TIMEOUT,
        );
        start(&output, &mut host);
        let current = Arc::clone(&output);
        let writer = thread::spawn(move || current.write(&vec![0.25; 4096]));
        let (kind, _) = read_record(&mut host);
        assert_eq!(kind, AUDIO_CHUNK_KIND);
        output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 1 })
            .unwrap();
        writer.join().unwrap().unwrap();
        let current = Arc::clone(&output);
        let finisher = thread::spawn(move || current.finish_writes());
        let (kind, end) = read_record(&mut host);
        assert_eq!(kind, AUDIO_END_KIND);
        assert_eq!(u64::from_le_bytes(end[8..16].try_into().unwrap()), 1);

        output.request_suspend().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Suspend { speech_id: 7 }
        );
        output
            .handle_ack(AudioHostAck::Drained {
                sequence: 1,
                played_frames: 4096,
            })
            .unwrap();
        assert!(!output.is_drained());
        output
            .handle_ack(AudioHostAck::Suspended {
                played_frames: 4096,
            })
            .unwrap();
        output.request_resume().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Resume { speech_id: 7 }
        );
        output
            .handle_ack(AudioHostAck::Resumed {
                played_frames: 4096,
            })
            .unwrap();
        assert!(output.is_drained());
        finisher.join().unwrap().unwrap();
    }

    #[test]
    fn terminal_cancel_clears_a_suspended_already_drained_stream() {
        let (output, mut host, controls) = fixture_with_control(
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            },
            AUDIO_OPERATION_TIMEOUT,
        );
        start(&output, &mut host);
        let current = Arc::clone(&output);
        let writer = thread::spawn(move || current.write(&vec![0.25; 4096]));
        assert_eq!(read_record(&mut host).0, AUDIO_CHUNK_KIND);
        output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 1 })
            .unwrap();
        writer.join().unwrap().unwrap();
        let current = Arc::clone(&output);
        let finisher = thread::spawn(move || current.finish_writes());
        assert_eq!(read_record(&mut host).0, AUDIO_END_KIND);
        output.request_suspend().unwrap();
        assert_eq!(
            controls.recv_timeout(Duration::from_millis(30)).unwrap(),
            AudioOutputControlRequest::Suspend { speech_id: 7 }
        );
        output
            .handle_ack(AudioHostAck::Drained {
                sequence: 1,
                played_frames: 4096,
            })
            .unwrap();
        output
            .handle_ack(AudioHostAck::Suspended {
                played_frames: 4096,
            })
            .unwrap();
        let current = Arc::clone(&output);
        let canceller = thread::spawn(move || current.cancel_settled());
        assert_eq!(read_record(&mut host).0, AUDIO_CANCEL_KIND);
        output
            .handle_ack(AudioHostAck::Cancelled {
                played_frames: 4096,
            })
            .unwrap();
        assert_eq!(canceller.join().unwrap().unwrap(), 4096);
        finisher.join().unwrap().unwrap();
    }

    #[test]
    fn production_rates_buffer_a_sustained_runway_before_played_credit() {
        for (spec, expected_chunks) in [
            (
                TtsPcmSpec {
                    sample_rate: 48_000,
                    playback_rate: 1.5,
                },
                8,
            ),
            (
                TtsPcmSpec {
                    sample_rate: 24_000,
                    playback_rate: 2.0,
                },
                5,
            ),
        ] {
            let (output, mut host) =
                fixture_with_spec_and_timeout(spec, Duration::from_millis(100));
            start(&output, &mut host);
            let current = Arc::clone(&output);
            let worker = thread::spawn(move || {
                current.write(&vec![0.25; MAX_AUDIO_CHUNK_FRAMES * expected_chunks])
            });
            host.set_read_timeout(Some(Duration::from_millis(50)))
                .unwrap();
            for sequence in 1..=expected_chunks as u64 {
                let (kind, _) = read_record(&mut host);
                assert_eq!(kind, AUDIO_CHUNK_KIND);
                output
                    .handle_ack(AudioHostAck::ChunkAccepted { sequence })
                    .unwrap();
            }
            worker.join().unwrap().unwrap();
        }
    }

    #[test]
    fn short_backend_callbacks_coalesce_into_bounded_transport_records() {
        let (output, mut host) = fixture();
        start(&output, &mut host);
        for _ in 0..7 {
            output.write(&vec![0.25; 512]).unwrap();
        }
        host.set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        let mut byte = [0];
        assert!(host.read(&mut byte).is_err());

        let current = Arc::clone(&output);
        let worker = thread::spawn(move || current.write(&vec![0.25; 512]));
        host.set_read_timeout(None).unwrap();
        let (kind, chunk) = read_record(&mut host);
        assert_eq!(kind, AUDIO_CHUNK_KIND);
        assert_eq!(chunk.len(), 16 + MAX_AUDIO_CHUNK_FRAMES * 4);
        output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 1 })
            .unwrap();
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn empty_output_fails_before_emitting_audio_end() {
        let (output, mut host) = fixture();
        start(&output, &mut host);

        assert_eq!(
            output.finish_writes().unwrap_err(),
            "remote PCM output produced no audio frames"
        );
        host.set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        let mut byte = [0];
        assert!(host.read(&mut byte).is_err());
    }

    #[test]
    fn cancel_waits_for_quiescence_and_returns_the_settled_snapshot() {
        let (output, mut host) = fixture();
        start(&output, &mut host);
        let current = Arc::clone(&output);
        let worker = thread::spawn(move || current.cancel_and_snapshot());
        let (kind, payload) = read_record(&mut host);
        assert_eq!(kind, AUDIO_CANCEL_KIND);
        assert_eq!(u64::from_le_bytes(payload.try_into().unwrap()), 7);
        output
            .handle_ack(AudioHostAck::Cancelled { played_frames: 0 })
            .unwrap();
        assert_eq!(worker.join().unwrap().unwrap(), 0);
        assert!(output
            .handle_ack(AudioHostAck::Played { played_frames: 1 })
            .is_err());
    }

    #[test]
    fn cancellation_overtakes_a_held_begin_ack_on_the_worker_pipe() {
        let (output, mut host) = fixture();
        let current = Arc::clone(&output);
        let worker = thread::spawn(move || current.start());
        assert_eq!(read_record(&mut host).0, AUDIO_BEGIN_KIND);

        output.active.store(false, Ordering::SeqCst);
        output.notify_cancel_requested();
        assert_eq!(read_record(&mut host).0, AUDIO_CANCEL_KIND);
        output.handle_ack(AudioHostAck::BeginAccepted).unwrap();
        output
            .handle_ack(AudioHostAck::Cancelled { played_frames: 0 })
            .unwrap();
        assert_eq!(worker.join().unwrap().unwrap_err(), AUDIO_CANCELLED);
    }

    #[test]
    fn cancellation_overtakes_a_held_chunk_ack_and_uses_only_accepted_frames() {
        let (output, mut host) = fixture();
        start(&output, &mut host);
        let current = Arc::clone(&output);
        let worker = thread::spawn(move || current.write(&[0.25; MAX_AUDIO_CHUNK_FRAMES]));
        assert_eq!(read_record(&mut host).0, AUDIO_CHUNK_KIND);

        output.active.store(false, Ordering::SeqCst);
        output.notify_cancel_requested();
        assert_eq!(read_record(&mut host).0, AUDIO_CANCEL_KIND);
        output
            .handle_ack(AudioHostAck::Cancelled { played_frames: 0 })
            .unwrap();
        assert_eq!(worker.join().unwrap().unwrap_err(), AUDIO_CANCELLED);
        assert!(output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 1 })
            .is_err());
    }

    #[test]
    fn pending_chunk_acceptance_may_settle_in_pipe_order_before_cancelled() {
        let (output, mut host) = fixture();
        start(&output, &mut host);
        let current = Arc::clone(&output);
        let worker = thread::spawn(move || current.write(&[0.25; MAX_AUDIO_CHUNK_FRAMES]));
        assert_eq!(read_record(&mut host).0, AUDIO_CHUNK_KIND);

        output.active.store(false, Ordering::SeqCst);
        output.notify_cancel_requested();
        assert_eq!(read_record(&mut host).0, AUDIO_CANCEL_KIND);
        let started = output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 1 })
            .unwrap();
        assert!(!started, "cancelling speech must not publish a late start");
        output
            .handle_ack(AudioHostAck::Played { played_frames: 64 })
            .unwrap();
        output
            .handle_ack(AudioHostAck::Cancelled { played_frames: 64 })
            .unwrap();
        assert_eq!(worker.join().unwrap().unwrap_err(), AUDIO_CANCELLED);
        assert_eq!(output.played_frames(), 64);
    }

    #[test]
    fn drained_before_cancelled_still_resolves_the_authoritative_cancellation() {
        let (output, mut host) = fixture();
        start(&output, &mut host);
        let current = Arc::clone(&output);
        let writer = thread::spawn(move || current.write(&[0.25; MAX_AUDIO_CHUNK_FRAMES]));
        assert_eq!(read_record(&mut host).0, AUDIO_CHUNK_KIND);
        output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 1 })
            .unwrap();
        writer.join().unwrap().unwrap();
        output.finish_writes().unwrap();
        assert_eq!(read_record(&mut host).0, AUDIO_END_KIND);

        let current = Arc::clone(&output);
        let cancel = thread::spawn(move || current.cancel_and_snapshot());
        assert_eq!(read_record(&mut host).0, AUDIO_CANCEL_KIND);
        output
            .handle_ack(AudioHostAck::Drained {
                sequence: 1,
                played_frames: MAX_AUDIO_CHUNK_FRAMES as u64,
            })
            .unwrap();
        output
            .handle_ack(AudioHostAck::Cancelled {
                played_frames: MAX_AUDIO_CHUNK_FRAMES as u64,
            })
            .unwrap();
        assert_eq!(
            cancel.join().unwrap().unwrap(),
            MAX_AUDIO_CHUNK_FRAMES as u64
        );
    }

    #[test]
    fn host_failure_before_cancelled_remains_a_failure_after_quiescence() {
        let (output, mut host) = fixture();
        start(&output, &mut host);
        let current = Arc::clone(&output);
        let cancel = thread::spawn(move || current.cancel_and_snapshot());
        assert_eq!(read_record(&mut host).0, AUDIO_CANCEL_KIND);
        output
            .handle_ack(AudioHostAck::Failed {
                played_frames: 0,
                message: "private device detail".into(),
            })
            .unwrap();
        output
            .handle_ack(AudioHostAck::Cancelled { played_frames: 0 })
            .unwrap();
        assert_eq!(
            cancel.join().unwrap().unwrap_err(),
            "host audio output failed"
        );
    }

    #[test]
    fn impossible_progress_and_wrong_sequence_are_rejected() {
        let (output, mut host) = fixture();
        start(&output, &mut host);
        assert!(output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 2 })
            .is_err());
        assert!(output
            .handle_ack(AudioHostAck::Played { played_frames: 1 })
            .is_err());
    }

    #[test]
    fn begin_ack_silence_is_bounded_and_terminal() {
        let (output, mut host) = fixture_with_timeout(Duration::from_millis(20));
        let current = Arc::clone(&output);
        let worker = thread::spawn(move || current.start());
        assert_eq!(read_record(&mut host).0, AUDIO_BEGIN_KIND);
        assert!(worker
            .join()
            .unwrap()
            .unwrap_err()
            .contains("before its deadline"));
        assert!(output.check_health().is_err());
    }

    #[test]
    fn closed_pcm_pipe_fails_begin_without_waiting_for_an_ack() {
        let (output, host) = fixture();
        drop(host);
        assert!(output.start().unwrap_err().contains("pipe write failed"));
    }

    #[test]
    fn inherited_read_only_descriptor_is_rejected_before_session_ready() {
        let mut descriptors = [-1; 2];
        assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
        unsafe { libc::close(descriptors[1]) };
        let error = match unsafe { AudioPipeTransport::from_raw_fd(descriptors[0]) } {
            Ok(_) => panic!("read-only descriptor must fail preflight"),
            Err(error) => error,
        };
        assert_eq!(error, "PCM output file descriptor is not writable");
    }

    #[test]
    fn closed_pcm_specs_accept_both_engine_rates_and_reject_other_shapes() {
        for (sample_rate, playback_rate) in [(24_000, 0.5), (24_000, 2.0), (48_000, 1.0)] {
            let (child, _host) = UnixStream::pair().unwrap();
            let transport =
                unsafe { AudioPipeTransport::from_raw_fd(child.into_raw_fd()) }.unwrap();
            let (control_sender, _control_receiver) = mpsc::channel();
            assert!(RemotePcmAudioOutput::new(
                1,
                TtsPcmSpec {
                    sample_rate,
                    playback_rate,
                },
                Arc::new(transport),
                Arc::new(AtomicBool::new(true)),
                control_sender,
            )
            .is_ok());
        }
        let (child, _host) = UnixStream::pair().unwrap();
        let transport = unsafe { AudioPipeTransport::from_raw_fd(child.into_raw_fd()) }.unwrap();
        let (control_sender, _control_receiver) = mpsc::channel();
        assert!(RemotePcmAudioOutput::new(
            1,
            TtsPcmSpec {
                sample_rate: 44_100,
                playback_rate: 1.0,
            },
            Arc::new(transport),
            Arc::new(AtomicBool::new(true)),
            control_sender,
        )
        .is_err());
    }
}
