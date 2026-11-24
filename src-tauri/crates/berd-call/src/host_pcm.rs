use std::io::{BufRead, Read};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use berd_call::PocketAudioPlayer;

use crate::host_session::{print_flushed, INPUT_FRAME_SAMPLES};

const FRAME_BYTES: usize = INPUT_FRAME_SAMPLES * 2;
const ENCODED_BYTES: usize = FRAME_BYTES.div_ceil(3) * 4;
const NATIVE_BUFFERS: u64 = 6;
const OUTPUT_BUFFERS: usize = 32;
const MAX_SOURCE_BYTES: usize = 64;
const RECENT_AUDIO: Duration = Duration::from_millis(120);
type Frame = [f32; INPUT_FRAME_SAMPLES];

enum Captured {
    Mic {
        epoch: u64,
        muted: Arc<AtomicBool>,
        current_epoch: Arc<AtomicU64>,
    },
    Playback(String),
}

struct Output {
    bytes: [u8; FRAME_BYTES],
    source: Captured,
}

fn encode_samples(samples: &[f32]) -> [u8; FRAME_BYTES] {
    let mut bytes = [0; FRAME_BYTES];
    for (pair, sample) in bytes.chunks_exact_mut(2).zip(samples) {
        pair.copy_from_slice(&((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    bytes
}

#[derive(Clone)]
pub(crate) struct PcmOutput(SyncSender<Output>);

impl PcmOutput {
    pub(crate) fn frame(
        &self,
        samples: &[f32],
        epoch: u64,
        muted: &Arc<AtomicBool>,
        current_epoch: &Arc<AtomicU64>,
    ) {
        if muted.load(Ordering::SeqCst) || epoch != current_epoch.load(Ordering::SeqCst) {
            return;
        }

        let _ = self.0.try_send(Output {
            bytes: encode_samples(samples),
            source: Captured::Mic {
                epoch,
                muted: Arc::clone(muted),
                current_epoch: Arc::clone(current_epoch),
            },
        });
    }

    pub(crate) fn played(&self, source: &str, samples: &Frame) {
        let _ = self.0.try_send(Output {
            bytes: encode_samples(samples),
            source: Captured::Playback(source.to_owned()),
        });
    }
}

struct Playback {
    source: String,
    frame: Frame,
    epoch: u64,
    queued: Instant,
}

pub(crate) struct PcmStream {
    pub(crate) output: PcmOutput,
    playback: Receiver<Playback>,
    epoch: Arc<AtomicU64>,
    current: u64,
    player: Option<PocketAudioPlayer>,
    frames: u64,
    confirmed: u64,
    submitted: std::collections::VecDeque<Playback>,
    last_audio: Option<Instant>,
}

fn decode(line: &[u8]) -> Option<Frame> {
    if line.len() != ENCODED_BYTES {
        return None;
    }
    let mut bytes = [0; FRAME_BYTES];
    if STANDARD.decode_slice(line, &mut bytes).ok()? != FRAME_BYTES {
        return None;
    }
    let mut frame = [0.0; INPUT_FRAME_SAMPLES];
    for (sample, pair) in frame.iter_mut().zip(bytes.chunks_exact(2)) {
        *sample = f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0;
    }
    Some(frame)
}

impl PcmStream {
    pub(crate) fn start() -> Result<Self, String> {
        let (microphone, capture) = mpsc::sync_channel::<Output>(OUTPUT_BUFFERS);
        let (play, playback) = mpsc::sync_channel::<Playback>(NATIVE_BUFFERS as usize);
        let epoch = Arc::new(AtomicU64::new(0));
        let reading_epoch = Arc::clone(&epoch);
        thread::Builder::new()
            .name("berd-call-pcm-microphone".into())
            .spawn(move || {
                while let Ok(output) = capture.recv() {
                    let record = match output.source {
                        Captured::Mic {
                            epoch,
                            muted,
                            current_epoch,
                        } if !muted.load(Ordering::SeqCst)
                            && epoch == current_epoch.load(Ordering::SeqCst) =>
                        {
                            format!("0\tpcm\t{}", STANDARD.encode(output.bytes))
                        }
                        Captured::Mic { .. } => continue,
                        Captured::Playback(source) => {
                            format!("0\tpcm_played\t{source}:{}", STANDARD.encode(output.bytes))
                        }
                    };
                    if print_flushed(&record).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| format!("could not start PCM microphone worker: {error}"))?;
        thread::Builder::new()
            .name("berd-call-pcm-playback".into())
            .spawn(move || {
                let mut stdin = std::io::stdin().lock();
                let max_line = ENCODED_BYTES + MAX_SOURCE_BYTES + 2;
                let mut line = Vec::with_capacity(max_line);
                loop {
                    line.clear();
                    let read = stdin
                        .by_ref()
                        .take(max_line as u64)
                        .read_until(b'\n', &mut line);
                    if !matches!(read, Ok(1..)) || line.pop() != Some(b'\n') {
                        break;
                    }
                    if line == b"flush" {
                        reading_epoch.fetch_add(1, Ordering::SeqCst);
                    } else if let Some(split) = line.iter().position(|byte| *byte == b':') {
                        let (source, data) = line.split_at(split);
                        if source.is_empty()
                            || source.len() > MAX_SOURCE_BYTES
                            || !source.iter().all(u8::is_ascii_alphanumeric)
                        {
                            continue;
                        }
                        if let Some(frame) = decode(&data[1..]) {
                            let _ = play.try_send(Playback {
                                source: String::from_utf8_lossy(source).into_owned(),
                                frame,
                                epoch: reading_epoch.load(Ordering::SeqCst),
                                queued: Instant::now(),
                            });
                        }
                    }
                }
                reading_epoch.fetch_add(1, Ordering::SeqCst);
            })
            .map_err(|error| format!("could not start PCM playback worker: {error}"))?;
        Ok(Self {
            output: PcmOutput(microphone),
            playback,
            epoch,
            current: 0,
            player: None,
            frames: 0,
            confirmed: 0,
            submitted: std::collections::VecDeque::new(),
            last_audio: None,
        })
    }

    pub(crate) fn clear(&mut self) -> Result<(), String> {
        self.confirm_played();
        self.player = None;
        self.submitted.clear();
        self.confirmed = 0;
        self.frames = 0;
        self.last_audio = None;
        print_flushed("0\tpcm_idle\t")
    }

    fn confirm_played(&mut self) {
        let Some(player) = &self.player else { return };
        let played = player.completed_source_frames();
        while self.confirmed + INPUT_FRAME_SAMPLES as u64 <= played {
            let Some(frame) = self.submitted.pop_front() else {
                break;
            };
            self.confirmed += INPUT_FRAME_SAMPLES as u64;
            self.output.played(&frame.source, &frame.frame);
        }
    }

    pub(crate) fn poll(&mut self, chained_playing: bool) -> Result<bool, String> {
        let current = self.epoch.load(Ordering::SeqCst);
        if current != self.current {
            self.current = current;
            self.clear()?;
        }
        self.confirm_played();
        if !chained_playing {
            while let Ok(play) = self.playback.try_recv() {
                if play.epoch != current {
                    continue;
                }
                if play.queued.elapsed() > RECENT_AUDIO {
                    self.last_audio.get_or_insert(play.queued);
                    continue;
                }
                if self.player.is_none() {
                    self.player = Some(PocketAudioPlayer::new(48000, 1.0, None)?);
                }
                let player = self.player.as_ref().expect("PCM player installed");
                player.check_health()?;
                let frames = (INPUT_FRAME_SAMPLES as u64) * NATIVE_BUFFERS;
                if self.frames.saturating_sub(player.completed_source_frames()) < frames {
                    player.enqueue(&play.frame)?;
                    self.frames += INPUT_FRAME_SAMPLES as u64;
                    self.submitted.push_back(play);
                }
                self.last_audio = Some(Instant::now());
            }
        }
        let active = self.last_audio.is_some_and(|time| {
            time.elapsed() < RECENT_AUDIO
                || self
                    .player
                    .as_ref()
                    .is_some_and(|player| !player.is_empty())
        });
        if !active && self.last_audio.take().is_some() {
            self.clear()?;
        }
        Ok(active)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_exact_signed_little_endian_frames() {
        let mut bytes = [0; FRAME_BYTES];
        bytes[..6].copy_from_slice(&[0, 128, 0, 64, 255, 127]);
        let data = STANDARD.encode(bytes);
        let frame = decode(data.as_bytes()).unwrap();
        assert_eq!(&frame[..3], &[-1.0, 0.5, 32767.0 / 32768.0]);
        assert!(decode(&data.as_bytes()[1..]).is_none());
        assert!(decode(&[b'?'; ENCODED_BYTES]).is_none());
    }
}
