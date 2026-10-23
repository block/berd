//! Safe macOS SpeechTranscriber model and recognition primitives.

use std::{
    ffi::{c_char, c_void, CStr, CString},
    ptr,
    sync::atomic::{AtomicBool, Ordering},
};

use serde::Deserialize;
use tokio::sync::mpsc;

use crate::MAC_SPEECH_RECOGNITION_FINISH_TIMEOUT_SECONDS;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MacSpeechEngineStatus {
    pub supported: bool,
    pub locale: Option<String>,
    pub locale_supported: bool,
    pub model_status: String,
    pub ready: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum MacSpeechRecognitionEvent {
    /// A final result and where its audio ends, in 48 kHz samples of pushed input.
    Final(String, Option<u64>),
    Finished,
    Failed(String),
}

unsafe extern "C" {
    fn berd_macos_stt_is_supported() -> bool;
    fn berd_macos_stt_status_json(
        locale: *const c_char,
        error_out: *mut *mut c_char,
    ) -> *mut c_char;
    fn berd_macos_stt_install_model(
        locale: *const c_char,
        progress: Option<unsafe extern "C" fn(f64, *mut c_void)>,
        context: *mut c_void,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_macos_stt_create(
        locale: *const c_char,
        hints_json: *const c_char,
        event: Option<unsafe extern "C" fn(i32, *const c_char, f64, *mut c_void)>,
        context: *mut c_void,
        error_out: *mut *mut c_char,
    ) -> *mut c_void;
    fn berd_macos_stt_push(
        handle: *mut c_void,
        samples: *const f32,
        count: isize,
        sample_rate: f64,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_macos_stt_finish(
        handle: *mut c_void,
        timeout_seconds: f64,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_macos_stt_cancel(handle: *mut c_void);
    fn berd_macos_stt_release(handle: *mut c_void);
    fn berd_macos_stt_free_string(value: *mut c_char);
}

fn take_string(value: *mut c_char) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let result = unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned();
    unsafe { berd_macos_stt_free_string(value) };
    Some(result)
}

fn take_error(value: *mut c_char, fallback: &str) -> String {
    take_string(value).unwrap_or_else(|| fallback.to_string())
}

pub fn mac_speech_is_supported() -> bool {
    unsafe { berd_macos_stt_is_supported() }
}

/// Reads the engine status for the current system locale.
pub fn mac_speech_status() -> Result<MacSpeechEngineStatus, String> {
    let mut error = ptr::null_mut();
    let json = unsafe { berd_macos_stt_status_json(ptr::null(), &mut error) };
    let json = take_string(json)
        .ok_or_else(|| take_error(error, "Could not read the macOS speech recognition status."))?;
    decode_status(&json)
}

fn decode_status(json: &str) -> Result<MacSpeechEngineStatus, String> {
    serde_json::from_str(json).map_err(|error| format!("decode macOS speech status: {error}"))
}

struct ProgressContext {
    callback: Box<dyn Fn(f64) + Send + Sync>,
    panicked: AtomicBool,
}

unsafe extern "C" fn install_progress(value: f64, context: *mut c_void) {
    if context.is_null() {
        return;
    }
    let context = unsafe { &*context.cast::<ProgressContext>() };
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (context.callback)(value);
    }))
    .is_err()
    {
        context.panicked.store(true, Ordering::Release);
    }
}

/// Blocks while installing the current locale's on-device speech model.
///
/// The progress callback remains alive for the entire native operation and is
/// never retained after this function returns.
pub fn install_mac_speech_model(
    progress: impl Fn(f64) + Send + Sync + 'static,
) -> Result<(), String> {
    let context = Box::into_raw(Box::new(ProgressContext {
        callback: Box::new(progress),
        panicked: AtomicBool::new(false),
    }));
    let mut error = ptr::null_mut();
    let installed = unsafe {
        berd_macos_stt_install_model(
            ptr::null(),
            Some(install_progress),
            context.cast(),
            &mut error,
        )
    };
    let callback_panicked = unsafe { (*context).panicked.load(Ordering::Acquire) };
    unsafe { drop(Box::from_raw(context)) };
    let install_error = (!installed).then(|| {
        take_error(
            error,
            "Could not install the macOS speech recognition model.",
        )
    });
    if callback_panicked {
        Err("macOS speech model progress callback panicked.".to_string())
    } else if let Some(error) = install_error {
        Err(error)
    } else {
        Ok(())
    }
}

