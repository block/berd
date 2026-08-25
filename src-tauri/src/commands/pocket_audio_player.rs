//! Safe ownership wrapper for the macOS AVAudioUnitTimePitch Pocket player.

use std::ffi::{c_char, c_void, CStr, CString};

unsafe extern "C" {
    fn berd_pocket_audio_player_create(
        sample_rate: u32,
        rate: f32,
        output_device_name: *const c_char,
        error_out: *mut *mut c_char,
    ) -> *mut c_void;
    fn berd_pocket_audio_player_enqueue(
        player: *mut c_void,
        samples: *const f32,
        frame_count: u32,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_pocket_audio_player_played_frames(player: *mut c_void) -> u64;
    fn berd_pocket_audio_player_pending_buffers(player: *mut c_void) -> u64;
    fn berd_pocket_audio_player_stop(player: *mut c_void);
    fn berd_pocket_audio_player_release(player: *mut c_void);
    fn berd_siri_tts_free_string(value: *mut c_char);
}

pub(super) struct PocketAudioPlayer {
    raw: *mut c_void,
}

impl PocketAudioPlayer {
    pub(super) fn new(
        sample_rate: u32,
        rate: f32,
        output_device_name: Option<&str>,
    ) -> Result<Self, String> {
        let output_device_name = output_device_name
            .map(CString::new)
            .transpose()
            .map_err(|_| "Pocket output device name cannot contain NUL bytes".to_string())?;
        let mut error = std::ptr::null_mut();
        // SAFETY: The bridge copies the optional name synchronously and returns
        // an owned opaque player retained until `Drop`.
        let raw = unsafe {
            berd_pocket_audio_player_create(
                sample_rate,
                rate,
                output_device_name
                    .as_ref()
                    .map_or(std::ptr::null(), |name| name.as_ptr()),
                &mut error,
            )
        };
        if raw.is_null() {
            return Err(take_error(error, "Could not start native Pocket playback"));
        }
        Ok(Self { raw })
    }

    pub(super) fn enqueue(&self, samples: &[f32]) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        let frame_count = u32::try_from(samples.len())
            .map_err(|_| "Pocket audio chunk is too large to queue".to_string())?;
        let mut error = std::ptr::null_mut();
        // SAFETY: The bridge copies `frame_count` samples before returning and
        // `self.raw` remains retained for this wrapper's lifetime.
        let enqueued = unsafe {
            berd_pocket_audio_player_enqueue(self.raw, samples.as_ptr(), frame_count, &mut error)
        };
        if enqueued {
            Ok(())
        } else {
            Err(take_error(error, "Could not queue native Pocket audio"))
        }
    }

    pub(super) fn played_frames(&self) -> u64 {
        // SAFETY: `self.raw` is a live retained player.
        unsafe { berd_pocket_audio_player_played_frames(self.raw) }
    }

    pub(super) fn is_empty(&self) -> bool {
        // SAFETY: `self.raw` is a live retained player.
        unsafe { berd_pocket_audio_player_pending_buffers(self.raw) == 0 }
    }

    pub(super) fn stop(&self) {
        // SAFETY: `self.raw` is a live retained player and stop is idempotent.
        unsafe { berd_pocket_audio_player_stop(self.raw) };
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
