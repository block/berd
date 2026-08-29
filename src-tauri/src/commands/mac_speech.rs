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
        if !berd_voice::mac_speech::mac_speech_is_supported() {
            return Ok(unsupported_status());
        }
        let status = berd_voice::mac_speech::mac_speech_status()?;
        Ok(MacSpeechStatus {
            supported: status.supported,
            unavailable_reason: (!status.supported)
                .then(|| "Apple speech recognition is unavailable.".to_string()),
            locale: status.locale.unwrap_or_default(),
            locale_supported: status.locale_supported,
            model_installed: status.ready,
            installing: status.model_status == "downloading",
            progress: None,
            error: None,
            revision: STATUS_REVISION.load(Ordering::Acquire),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(unsupported_status())
    }
}

pub async fn status_async() -> Result<MacSpeechStatus, String> {
    tauri::async_runtime::spawn_blocking(status)
        .await
        .map_err(|error| format!("read macOS speech status task failed: {error}"))?
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
async fn emit_terminal_install_failure(app: &AppHandle, error: String) -> String {
    let next = terminal_install_failure(status_async().await, error.clone());
    let _ = app.emit(STATUS_EVENT, next);
    error
}

#[tauri::command]
pub async fn get_mac_speech_status() -> Result<MacSpeechStatus, String> {
    status_async().await
}

#[tauri::command]
pub async fn install_mac_speech_model(app: AppHandle) -> Result<MacSpeechStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let progress_app = app.clone();
        let result = match tauri::async_runtime::spawn_blocking(move || {
            berd_voice::mac_speech::install_mac_speech_model(move |value| {
                let mut next = status().unwrap_or_else(|error| MacSpeechStatus {
                    error: Some(error),
                    ..unsupported_status()
                });
                next.installing = true;
                next.progress = Some(value);
                next.revision = STATUS_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
                let _ = progress_app.emit(STATUS_EVENT, next);
            })
        })
        .await
        {
            Ok(result) => result,
            Err(error) => {
                let error = format!("install macOS speech model task failed: {error}");
                return Err(emit_terminal_install_failure(&app, error).await);
            }
        };
        if let Err(error) = result {
            return Err(emit_terminal_install_failure(&app, error).await);
        }
        let mut next = match status_async().await {
            Ok(next) => next,
            Err(error) => return Err(emit_terminal_install_failure(&app, error).await),
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