struct RecognitionContext {
    events: mpsc::UnboundedSender<MacSpeechRecognitionEvent>,
}

fn map_recognition_event(
    code: i32,
    text: Option<String>,
    end_seconds: f64,
) -> Option<MacSpeechRecognitionEvent> {
    match code {
        1 => Some(MacSpeechRecognitionEvent::Final(
            text.unwrap_or_default(),
            (end_seconds.is_finite() && end_seconds >= 0.0)
                .then(|| (end_seconds * 48_000.0).round() as u64),
        )),
        2 => Some(MacSpeechRecognitionEvent::Finished),
        3 => Some(MacSpeechRecognitionEvent::Failed(text.unwrap_or_else(
            || "macOS speech recognition failed.".to_string(),
        ))),
        _ => None,
    }
}

unsafe extern "C" fn recognition_event(
    code: i32,
    text: *const c_char,
    end_seconds: f64,
    context: *mut c_void,
) {
    if context.is_null() {
        return;
    }
    let context = unsafe { &*context.cast::<RecognitionContext>() };
    let text =
        (!text.is_null()).then(|| unsafe { CStr::from_ptr(text).to_string_lossy().into_owned() });
    if let Some(event) = map_recognition_event(code, text, end_seconds) {
        let _ = context.events.send(event);
    }
}

/// A concrete macOS SpeechTranscriber session for mono Float32 PCM.
pub struct MacSpeechRecognizer {
    handle: *mut c_void,
    context: *mut RecognitionContext,
}

impl MacSpeechRecognizer {
    /// Creates a recognizer for the current system locale.
    pub fn new() -> Result<(Self, mpsc::UnboundedReceiver<MacSpeechRecognitionEvent>), String> {
        Self::with_hints(&[])
    }

