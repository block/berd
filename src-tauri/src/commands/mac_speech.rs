//! macOS 26 on-device speech recognition and model management.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::Emitter;

#[cfg(target_os = "macos")]
const STATUS_EVENT: &str = "mac-speech:status";
static STATUS_REVISION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacSpeechStatus {
    pub supported: bool,
    pub unavailable_reason: Option<String>,
    pub locale: String,
    pub locale_supported: bool,
    pub model_installed: bool,
    pub installing: bool,
    pub progress: Option<f64>,
    pub error: Option<String>,
    pub revision: u64,
}

#[cfg(target_os = "macos")]
mod bridge {
    use std::{
        ffi::{c_char, c_void, CStr},
        ptr,
    };

    use serde::Deserialize;
    use tokio::sync::mpsc;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BridgeStatus {
        supported: bool,
        locale: Option<String>,
        locale_supported: bool,
        model_status: String,
        ready: bool,
    }

    #[derive(Debug)]
    pub enum RecognitionEvent {
        Interim,
        Final(String),
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
            event: Option<unsafe extern "C" fn(i32, *const c_char, *mut c_void)>,
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

    pub fn supported() -> bool {
        unsafe { berd_macos_stt_is_supported() }
    }

    pub fn status() -> Result<super::MacSpeechStatus, String> {
        if !supported() {
            return Ok(super::unsupported_status());
        }
        let mut error = ptr::null_mut();
        let json = unsafe { berd_macos_stt_status_json(ptr::null(), &mut error) };
        let json = take_string(json).ok_or_else(|| {
            take_error(error, "Could not read the macOS speech recognition status.")
        })?;
        let status: BridgeStatus = serde_json::from_str(&json)
            .map_err(|error| format!("decode macOS speech status: {error}"))?;
        Ok(super::MacSpeechStatus {
            supported: status.supported,
            unavailable_reason: (!status.supported)
                .then(|| "Apple speech recognition is unavailable.".to_string()),
            locale: status.locale.unwrap_or_default(),
            locale_supported: status.locale_supported,
            model_installed: status.ready,
            installing: status.model_status == "downloading",
            progress: None,
            error: None,
            revision: super::STATUS_REVISION.load(std::sync::atomic::Ordering::Acquire),
        })
    }

    pub fn install(
        progress: unsafe extern "C" fn(f64, *mut c_void),
        context: *mut c_void,
    ) -> Result<(), String> {
        let mut error = ptr::null_mut();
        let installed = unsafe {
            berd_macos_stt_install_model(ptr::null(), Some(progress), context, &mut error)
        };
        if installed {
            Ok(())
        } else {
            Err(take_error(
                error,
                "Could not install the macOS speech recognition model.",
            ))
        }
    }

    struct RecognitionContext {
        events: mpsc::UnboundedSender<RecognitionEvent>,
    }

    unsafe extern "C" fn recognition_event(code: i32, text: *const c_char, context: *mut c_void) {
        if context.is_null() {
            return;
        }
        let context = unsafe { &*(context.cast::<RecognitionContext>()) };
        let text = (!text.is_null())
            .then(|| unsafe { CStr::from_ptr(text).to_string_lossy().into_owned() });
        let event = match code {
            0 => RecognitionEvent::Interim,
            1 => RecognitionEvent::Final(text.unwrap_or_default()),
            2 => RecognitionEvent::Finished,
            3 => RecognitionEvent::Failed(
                text.unwrap_or_else(|| "macOS speech recognition failed.".to_string()),
            ),
            _ => return,
        };
        let _ = context.events.send(event);
    }

    pub struct RecognitionSession {
        handle: *mut c_void,
        context: *mut RecognitionContext,
    }

