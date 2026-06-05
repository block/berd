#[cfg(target_os = "macos")]
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
const COMPLETION_NOTIFICATION_CLICKED_EVENT: &str = "completion-notification-clicked";

#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletionNotificationClickedPayload {
    session_id: String,
}

#[tauri::command]
pub fn show_completion_notification(
    app: AppHandle,
    session_id: String,
    body: String,
    sound: Option<String>,
) -> Result<(), String> {
    show_platform_completion_notification(app, session_id, body, sound)
}

#[cfg(target_os = "macos")]
fn show_platform_completion_notification(
    app: AppHandle,
    session_id: String,
    body: String,
    sound: Option<String>,
) -> Result<(), String> {
    std::thread::spawn(move || {
        if let Err(error) = show_macos_completion_notification(app, session_id, body, sound) {
            log::warn!("Failed to show completion notification: {error}");
        }
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn show_macos_completion_notification(
    app: AppHandle,
    session_id: String,
    body: String,
    sound: Option<String>,
) -> Result<(), String> {
    use mac_notification_sys::{set_application, Notification, NotificationResponse};

    let bundle_id = if tauri::is_dev() {
        "com.apple.Terminal".to_string()
    } else {
        app.config().identifier.clone()
    };
    let _ = set_application(&bundle_id);

    let mut notification = Notification::new();
    notification
        .title("Goose")
        .message(&body)
        .wait_for_click(true);

    configure_macos_completion_notification_sound(&mut notification, &app, sound.as_deref());

    match notification.send().map_err(|error| error.to_string())? {
        NotificationResponse::Click | NotificationResponse::ActionButton(_) => {
            emit_completion_notification_clicked(&app, session_id);
        }
        NotificationResponse::None
        | NotificationResponse::CloseButton(_)
        | NotificationResponse::Reply(_) => {}
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_macos_completion_notification_sound(
    notification: &mut mac_notification_sys::Notification<'_>,
    app: &AppHandle,
    sound: Option<&str>,
) {
    let Some(sound) = sound else {
        return;
    };

    if !is_plain_sound_resource_name(sound) {
        log::warn!("Ignoring invalid completion notification sound resource: {sound}");
        notification.default_sound();
        return;
    }

    if tauri::is_dev() {
        notification.default_sound();
        play_completion_notification_sound(app, sound);
    } else {
        notification.sound(sound);
    }
}

#[cfg(target_os = "macos")]
fn play_completion_notification_sound(app: &AppHandle, sound: &str) {
    let Some(path) = completion_notification_sound_path(app, sound) else {
        log::warn!("Completion notification sound resource not found: {sound}");
        return;
    };

    std::thread::spawn(
        move || match Command::new("/usr/bin/afplay").arg(&path).status() {
            Ok(status) if !status.success() => {
                log::warn!(
                    "Completion notification sound '{}' exited with status {status}",
                    path.display()
                );
            }
            Ok(_) => {}
            Err(error) => {
                log::warn!(
                    "Failed to play completion notification sound '{}': {error}",
                    path.display()
                );
            }
        },
    );
}

#[cfg(target_os = "macos")]
fn completion_notification_sound_path(app: &AppHandle, sound: &str) -> Option<PathBuf> {
    if !is_plain_sound_resource_name(sound) {
        return None;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let resource_path = resource_dir.join(sound);
        if resource_path.exists() {
            return Some(resource_path);
        }
    }

    if tauri::is_dev() {
        let dev_path = dev_completion_notification_sound_path(sound);
        if dev_path.exists() {
            return Some(dev_path);
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn dev_completion_notification_sound_path(sound: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("resources")
        .join(sound)
}

#[cfg(target_os = "macos")]
fn is_plain_sound_resource_name(sound: &str) -> bool {
    !sound.trim().is_empty()
        && Path::new(sound)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(not(target_os = "macos"))]
fn show_platform_completion_notification(
    app: AppHandle,
    _session_id: String,
    body: String,
    sound: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let mut builder = app.notification().builder().title("Goose").body(body);
    if let Some(sound) = sound {
        builder = builder.sound(sound);
    }
    builder.show().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn emit_completion_notification_clicked(app: &AppHandle, session_id: String) {
    focus_main_window(app);

    let _ = app.emit(
        COMPLETION_NOTIFICATION_CLICKED_EVENT,
        CompletionNotificationClickedPayload { session_id },
    );
}

#[cfg(target_os = "macos")]
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();

        let window_for_activation = window.clone();
        let _ = window.run_on_main_thread(move || {
            activate_macos_app();
            let _ = window_for_activation.show();
            let _ = window_for_activation.unminimize();
            let _ = window_for_activation.set_focus();
        });
    }
}

#[cfg(target_os = "macos")]
fn activate_macos_app() {
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    if let Some(mtm) = MainThreadMarker::new() {
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{dev_completion_notification_sound_path, is_plain_sound_resource_name};

    #[test]
    fn bundled_completion_sound_exists_for_dev_resolution() {
        assert!(dev_completion_notification_sound_path("notification-complete.mp3").exists());
    }

    #[test]
    fn sound_resource_name_must_be_plain_filename() {
        assert!(is_plain_sound_resource_name("notification-complete.mp3"));
        assert!(!is_plain_sound_resource_name(""));
        assert!(!is_plain_sound_resource_name(
            "../notification-complete.mp3"
        ));
        assert!(!is_plain_sound_resource_name(
            "/tmp/notification-complete.mp3"
        ));
    }
}