    /// Biases recognition toward these phrases without restricting its vocabulary.
    pub fn with_hints(
        hints: &[String],
    ) -> Result<(Self, mpsc::UnboundedReceiver<MacSpeechRecognitionEvent>), String> {
        let hints_json =
            CString::new(serde_json::to_string(hints).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        let (events, receiver) = mpsc::unbounded_channel();
        let context = Box::into_raw(Box::new(RecognitionContext { events }));
        let mut error = ptr::null_mut();
        let handle = unsafe {
            berd_macos_stt_create(
                ptr::null(),
                hints_json.as_ptr(),
                Some(recognition_event),
                context.cast(),
                &mut error,
            )
        };
        if handle.is_null() {
            unsafe { drop(Box::from_raw(context)) };
            return Err(take_error(
                error,
                "Could not start macOS speech recognition.",
            ));
        }
        Ok((Self { handle, context }, receiver))
    }

    /// Synchronously copies one batch of 48 kHz mono Float32 PCM into the
    /// recognizer's native bounded input stream.
    pub fn push_48khz_mono_f32(&mut self, samples: &[f32]) -> Result<(), String> {
        let mut error = ptr::null_mut();
        let pushed = unsafe {
            berd_macos_stt_push(
                self.handle,
                samples.as_ptr(),
                samples.len() as isize,
                48_000.0,
                &mut error,
            )
        };
        if pushed {
            Ok(())
        } else {
            Err(take_error(
                error,
                "Could not send audio to macOS speech recognition.",
            ))
        }
    }

    /// Finalizes input and waits up to five seconds for native completion.
    pub fn finish(&mut self) -> Result<(), String> {
        let mut error = ptr::null_mut();
        let finished = unsafe {
            berd_macos_stt_finish(
                self.handle,
                MAC_SPEECH_RECOGNITION_FINISH_TIMEOUT_SECONDS as f64,
                &mut error,
            )
        };
        if finished {
            Ok(())
        } else {
            Err(take_error(
                error,
                "macOS speech recognition did not finish.",
            ))
        }
    }

    /// Stops recognition and suppresses any later callbacks. Idempotent.
    pub fn cancel(&mut self) {
        unsafe { berd_macos_stt_cancel(self.handle) };
    }
}

impl Drop for MacSpeechRecognizer {
    fn drop(&mut self) {
        unsafe {
            berd_macos_stt_release(self.handle);
            drop(Box::from_raw(self.context));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn native_event_codes_map_without_provider_types_escaping() {
        assert_eq!(
            map_recognition_event(1, Some("hello".to_string()), 1.5),
            Some(MacSpeechRecognitionEvent::Final(
                "hello".to_string(),
                Some(72_000)
            ))
        );
        assert_eq!(
            map_recognition_event(1, Some("hello".to_string()), f64::NAN),
            Some(MacSpeechRecognitionEvent::Final("hello".to_string(), None))
        );
        assert_eq!(
            map_recognition_event(2, None, f64::NAN),
            Some(MacSpeechRecognitionEvent::Finished)
        );
        assert_eq!(
            map_recognition_event(3, None, f64::NAN),
            Some(MacSpeechRecognitionEvent::Failed(
                "macOS speech recognition failed.".to_string()
            ))
        );
        assert_eq!(map_recognition_event(99, None, f64::NAN), None);
    }

    #[test]
    fn native_status_maps_without_tauri_projection() {
        assert_eq!(
            decode_status(
                r#"{"supported":true,"locale":"en-US","localeSupported":true,"modelStatus":"downloading","ready":false}"#
            )
            .unwrap(),
            MacSpeechEngineStatus {
                supported: true,
                locale: Some("en-US".to_string()),
                locale_supported: true,
                model_status: "downloading".to_string(),
                ready: false,
            }
        );
    }

    #[test]
    #[ignore = "runs on-device macOS speech recognition over `say` output"]
    fn final_end_is_measured_on_the_pushed_audio_timeline() {
        let path = std::env::temp_dir().join("berd-call-final-end.wav");
        let status = std::process::Command::new("say")
            .args(["--data-format=LEF32@48000", "-o"])
            .arg(&path)
            .arg("The quick brown fox jumps over the lazy dog.")
            .status()
            .unwrap();
        assert!(status.success());
        let wav = std::fs::read(&path).unwrap();
        let data = wav.windows(4).position(|w| w == b"data").unwrap() + 8;
        let speech: Vec<f32> = wav[data..]
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        let lead = vec![0.0; 48_000];
        let (mut recognizer, mut events) = MacSpeechRecognizer::new().unwrap();
        for part in [&lead, &speech, &lead] {
            for chunk in part.chunks(960) {
                recognizer.push_48khz_mono_f32(chunk).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        recognizer.finish().unwrap();
        let mut ends = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let MacSpeechRecognitionEvent::Final(_, end) = event {
                ends.push(end.unwrap());
            }
        }
        let (start, stop) = (lead.len() as u64, (lead.len() + speech.len()) as u64);
        let last = *ends.last().expect("a final");
        // Apple ends a final about 0.3 s after the last sound.
        assert!(
            last > start && last <= stop + 24_000,
            "{ends:?} not within {start}..{stop}"
        );
    }

    #[test]
    fn callback_is_safe_after_the_event_receiver_is_dropped() {
        let (events, receiver) = mpsc::unbounded_channel();
        drop(receiver);
        let context = Box::into_raw(Box::new(RecognitionContext { events }));
        let text = CString::new("ignored").unwrap();
        unsafe { recognition_event(1, text.as_ptr(), f64::NAN, context.cast()) };
        unsafe { drop(Box::from_raw(context)) };
    }

    #[test]
    fn progress_callback_cannot_unwind_across_swift() {
        let context = Box::into_raw(Box::new(ProgressContext {
            callback: Box::new(|_| panic!("test panic")),
            panicked: AtomicBool::new(false),
        }));
        unsafe { install_progress(0.5, context.cast()) };
        assert!(unsafe { (*context).panicked.load(Ordering::Acquire) });
        unsafe { drop(Box::from_raw(context)) };
    }
}