    impl RecognitionSession {
        pub fn new(events: mpsc::UnboundedSender<RecognitionEvent>) -> Result<Self, String> {
            let context = Box::into_raw(Box::new(RecognitionContext { events }));
            let mut error = ptr::null_mut();
            let handle = unsafe {
                berd_macos_stt_create(
                    ptr::null(),
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
            Ok(Self { handle, context })
        }

        pub fn push(&mut self, samples: &[f32]) -> Result<(), String> {
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

        pub fn finish(&mut self) -> Result<(), String> {
            let mut error = ptr::null_mut();
            let finished = unsafe { berd_macos_stt_finish(self.handle, 5.0, &mut error) };
            if finished {
                Ok(())
            } else {
                Err(take_error(
                    error,
                    "macOS speech recognition did not finish.",
                ))
            }
        }

        pub fn cancel(&mut self) {
            unsafe { berd_macos_stt_cancel(self.handle) };
        }
    }

    impl Drop for RecognitionSession {
        fn drop(&mut self) {
            unsafe {
                berd_macos_stt_release(self.handle);
                drop(Box::from_raw(self.context));
            }
        }
    }
}

fn unsupported_status() -> MacSpeechStatus {
    MacSpeechStatus {
        supported: false,
        unavailable_reason: Some("Apple speech recognition is unavailable.".to_string()),
        locale: String::new(),
        locale_supported: false,
        model_installed: false,
        installing: false,
        progress: None,
        error: None,
        revision: STATUS_REVISION.load(Ordering::Acquire),
    }
}

pub fn status() -> Result<MacSpeechStatus, String> {
    #[cfg(target_os = "macos")]
    {
        bridge::status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(unsupported_status())
    }
}

#[cfg(any(target_os = "macos", test))]
fn terminal_install_failure(
    current_status: Result<MacSpeechStatus, String>,
    error: String,
) -> MacSpeechStatus {
    let mut next = current_status.unwrap_or_else(|_| unsupported_status());
    next.installing = false;
    next.progress = None;
    next.error = Some(error);
    next.revision = STATUS_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    next
}

#[cfg(target_os = "macos")]
fn emit_terminal_install_failure(app: &AppHandle, error: String) -> String {
    let next = terminal_install_failure(status(), error.clone());
    let _ = app.emit(STATUS_EVENT, next);
    error
}

#[tauri::command]
pub fn get_mac_speech_status() -> Result<MacSpeechStatus, String> {
    status()
}

#[tauri::command]
pub async fn install_mac_speech_model(app: AppHandle) -> Result<MacSpeechStatus, String> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::c_void;

        struct ProgressContext {
            app: AppHandle,
        }

        unsafe extern "C" fn progress(value: f64, context: *mut c_void) {
            if context.is_null() {
                return;
            }
            let context = unsafe { &*(context.cast::<ProgressContext>()) };
            let mut next = status().unwrap_or_else(|error| MacSpeechStatus {
                error: Some(error),
                ..unsupported_status()
            });
            next.installing = true;
            next.progress = Some(value);
            next.revision = STATUS_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
            let _ = context.app.emit(STATUS_EVENT, next);
        }

        let context = Box::into_raw(Box::new(ProgressContext { app: app.clone() }));
        // Raw pointers are intentionally not `Send`; move the address across
        // the blocking-task boundary and reconstruct it only on that thread.
        let context_address = context as usize;
        let result = match tauri::async_runtime::spawn_blocking(move || {
            let context = context_address as *mut ProgressContext;
            let result = bridge::install(progress, context.cast());
            unsafe { drop(Box::from_raw(context)) };
            result
        })
        .await
        {
            Ok(result) => result,
            Err(error) => {
                let error = format!("install macOS speech model task failed: {error}");
                return Err(emit_terminal_install_failure(&app, error));
            }
        };
        if let Err(error) = result {
            return Err(emit_terminal_install_failure(&app, error));
        }
        let mut next = match status() {
            Ok(next) => next,
            Err(error) => return Err(emit_terminal_install_failure(&app, error)),
        };
        next.revision = STATUS_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
        let _ = app.emit(STATUS_EVENT, next.clone());
        Ok(next)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("macOS speech recognition requires macOS 26 or later.".to_string())
    }
}

#[cfg(target_os = "macos")]
pub use bridge::{RecognitionEvent, RecognitionSession};

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn unsupported_platform_status_is_stable() {
        let status = status().expect("cross-platform status");
        assert!(!status.supported);
        assert!(!status.locale_supported);
        assert!(!status.model_installed);
        assert_eq!(status.progress, None);
        assert_eq!(
            status.unavailable_reason.as_deref(),
            Some("Apple speech recognition is unavailable."),
        );
    }

    #[test]
    fn install_failure_is_terminal_and_retryable() {
        let before = STATUS_REVISION.load(Ordering::Acquire);
        let status = terminal_install_failure(
            Ok(MacSpeechStatus {
                supported: true,
                unavailable_reason: None,
                locale: "en-US".to_string(),
                locale_supported: true,
                model_installed: false,
                installing: true,
                progress: Some(0.5),
                error: None,
                revision: before,
            }),
            "download failed".to_string(),
        );

        assert!(!status.installing);
        assert_eq!(status.progress, None);
        assert_eq!(status.error.as_deref(), Some("download failed"));
        assert!(status.revision > before);
    }
}
