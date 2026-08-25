#[cfg(target_os = "macos")]
use objc2_avf_audio::{AVAudioApplication, AVAudioApplicationRecordPermission};
use serde::Serialize;
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MicrophonePermissionStatus {
    NotDetermined,
    Denied,
    Authorized,
    Unknown,
}

#[cfg(target_os = "macos")]
fn status_from_record_permission(
    status: AVAudioApplicationRecordPermission,
) -> MicrophonePermissionStatus {
    match status {
        AVAudioApplicationRecordPermission::Undetermined => {
            MicrophonePermissionStatus::NotDetermined
        }
        AVAudioApplicationRecordPermission::Denied => MicrophonePermissionStatus::Denied,
        AVAudioApplicationRecordPermission::Granted => MicrophonePermissionStatus::Authorized,
        _ => MicrophonePermissionStatus::Unknown,
    }
}

#[tauri::command]
pub fn get_microphone_permission_status() -> MicrophonePermissionStatus {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: Berd's minimum macOS version is 14.0, where
        // AVAudioApplication and recordPermission are public API.
        let application = unsafe { AVAudioApplication::sharedInstance() };
        return status_from_record_permission(unsafe { application.recordPermission() });
    }

    #[cfg(not(target_os = "macos"))]
    MicrophonePermissionStatus::Unknown
}

#[tauri::command]
pub fn open_microphone_privacy_settings(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return app
        .opener()
        .open_url(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            None::<&str>,
        )
        .map_err(|error| format!("Could not open Microphone settings: {error}"));

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Microphone privacy settings are only available on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn maps_av_audio_record_permission_values() {
        assert_eq!(
            status_from_record_permission(AVAudioApplicationRecordPermission::Undetermined),
            MicrophonePermissionStatus::NotDetermined
        );
        assert_eq!(
            status_from_record_permission(AVAudioApplicationRecordPermission::Denied),
            MicrophonePermissionStatus::Denied
        );
        assert_eq!(
            status_from_record_permission(AVAudioApplicationRecordPermission::Granted),
            MicrophonePermissionStatus::Authorized
        );
        assert_eq!(
            status_from_record_permission(AVAudioApplicationRecordPermission(99)),
            MicrophonePermissionStatus::Unknown
        );
    }
}
