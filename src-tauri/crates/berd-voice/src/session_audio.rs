use std::collections::VecDeque;
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
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
pub const MAX_ACCEPTED_NOT_PLAYED_CHUNKS: usize = 2;

const AUDIO_OPERATION_TIMEOUT: Duration = Duration::from_secs(2);
pub const AUDIO_CANCELLED: &str = "remote PCM output was cancelled";

#[derive(Clone, Debug, PartialEq)]
pub enum AudioHostAck {
    BeginAccepted,
    BeginFailed { played_frames: u64, message: String },
    ChunkAccepted { sequence: u64 },
    Played { played_frames: u64 },
    Drained { sequence: u64, played_frames: u64 },
    Failed { played_frames: u64, message: String },
    Cancelled { played_frames: u64 },
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
    operation_timeout: Duration,
    state: Mutex<State>,
    changed: Condvar,
}

impl RemotePcmAudioOutput {
    pub fn new(
        speech_id: u64,
        spec: TtsPcmSpec,
        transport: Arc<AudioPipeTransport>,
        active: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        Self::new_with_timeout(speech_id, spec, transport, active, AUDIO_OPERATION_TIMEOUT)
    }

    fn new_with_timeout(
        speech_id: u64,
        spec: TtsPcmSpec,
        transport: Arc<AudioPipeTransport>,
        active: Arc<AtomicBool>,
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
            operation_timeout,
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
        self.check_health()
    }

    pub fn finish_writes(&self) -> Result<(), String> {
        let (last_sequence, total_frames) = {
            let mut state = self.state.lock().expect("remote output state");
            if state.phase != Phase::Streaming {
                return Err("remote PCM output cannot end before streaming is ready".into());
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
        let should_send = {
            let mut state = self.state.lock().expect("remote output state");
            match state.phase {
                Phase::Drained | Phase::Cancelled => return Ok(state.played_frames),
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
                Phase::WaitingBegin | Phase::Streaming | Phase::WaitingChunk | Phase::Ended => {
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
}

impl PcmAudioOutput for RemotePcmAudioOutput {
    fn write(&self, samples: &[f32]) -> Result<(), String> {
        if samples
            .iter()
            .any(|sample| !sample.is_finite() || !(-1.0..=1.0).contains(sample))
        {
            return Err("remote PCM output requires finite unit-scale samples".into());
        }
        for chunk in samples.chunks(MAX_AUDIO_CHUNK_FRAMES) {
            if chunk.is_empty() {
                continue;
            }
            {
                let deadline = Instant::now() + self.operation_timeout;
                let mut state = self.state.lock().expect("remote output state");
                while state.accepted_chunk_ends.len() >= MAX_ACCEPTED_NOT_PLAYED_CHUNKS
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
                        state.failure = Some(
                            "host audio queue did not release credit before its deadline".into(),
                        );
                        self.changed.notify_all();
                        return Err(state.failure.clone().expect("credit failure"));
                    }
                    let (next, _) = self
                        .changed
                        .wait_timeout(state, remaining)
                        .expect("remote output credit wait");
                    state = next;
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
            )?;
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
        self.state.lock().expect("remote output state").phase == Phase::Drained
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
        let (child, host) = UnixStream::pair().unwrap();
        let transport = unsafe { AudioPipeTransport::from_raw_fd(child.into_raw_fd()) }.unwrap();
        let output = Arc::new(
            RemotePcmAudioOutput::new_with_timeout(
                7,
                TtsPcmSpec {
                    sample_rate: 24_000,
                    playback_rate: 1.0,
                },
                Arc::new(transport),
                Arc::new(AtomicBool::new(true)),
                timeout,
            )
            .unwrap(),
        );
        (output, host)
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
            24_000
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
        let (kind, second) = read_record(&mut host);
        assert_eq!(kind, AUDIO_CHUNK_KIND);
        assert_eq!(second.len(), 16 + 904 * 4);
        output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 2 })
            .unwrap();
        worker.join().unwrap().unwrap();

        output.finish_writes().unwrap();
        let (kind, end) = read_record(&mut host);
        assert_eq!(kind, AUDIO_END_KIND);
        assert_eq!(u64::from_le_bytes(end[8..16].try_into().unwrap()), 2);
        assert_eq!(u64::from_le_bytes(end[16..24].try_into().unwrap()), 5_000);
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
        let worker = thread::spawn(move || current.write(&vec![0.25; 4096 * 3]));
        for sequence in 1..=2 {
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
            .handle_ack(AudioHostAck::Played {
                played_frames: 4096 * 2,
            })
            .unwrap();
        output
            .handle_ack(AudioHostAck::ChunkAccepted { sequence: 3 })
            .unwrap();
        worker.join().unwrap().unwrap();
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
        let worker = thread::spawn(move || current.write(&[0.25; 128]));
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
        let worker = thread::spawn(move || current.write(&[0.25; 128]));
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
        let writer = thread::spawn(move || current.write(&[0.25; 32]));
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
                played_frames: 32,
            })
            .unwrap();
        output
            .handle_ack(AudioHostAck::Cancelled { played_frames: 32 })
            .unwrap();
        assert_eq!(cancel.join().unwrap().unwrap(), 32);
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
            assert!(RemotePcmAudioOutput::new(
                1,
                TtsPcmSpec {
                    sample_rate,
                    playback_rate,
                },
                Arc::new(transport),
                Arc::new(AtomicBool::new(true)),
            )
            .is_ok());
        }
        let (child, _host) = UnixStream::pair().unwrap();
        let transport = unsafe { AudioPipeTransport::from_raw_fd(child.into_raw_fd()) }.unwrap();
        assert!(RemotePcmAudioOutput::new(
            1,
            TtsPcmSpec {
                sample_rate: 44_100,
                playback_rate: 1.0,
            },
            Arc::new(transport),
            Arc::new(AtomicBool::new(true)),
        )
        .is_err());
    }
}
