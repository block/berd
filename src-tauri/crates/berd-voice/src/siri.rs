//! Safe sirittsd synthesis wrapper that emits PCM without owning an audio device.

use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use crate::{TtsBackend, TtsOutcome, TtsPcmSpec};

const SIRI_PCM_SAMPLE_RATE: u32 = 48_000;
const PCM_CHANNEL_CAPACITY: usize = 8;

unsafe extern "C" {
    fn berd_siri_tts_validate_voice(
        language: *const c_char,
        voice_name: *const c_char,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_siri_tts_synthesize_pcm(
        text: *const c_char,
        language: *const c_char,
        voice_name: *const c_char,
        rate: f32,
        should_stop: unsafe extern "C" fn(*mut c_void) -> bool,
        pcm_frames: unsafe extern "C" fn(*const f32, u32, *mut c_void) -> bool,
        context: *mut c_void,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_siri_tts_free_string(value: *mut c_char);
}

#[derive(Clone, Debug)]
pub struct SiriTts {
    language: CString,
    voice_name: CString,
    rate: f32,
}

impl SiriTts {
    pub fn new(language: &str, voice_name: &str, rate: f32) -> Result<Self, String> {
        if language.trim().is_empty() || voice_name.trim().is_empty() {
            return Err("Siri voice and language must be nonempty".into());
        }
        if !rate.is_finite() || !(0.5..=2.0).contains(&rate) {
            return Err("Siri rate must be between 0.5 and 2.0".into());
        }
        let language = CString::new(language).map_err(|_| "Siri language contains NUL")?;
        let voice_name = CString::new(voice_name).map_err(|_| "Siri voice contains NUL")?;
        let mut error = std::ptr::null_mut();
        // SAFETY: Both strings are NUL-terminated and live for this call.
        if !unsafe {
            berd_siri_tts_validate_voice(language.as_ptr(), voice_name.as_ptr(), &mut error)
        } {
            return Err(take_error(error, "Siri voice is not installed"));
        }
        Ok(Self {
            language,
            voice_name,
            rate,
        })
    }
}

struct CallbackContext<'a> {
    active: &'a AtomicBool,
    callback_cancelled: &'a AtomicBool,
    sender: mpsc::SyncSender<Vec<f32>>,
}

unsafe extern "C" fn should_stop(context: *mut c_void) -> bool {
    // SAFETY: The native call is scoped to the lifetime of this context.
    let context = unsafe { &*(context.cast::<CallbackContext<'_>>()) };
    !context.active.load(Ordering::SeqCst) || context.callback_cancelled.load(Ordering::SeqCst)
}

unsafe extern "C" fn receive_pcm(
    samples: *const f32,
    frame_count: u32,
    context: *mut c_void,
) -> bool {
    // SAFETY: The bridge guarantees `frame_count` valid samples for this call.
    let frames = unsafe { std::slice::from_raw_parts(samples, frame_count as usize) };
    // SAFETY: The native call is scoped to the lifetime of this context.
    let context = unsafe { &*(context.cast::<CallbackContext<'_>>()) };
    context.active.load(Ordering::SeqCst) && context.sender.send(frames.to_vec()).is_ok()
}

impl TtsBackend for SiriTts {
    fn pcm_spec(&self) -> TtsPcmSpec {
        TtsPcmSpec {
            sample_rate: SIRI_PCM_SAMPLE_RATE,
            playback_rate: 1.0,
        }
    }

    fn synthesize(
        &self,
        text: &str,
        active: &AtomicBool,
        on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
    ) -> Result<TtsOutcome, String> {
        if !active.load(Ordering::SeqCst) {
            return Ok(TtsOutcome::Cancelled);
        }
        let text = CString::new(text).map_err(|_| "Siri text contains NUL")?;
        let (sender, receiver) = mpsc::sync_channel(PCM_CHANNEL_CAPACITY);
        let callback_cancelled = AtomicBool::new(false);
        let language = self.language.clone();
        let voice_name = self.voice_name.clone();
        let rate = self.rate;
        let result = std::thread::scope(|scope| {
            let mut context = CallbackContext {
                active,
                callback_cancelled: &callback_cancelled,
                sender,
            };
            let native = scope.spawn(move || {
                let mut error = std::ptr::null_mut();
                // SAFETY: All pointers remain valid until this blocking native
                // call returns, and callbacks only borrow the scoped context.
                let completed = unsafe {
                    berd_siri_tts_synthesize_pcm(
                        text.as_ptr(),
                        language.as_ptr(),
                        voice_name.as_ptr(),
                        rate,
                        should_stop,
                        receive_pcm,
                        (&mut context as *mut CallbackContext<'_>).cast(),
                        &mut error,
                    )
                };
                if completed {
                    Ok(())
                } else {
                    Err(take_error(error, "Siri synthesis failed"))
                }
            });
            let mut callback_error = None;
            while let Ok(frames) = receiver.recv() {
                if callback_error.is_none() {
                    if let Err(error) = on_frames(&frames) {
                        callback_error = Some(error);
                        callback_cancelled.store(true, Ordering::SeqCst);
                    }
                }
            }
            let native = native
                .join()
                .map_err(|_| "Siri synthesis thread panicked".to_string())?;
            if let Some(error) = callback_error {
                Err(error)
            } else {
                native
            }
        });
        result?;
        Ok(if active.load(Ordering::SeqCst) {
            TtsOutcome::Completed
        } else {
            TtsOutcome::Cancelled
        })
    }
}

fn take_error(error: *mut c_char, fallback: &str) -> String {
    if error.is_null() {
        return fallback.to_string();
    }
    // SAFETY: Bridge errors are malloc strings paired with this free function.
    let message = unsafe { CStr::from_ptr(error) }
        .to_string_lossy()
        .into_owned();
    unsafe { berd_siri_tts_free_string(error) };
    message
}

#[cfg(test)]
mod tests {
    use super::SiriTts;
    use crate::{TtsBackend, TtsOutcome};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    #[test]
    fn exact_uninstalled_voice_is_rejected_without_synthesis() {
        let error = SiriTts::new("en-US", "__berd_voice_does_not_exist__", 1.0).unwrap_err();
        assert!(error.contains("not installed") || error.contains("validating Siri voice"));
    }

    #[test]
    #[ignore = "requires BERD_SIRI_TEST_VOICE and invokes private sirittsd synthesis"]
    fn installed_voice_synthesizes_normalized_pcm_without_an_output_device() {
        let voice = std::env::var("BERD_SIRI_TEST_VOICE").unwrap();
        let language = std::env::var("BERD_SIRI_TEST_LANGUAGE").unwrap_or_else(|_| "en-US".into());
        let backend = SiriTts::new(&language, &voice, 1.0).unwrap();
        let mut frames = Vec::new();
        let outcome = backend
            .synthesize(
                "This is an in-memory Siri synthesis test.",
                &AtomicBool::new(true),
                &mut |chunk| {
                    frames.extend_from_slice(chunk);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(outcome, TtsOutcome::Completed);
        assert_eq!(backend.pcm_spec().sample_rate, 48_000);
        assert!(!frames.is_empty());
        assert!(frames.iter().all(|sample| sample.is_finite()));
    }

    #[test]
    #[ignore = "requires BERD_SIRI_TEST_VOICE and invokes private sirittsd synthesis"]
    fn cancellation_during_pcm_delivery_returns_promptly() {
        let voice = std::env::var("BERD_SIRI_TEST_VOICE").unwrap();
        let language = std::env::var("BERD_SIRI_TEST_LANGUAGE").unwrap_or_else(|_| "en-US".into());
        let backend = SiriTts::new(&language, &voice, 1.0).unwrap();
        let active = AtomicBool::new(true);
        let started = Instant::now();
        let outcome = backend
            .synthesize(
                "This deliberately long sentence keeps Siri synthesis active long enough to test cancellation while decoded audio is crossing the native boundary and must return without leaving the worker or bounded channel stuck.",
                &active,
                &mut |chunk| {
                    assert!(!chunk.is_empty());
                    active.store(false, Ordering::SeqCst);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(outcome, TtsOutcome::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
