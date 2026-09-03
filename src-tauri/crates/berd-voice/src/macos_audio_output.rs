//! Safe ownership wrapper for the shared macOS AVAudioUnitTimePitch PCM player.

use std::ffi::{c_char, c_void, CStr};

use crate::PcmAudioOutput;

unsafe extern "C" {
    fn berd_pocket_audio_player_create(
        sample_rate: u32,
        rate: f32,
        output_device_id: u32,
        error_out: *mut *mut c_char,
    ) -> *mut c_void;
    fn berd_pocket_audio_player_enqueue(
        player: *mut c_void,
        samples: *const f32,
        frame_count: u32,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_pocket_audio_player_completed_source_frames(player: *mut c_void) -> u64;
    fn berd_pocket_audio_player_pending_buffers(player: *mut c_void) -> u64;
    fn berd_pocket_audio_player_failed(player: *mut c_void) -> bool;
    fn berd_pocket_audio_player_stop(player: *mut c_void);
    fn berd_pocket_audio_player_release(player: *mut c_void);
    fn berd_siri_tts_free_string(value: *mut c_char);
}

pub struct PocketAudioPlayer {
    raw: *mut c_void,
    delivery_safety_frames: u64,
}

impl PocketAudioPlayer {
    pub fn new(
        sample_rate: u32,
        rate: f32,
        output_device_name: Option<&str>,
    ) -> Result<Self, String> {
        let output_device_id = output_device_name
            .map(|name| {
                coreaudio::audio_unit::macos_helpers::get_device_id_from_name(name, false)
                    .ok_or_else(|| format!("audio output not found: {name}"))
            })
            .transpose()?
            .unwrap_or(0);
        let mut error = std::ptr::null_mut();
        // SAFETY: The bridge receives a resolved CoreAudio device ID and
        // returns an owned opaque player retained until `Drop`.
        let raw = unsafe {
            berd_pocket_audio_player_create(sample_rate, rate, output_device_id, &mut error)
        };
        if raw.is_null() {
            return Err(take_error(error, "Could not start native PCM playback"));
        }
        Ok(Self {
            raw,
            delivery_safety_frames: delivery_safety_frames(sample_rate, rate),
        })
    }

    pub fn enqueue(&self, samples: &[f32]) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        let frame_count = u32::try_from(samples.len())
            .map_err(|_| "PCM audio chunk is too large to queue".to_string())?;
        let mut error = std::ptr::null_mut();
        // SAFETY: The bridge copies `frame_count` samples before returning and
        // `self.raw` remains retained for this wrapper's lifetime.
        let enqueued = unsafe {
            berd_pocket_audio_player_enqueue(self.raw, samples.as_ptr(), frame_count, &mut error)
        };
        if enqueued {
            Ok(())
        } else {
            Err(take_error(error, "Could not queue native PCM audio"))
        }
    }

    pub fn played_frames(&self) -> u64 {
        // SAFETY: `self.raw` is a live retained player. The bridge counts only
        // source buffers confirmed played back, so idle queue gaps add nothing.
        apply_delivery_safety(self.completed_source_frames(), self.delivery_safety_frames)
    }

    pub fn completed_source_frames(&self) -> u64 {
        // SAFETY: `self.raw` is a live retained player.
        unsafe { berd_pocket_audio_player_completed_source_frames(self.raw) }
    }

    pub fn is_empty(&self) -> bool {
        // SAFETY: `self.raw` is a live retained player.
        unsafe { berd_pocket_audio_player_pending_buffers(self.raw) == 0 }
    }

    pub fn check_health(&self) -> Result<(), String> {
        // SAFETY: `self.raw` is a live retained player.
        playback_health(unsafe { berd_pocket_audio_player_failed(self.raw) })
    }

    pub fn stop(&self) {
        // SAFETY: `self.raw` is a live retained player and stop is idempotent.
        unsafe { berd_pocket_audio_player_stop(self.raw) };
    }
}

impl PcmAudioOutput for PocketAudioPlayer {
    fn write(&self, samples: &[f32]) -> Result<(), String> {
        self.enqueue(samples)
    }

