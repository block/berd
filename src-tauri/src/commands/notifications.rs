#[cfg(target_os = "macos")]
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, State};

struct CompletionNotificationRequest {
    session_id: String,
    body: String,
    sound: Option<String>,
}

fn voice_session_is_active(native_active: bool, realtime_active: bool) -> bool {
    native_active || realtime_active
}

#[cfg(target_os = "macos")]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletionNotificationClickedPayload {
    session_id: String,
}

#[cfg(target_os = "macos")]
struct CompletionNotificationState {
    _delegate: objc2::rc::Retained<macos_completion::CompletionNotificationDelegate>,
}

#[tauri::command]
pub fn show_completion_notification(
    app: AppHandle,
    voice_state: State<'_, crate::commands::native_voice::NativeVoiceState>,
    realtime_voice_state: State<'_, crate::commands::voice_buddy::RealtimeVoiceControlsState>,
    session_id: String,
    body: String,
    sound: Option<String>,
) -> Result<(), String> {
    if voice_session_is_active(
        voice_state.is_active_for_session(&session_id),
        realtime_voice_state.is_active_for_session(&session_id),
    ) {
        return Ok(());
    }
    show_platform_completion_notification(
        app,
        CompletionNotificationRequest {
            session_id,
            body,
            sound,
        },
    )
}

#[tauri::command]
pub fn should_suppress_completion_notification(
    voice_state: State<'_, crate::commands::native_voice::NativeVoiceState>,
    realtime_voice_state: State<'_, crate::commands::voice_buddy::RealtimeVoiceControlsState>,
    session_id: String,
) -> bool {
    voice_session_is_active(
        voice_state.is_active_for_session(&session_id),
        realtime_voice_state.is_active_for_session(&session_id),
    )
}

#[cfg(test)]
mod voice_presence_tests {
    use super::voice_session_is_active;

    #[test]
    fn either_voice_backend_suppresses_session_completion() {
        assert!(voice_session_is_active(true, false));
        assert!(voice_session_is_active(false, true));
        assert!(voice_session_is_active(true, true));
        assert!(!voice_session_is_active(false, false));
    }
}

#[cfg(target_os = "macos")]
pub fn init_completion_notifications(app: &tauri::AppHandle) -> Result<(), String> {
    macos_completion::init_completion_notifications(app)
}

#[cfg(target_os = "macos")]
fn show_platform_completion_notification(
    app: AppHandle,
    request: CompletionNotificationRequest,
) -> Result<(), String> {
    if tauri::is_dev() {
        return show_macos_fallback_completion_notification(app, request);
    }

    macos_completion::show_completion_notification(app, request)
}

#[cfg(target_os = "macos")]
mod macos_completion {
    use super::{
        completion_notification_identifier, play_macos_completion_notification_sound,
        CompletionNotificationClickedPayload, CompletionNotificationRequest,
        CompletionNotificationState,
    };
    use block2::RcBlock;
    use objc2::define_class;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{msg_send, AnyThread, DefinedClass};
    use objc2_app_kit::NSApplication;
    use objc2_foundation::{NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationDismissActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Emitter, Manager};

    #[derive(Clone)]
    pub struct NotificationDelegateIvars {
        app: AppHandle,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = AnyThread]
        #[ivars = NotificationDelegateIvars]
        pub struct CompletionNotificationDelegate;

        unsafe impl NSObjectProtocol for CompletionNotificationDelegate {}