    fn cancel(&self) {
        self.stop();
    }

    fn is_drained(&self) -> bool {
        self.is_empty()
    }

    fn check_health(&self) -> Result<(), String> {
        PocketAudioPlayer::check_health(self)
    }

    fn played_frames(&self) -> u64 {
        PocketAudioPlayer::played_frames(self)
    }
}

fn delivery_safety_frames(sample_rate: u32, rate: f32) -> u64 {
    (f64::from(sample_rate) * 0.1 * f64::from(rate)).ceil() as u64
}

fn apply_delivery_safety(completed_source_frames: u64, safety_frames: u64) -> u64 {
    completed_source_frames.saturating_sub(safety_frames)
}

fn playback_health(failed: bool) -> Result<(), String> {
    if failed {
        Err("PCM audio output stopped unexpectedly".to_string())
    } else {
        Ok(())
    }
}

impl Drop for PocketAudioPlayer {
    fn drop(&mut self) {
        // SAFETY: This wrapper uniquely owns the retained bridge reference.
        unsafe { berd_pocket_audio_player_release(self.raw) };
    }
}

fn take_error(error: *mut c_char, fallback: &str) -> String {
    if error.is_null() {
        return fallback.to_string();
    }
    // SAFETY: Bridge errors are NUL-terminated malloc strings and are released
    // through the paired bridge function after copying.
    let message = unsafe { CStr::from_ptr(error) }
        .to_string_lossy()
        .into_owned();
    unsafe { berd_siri_tts_free_string(error) };
    message
}

#[cfg(test)]
mod tests {
    use super::{
        apply_delivery_safety, delivery_safety_frames, playback_health, PocketAudioPlayer,
    };
    use crate::wait_until_drained;
    use std::{
        sync::atomic::AtomicBool,
        time::{Duration, Instant},
    };

    #[test]
    fn delivery_safety_tracks_playback_rate_in_source_frames() {
        assert_eq!(delivery_safety_frames(24_000, 0.75), 1_800);
        assert_eq!(delivery_safety_frames(24_000, 1.0), 2_400);
        assert_eq!(delivery_safety_frames(24_000, 2.0), 4_800);
    }

    #[test]
    fn silent_queue_gaps_do_not_advance_delivery() {
        let safety = delivery_safety_frames(24_000, 1.0);
        let first_buffer_completed = 4_800;
        assert_eq!(apply_delivery_safety(first_buffer_completed, safety), 2_400);

        let after_silent_gap = first_buffer_completed;
        assert_eq!(apply_delivery_safety(after_silent_gap, safety), 2_400);

        let second_buffer_completed = 9_600;
        assert_eq!(
            apply_delivery_safety(second_buffer_completed, safety),
            7_200
        );
    }

    #[test]
    fn unexpected_output_stops_fail_playback() {
        assert!(playback_health(false).is_ok());
        assert_eq!(
            playback_health(true).expect_err("unexpected stop must fail"),
            "PCM audio output stopped unexpectedly"
        );
    }

    #[test]
    #[ignore = "opens the default CoreAudio output and queues silent PCM"]
    fn cancelling_queued_silence_returns_promptly() {
        let output = PocketAudioPlayer::new(48_000, 1.0, None).unwrap();
        output.enqueue(&vec![0.0; 48_000 * 30]).unwrap();
        let started = Instant::now();
        output.stop();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(output.is_empty());
    }

    #[test]
    #[ignore = "requires BERD_MULTICHANNEL_TEST_OUTPUT_DEVICE naming a multi-channel CoreAudio output"]
    fn configured_multichannel_output_plays_pcm() {
        let device = std::env::var("BERD_MULTICHANNEL_TEST_OUTPUT_DEVICE").unwrap();
        for frame_count in [4_800, 48_000 * 3] {
            let output = PocketAudioPlayer::new(48_000, 1.0, Some(&device)).unwrap();
            output.enqueue(&vec![0.0; frame_count]).unwrap();
            assert!(
                wait_until_drained(&output, &AtomicBool::new(true), Duration::from_millis(5),)
                    .unwrap()
            );
        }
    }
}