        #[allow(non_snake_case)]
        unsafe impl UNUserNotificationCenterDelegate for CompletionNotificationDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn userNotificationCenter_willPresentNotification_withCompletionHandler(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion_handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                completion_handler.call(());

                let action_identifier = response.actionIdentifier();
                if &*action_identifier == unsafe { UNNotificationDismissActionIdentifier } {
                    return;
                }

                let Some(session_id) = session_id_from_response(response) else {
                    log::warn!("Completion notification click did not include a session id");
                    return;
                };

                let app = self.ivars().app.clone();
                let app_for_main_thread = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    focus_app_for_completion_notification(&app_for_main_thread);
                    if let Err(error) = app_for_main_thread.emit(
                        "completion-notification-clicked",
                        CompletionNotificationClickedPayload { session_id },
                    ) {
                        log::warn!("Failed to emit completion notification click event: {error}");
                    }
                }) {
                    log::warn!("Failed to handle completion notification click: {error}");
                }
            }
        }
    );

    impl CompletionNotificationDelegate {
        fn new(app: AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(NotificationDelegateIvars { app });
            // SAFETY: `this` is an allocated NSObject subclass with initialized ivars.
            unsafe { msg_send![super(this), init] }
        }
    }

    pub fn init_completion_notifications(app: &AppHandle) -> Result<(), String> {
        // UNUserNotificationCenter asserts in unbundled dev runs because
        // bundleProxyForCurrentProcess is nil for the Cargo target binary.
        if tauri::is_dev() {
            return Ok(());
        }

        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate = CompletionNotificationDelegate::new(app.clone());
        let delegate_ref: &ProtocolObject<dyn UNUserNotificationCenterDelegate> =
            ProtocolObject::from_ref(&*delegate);
        center.setDelegate(Some(delegate_ref));

        // Request notification authorization for the app's bundle id. Without
        // this the app never appears in System Settings → Notifications and
        // scheduled notifications are silently dropped from banners/lists.
        let authorization_block =
            RcBlock::new(|granted: objc2::runtime::Bool, error: *mut NSError| {
                if !error.is_null() {
                    log::warn!(
                        "Completion notification authorization request failed: {}",
                        error_description(error)
                    );
                } else if !granted.as_bool() {
                    log::info!("Completion notification authorization was not granted");
                }
            });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &authorization_block,
        );

        app.manage(CompletionNotificationState {
            _delegate: delegate,
        });
        Ok(())
    }

    pub fn show_completion_notification(
        app: AppHandle,
        request: CompletionNotificationRequest,
    ) -> Result<(), String> {
        let center = UNUserNotificationCenter::currentNotificationCenter();

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str("Berd"));
        content.setBody(&NSString::from_str(&request.body));

        let key = NSString::from_str("sessionId");
        let value = NSString::from_str(&request.session_id);
        let user_info = NSDictionary::from_slices(&[&*key], &[&*value]);
        // SAFETY: NSDictionary generics are Rust-side type information. This erases the
        // `NSString, NSString` parameters for the untyped generated UserNotifications API.
        let user_info =
            unsafe { &*((&*user_info as *const NSDictionary<NSString, NSString>).cast()) };
        // SAFETY: `user_info` contains NSString keys and values, which are property-list objects
        // accepted by `UNNotificationContent.userInfo`.
        unsafe { content.setUserInfo(user_info) };

        let identifier =
            NSString::from_str(&completion_notification_identifier(&request.session_id));
        let notification_request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            None,
        );
        let sound = request.sound;
        let block = RcBlock::new(move |error: *mut NSError| {
            if error.is_null() {
                play_macos_completion_notification_sound(&app, sound.as_deref());
            } else {
                log::warn!(
                    "Failed to schedule completion notification: {}",
                    error_description(error)
                );
            }
        });
        center.addNotificationRequest_withCompletionHandler(&notification_request, Some(&block));

        Ok(())
    }

    fn error_description(error: *mut NSError) -> String {
        if error.is_null() {
            return "unknown error".to_string();
        }

        // SAFETY: UserNotifications passes a valid NSError pointer when non-null.
        unsafe { &*error }.localizedDescription().to_string()
    }

    fn session_id_from_response(response: &UNNotificationResponse) -> Option<String> {
        let key = NSString::from_str("sessionId");
        let notification = response.notification();
        let request = notification.request();
        let content = request.content();
        let user_info = content.userInfo();
        // SAFETY: Completion notifications store `sessionId` as an NSString value in userInfo.
        let session_id: Option<Retained<NSString>> =
            unsafe { msg_send![&*user_info, objectForKey: &*key] };
        session_id
            .map(|session_id| session_id.to_string())
            .filter(|session_id| !session_id.trim().is_empty())
    }

    #[allow(deprecated)]
    fn focus_app_for_completion_notification(app: &AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }

        if let Some(mtm) = objc2_foundation::MainThreadMarker::new() {
            let ns_app = NSApplication::sharedApplication(mtm);
            ns_app.activateIgnoringOtherApps(true);
        }
    }
}

#[cfg(target_os = "macos")]
fn show_macos_fallback_completion_notification(
    app: AppHandle,
    request: CompletionNotificationRequest,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let CompletionNotificationRequest {
        session_id: _session_id,
        body,
        sound,
    } = request;

    let builder = app.notification().builder().title("Berd").body(body);
    play_macos_completion_notification_sound(&app, sound.as_deref());
    builder.show().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn play_macos_completion_notification_sound(app: &AppHandle, sound: Option<&str>) {
    let Some(sound) = sound else {
        return;
    };

    if !is_plain_sound_resource_name(sound) {
        log::warn!("Ignoring invalid completion notification sound resource: {sound}");
        return;
    }

    play_completion_notification_sound(app, sound);
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

#[cfg(target_os = "macos")]
fn completion_notification_identifier(session_id: &str) -> String {
    format!("completion:{}:{}", session_id, uuid::Uuid::new_v4())
}

#[cfg(not(target_os = "macos"))]
fn show_platform_completion_notification(
    app: AppHandle,
    request: CompletionNotificationRequest,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let CompletionNotificationRequest {
        session_id: _session_id,
        body,
        sound,
    } = request;
    let mut builder = app.notification().builder().title("Berd").body(body);
    if let Some(sound) = sound {
        builder = builder.sound(sound);
    }
    builder.show().map_err(|error| error.to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{
        completion_notification_identifier, dev_completion_notification_sound_path,
        is_plain_sound_resource_name,
    };

    #[test]
    fn bundled_completion_sound_exists_for_dev_resolution() {
        assert!(dev_completion_notification_sound_path("berd-sounds-4.mp3").exists());
    }

    #[test]
    fn sound_resource_name_must_be_plain_filename() {
        assert!(is_plain_sound_resource_name("berd-sounds-4.mp3"));
        assert!(!is_plain_sound_resource_name(""));
        assert!(!is_plain_sound_resource_name("../berd-sounds-4.mp3"));
        assert!(!is_plain_sound_resource_name("/tmp/berd-sounds-4.mp3"));
    }

    #[test]
    fn completion_notification_identifiers_are_prefixed_and_unique() {
        let first = completion_notification_identifier("session-1");
        let second = completion_notification_identifier("session-1");

        assert!(first.starts_with("completion:session-1:"));
        assert!(second.starts_with("completion:session-1:"));
        assert_ne!(first, second);
    }
}
