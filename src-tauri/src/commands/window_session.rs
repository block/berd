use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

#[cfg(target_os = "macos")]
use crate::attach_traffic_light_management;

const SESSION_WINDOWS_CHANGED: &str = "session-windows-changed";
const SESSION_HANDOFF_SNAPSHOT_AVAILABLE: &str = "session-handoff-snapshot-available";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionWindowSupport {
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SessionWindowMode {
    Owned,
    Handoff {
        from_label: String,
        to_label: String,
        destination_ready: bool,
        latest_version: u64,
        final_version: Option<u64>,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionWindowEntry {
    pub session_id: String,
    pub window_label: String,
    pub mode: SessionWindowMode,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionHandoffSnapshot {
    pub version: u64,
    pub is_final: bool,
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionHandoffAvailable {
    pub session_id: String,
    pub to_label: String,
    pub version: u64,
    pub is_final: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JoinSessionHandoffResult {
    pub mode: SessionWindowMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<SessionHandoffSnapshot>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishSessionHandoffSnapshot {
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SessionWindowRecord {
    Owned {
        window_label: String,
    },
    Handoff {
        from_label: String,
        to_label: String,
        destination_ready: bool,
        latest_version: u64,
        final_version: Option<u64>,
    },
}

#[derive(Default)]
struct RegistryState {
    records: HashMap<String, SessionWindowRecord>,
    snapshots: HashMap<String, SessionHandoffSnapshot>,
}

#[derive(Clone, Default)]
pub struct WindowSessionRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClaimError {
    AlreadyOwned(String),
    InvalidCaller,
    NotInHandoff,
    NotFound,
}

pub fn label_for_session(session_id: &str) -> String {
    let digest = Sha256::digest(session_id.as_bytes());
    let hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("session:{hash}")
}

fn session_window_support() -> SessionWindowSupport {
    #[cfg(target_os = "macos")]
    {
        SessionWindowSupport {
            supported: true,
            reason: None,
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        SessionWindowSupport {
            supported: false,
            reason: Some("session windows are currently supported on macOS only".to_string()),
        }
    }
}

fn ensure_supported() -> Result<(), String> {
    let support = session_window_support();
    if support.supported {
        return Ok(());
    }

    Err(support
        .reason
        .unwrap_or_else(|| "session windows are unsupported".to_string()))
}

impl WindowSessionRegistry {
    fn lock(&self) -> MutexGuard<'_, RegistryState> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn label_for(&self, session_id: &str) -> Option<String> {
        let state = self.lock();
        state.records.get(session_id).map(|record| match record {
            SessionWindowRecord::Owned { window_label } => window_label.clone(),
            SessionWindowRecord::Handoff { to_label, .. } => to_label.clone(),
        })
    }

    #[cfg(test)]
    fn entry_for(&self, session_id: &str) -> Option<SessionWindowEntry> {
        let state = self.lock();
        state
            .records
            .get(session_id)
            .map(|record| entry_from_record(session_id, record))
    }

    pub fn claim(&self, session_id: &str) -> Result<String, ClaimError> {
        let mut state = self.lock();
        if let Some(existing) = state.records.get(session_id) {
            return Err(ClaimError::AlreadyOwned(record_label(existing)));
        }

        let label = label_for_session(session_id);
        state.records.insert(
            session_id.to_string(),
            SessionWindowRecord::Owned {
                window_label: label.clone(),
            },
        );
        Ok(label)
    }

    pub fn begin_handoff(&self, session_id: &str, from_label: &str) -> Result<String, ClaimError> {
        let mut state = self.lock();
        if let Some(existing) = state.records.get(session_id) {
            match existing {
                SessionWindowRecord::Owned { window_label } if from_label == window_label => {}
                _ => return Err(ClaimError::AlreadyOwned(record_label(existing))),
            }
        } else if from_label != "main" {
            return Err(ClaimError::InvalidCaller);
        }

        let to_label = label_for_session(session_id);
        state.snapshots.remove(session_id);
        state.records.insert(
            session_id.to_string(),
            SessionWindowRecord::Handoff {
                from_label: from_label.to_string(),
                to_label: to_label.clone(),
                destination_ready: false,
                latest_version: 0,
                final_version: None,
            },
        );
        Ok(to_label)
    }

    pub fn join_handoff(
        &self,
        session_id: &str,
        caller: &str,
    ) -> Result<JoinSessionHandoffResult, ClaimError> {
        let mut state = self.lock();
        let snapshot = state.snapshots.get(session_id).cloned();
        let Some(record) = state.records.get_mut(session_id) else {
            return Err(ClaimError::NotFound);
        };

        match record {
            SessionWindowRecord::Handoff {
                to_label,
                destination_ready,
                ..
            } if to_label == caller => {
                *destination_ready = true;
                Ok(JoinSessionHandoffResult {
                    mode: mode_from_record(record),
                    snapshot,
                })
            }
            SessionWindowRecord::Owned { window_label } if window_label == caller => {
                Ok(JoinSessionHandoffResult {
                    mode: mode_from_record(record),
                    snapshot,
                })
            }
            _ => Err(ClaimError::InvalidCaller),
        }
    }

    pub fn publish_snapshot(
        &self,
        session_id: &str,
        caller: &str,
        payload: Value,
        is_final: bool,
    ) -> Result<(String, SessionHandoffSnapshot), ClaimError> {
        let mut state = self.lock();
        let Some(record) = state.records.get_mut(session_id) else {
            return Err(ClaimError::NotFound);
        };

        let SessionWindowRecord::Handoff {
            from_label,
            to_label,
            latest_version,
            final_version,
            ..
        } = record
        else {
            return Err(ClaimError::NotInHandoff);
        };

        if from_label != caller {
            return Err(ClaimError::InvalidCaller);
        }

        *latest_version += 1;
        let snapshot = SessionHandoffSnapshot {
            version: *latest_version,
            is_final,
            payload,
        };
        if is_final {
            *final_version = Some(snapshot.version);
        }
        let to_label = to_label.clone();
        state
            .snapshots
            .insert(session_id.to_string(), snapshot.clone());
        Ok((to_label, snapshot))
    }

    pub fn finish_handoff(
        &self,
        session_id: &str,
        caller: &str,
        payload: Value,
    ) -> Result<(String, SessionHandoffSnapshot), ClaimError> {
        let mut state = self.lock();
        let (to_label, snapshot) = {
            let Some(record) = state.records.get_mut(session_id) else {
                return Err(ClaimError::NotFound);
            };

            let SessionWindowRecord::Handoff {
                from_label,
                to_label,
                latest_version,
                final_version,
                ..
            } = record
            else {
                return Err(ClaimError::NotInHandoff);
            };

            if from_label != caller {
                return Err(ClaimError::InvalidCaller);
            }

            *latest_version += 1;
            let snapshot = SessionHandoffSnapshot {
                version: *latest_version,
                is_final: true,
                payload,
            };
            *final_version = Some(snapshot.version);
            (to_label.clone(), snapshot)
        };

        state
            .snapshots
            .insert(session_id.to_string(), snapshot.clone());
        state.records.insert(
            session_id.to_string(),
            SessionWindowRecord::Owned {
                window_label: to_label.clone(),
            },
        );
        Ok((to_label, snapshot))
    }

    pub fn read_snapshot(
        &self,
        session_id: &str,
        caller: &str,
        after_version: Option<u64>,
    ) -> Result<Option<SessionHandoffSnapshot>, ClaimError> {
        let state = self.lock();
        let Some(record) = state.records.get(session_id) else {
            return Err(ClaimError::NotFound);
        };

        let allowed = match record {
            SessionWindowRecord::Owned { window_label } => window_label == caller,
            SessionWindowRecord::Handoff { to_label, .. } => to_label == caller,
        };
        if !allowed {
            return Err(ClaimError::InvalidCaller);
        }

        Ok(state
            .snapshots
            .get(session_id)
            .filter(|snapshot| after_version.is_none_or(|version| snapshot.version > version))
            .cloned())
    }

    pub fn recover_handoff(&self, session_id: &str, caller: &str) -> Result<(), ClaimError> {
        let mut state = self.lock();
        let Some(record) = state.records.get_mut(session_id) else {
            return Err(ClaimError::NotFound);
        };

        let SessionWindowRecord::Handoff { to_label, .. } = record else {
            return Err(ClaimError::NotInHandoff);
        };
        if to_label != caller {
            return Err(ClaimError::InvalidCaller);
        }

        *record = SessionWindowRecord::Owned {
            window_label: caller.to_string(),
        };
        state.snapshots.remove(session_id);
        Ok(())
    }

    pub fn release_label(&self, label: &str) {
        let mut state = self.lock();
        let mut released_sessions = Vec::new();
        state.records.retain(|session_id, record| {
            let release = match record {
                SessionWindowRecord::Owned { window_label } => window_label == label,
                SessionWindowRecord::Handoff {
                    from_label,
                    to_label,
                    ..
                } => to_label == label || (label != "main" && from_label == label),
            };
            if release {
                released_sessions.push(session_id.clone());
            }
            !release
        });
        for session_id in released_sessions {
            state.snapshots.remove(&session_id);
        }
    }

    pub fn snapshot(&self) -> Vec<SessionWindowEntry> {
        let state = self.lock();
        state
            .records
            .iter()
            .map(|(session_id, record)| entry_from_record(session_id, record))
            .collect()
    }
}

fn record_label(record: &SessionWindowRecord) -> String {
    match record {
        SessionWindowRecord::Owned { window_label } => window_label.clone(),
        SessionWindowRecord::Handoff { to_label, .. } => to_label.clone(),
    }
}

fn mode_from_record(record: &SessionWindowRecord) -> SessionWindowMode {
    match record {
        SessionWindowRecord::Owned { .. } => SessionWindowMode::Owned,
        SessionWindowRecord::Handoff {
            from_label,
            to_label,
            destination_ready,
            latest_version,
            final_version,
        } => SessionWindowMode::Handoff {
            from_label: from_label.clone(),
            to_label: to_label.clone(),
            destination_ready: *destination_ready,
            latest_version: *latest_version,
            final_version: *final_version,
        },
    }
}

fn entry_from_record(session_id: &str, record: &SessionWindowRecord) -> SessionWindowEntry {
    SessionWindowEntry {
        session_id: session_id.to_string(),
        window_label: record_label(record),
        mode: mode_from_record(record),
    }
}

fn emit_snapshot(app: &AppHandle, reg: &WindowSessionRegistry) -> Result<(), String> {
    app.emit(SESSION_WINDOWS_CHANGED, reg.snapshot())
        .map_err(|error| format!("failed to emit session window snapshot: {error}"))
}

fn emit_handoff_available(
    app: &AppHandle,
    session_id: &str,
    to_label: &str,
    snapshot: &SessionHandoffSnapshot,
) -> Result<(), String> {
    app.emit_to(
        to_label,
        SESSION_HANDOFF_SNAPSHOT_AVAILABLE,
        SessionHandoffAvailable {
            session_id: session_id.to_string(),
            to_label: to_label.to_string(),
            version: snapshot.version,
            is_final: snapshot.is_final,
        },
    )
    .map_err(|error| format!("failed to emit session handoff availability: {error}"))
}

fn map_claim_error(session_id: &str, error: ClaimError) -> String {
    match error {
        ClaimError::AlreadyOwned(existing) => {
            format!("session {session_id} is already owned by {existing}")
        }
        ClaimError::InvalidCaller => format!("caller cannot access session {session_id}"),
        ClaimError::NotInHandoff => format!("session {session_id} is not in handoff"),
        ClaimError::NotFound => format!("session {session_id} was not found"),
    }
}

fn session_query_key(session_id: &str) -> String {
    URL_SAFE_NO_PAD.encode(session_id.as_bytes())
}

fn focus_window(app: &AppHandle, label: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        window
            .set_focus()
            .map_err(|error| format!("failed to focus session window: {error}"))?;
    }
    Ok(())
}

fn claim_or_begin_handoff(
    reg: &WindowSessionRegistry,
    session_id: &str,
    from_label: &str,
    handoff: bool,
) -> Result<String, ClaimError> {
    if handoff {
        reg.begin_handoff(session_id, from_label)
    } else {
        reg.claim(session_id)
    }
}

#[tauri::command]
pub fn get_session_window_support() -> SessionWindowSupport {
    session_window_support()
}

#[tauri::command]
pub fn list_session_windows(
    reg: State<'_, WindowSessionRegistry>,
) -> Result<Vec<SessionWindowEntry>, String> {
    ensure_supported()?;
    Ok(reg.snapshot())
}

#[tauri::command]
pub fn focus_session_window(
    app: AppHandle,
    reg: State<'_, WindowSessionRegistry>,
    webview_window: WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    ensure_supported()?;
    let label = reg
        .label_for(&session_id)
        .ok_or_else(|| format!("session {session_id} is not open in a window"))?;
    if webview_window.label() != "main" && webview_window.label() != label {
        return Err(format!("caller cannot access session {session_id}"));
    }
    focus_window(&app, &label)
}

#[tauri::command]
pub fn release_session(
    app: AppHandle,
    reg: State<'_, WindowSessionRegistry>,
    webview_window: WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    ensure_supported()?;
    let caller = webview_window.label();
    if let Some(label) = reg.label_for(&session_id) {
        if caller != "main" && caller != label {
            return Err(format!("caller cannot access session {session_id}"));
        }
        reg.release_label(&label);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
        emit_snapshot(&app, &reg)?;
    }
    Ok(())
}

#[tauri::command]
pub fn join_session_handoff(
    app: AppHandle,
    reg: State<'_, WindowSessionRegistry>,
    webview_window: WebviewWindow,
    session_id: String,
) -> Result<JoinSessionHandoffResult, String> {
    ensure_supported()?;
    let result = reg
        .join_handoff(&session_id, webview_window.label())
        .map_err(|error| map_claim_error(&session_id, error))?;
    emit_snapshot(&app, &reg)?;
    Ok(result)
}

#[tauri::command]
pub fn publish_session_handoff_snapshot(
    app: AppHandle,
    reg: State<'_, WindowSessionRegistry>,
    webview_window: WebviewWindow,
    session_id: String,
    snapshot: PublishSessionHandoffSnapshot,
) -> Result<(), String> {
    ensure_supported()?;
    let (to_label, stored) = reg
        .publish_snapshot(&session_id, webview_window.label(), snapshot.payload, false)
        .map_err(|error| map_claim_error(&session_id, error))?;
    emit_handoff_available(&app, &session_id, &to_label, &stored)
}

#[tauri::command]
pub fn finish_session_handoff(
    app: AppHandle,
    reg: State<'_, WindowSessionRegistry>,
    webview_window: WebviewWindow,
    session_id: String,
    snapshot: PublishSessionHandoffSnapshot,
) -> Result<(), String> {
    ensure_supported()?;
    let (to_label, stored) = reg
        .finish_handoff(&session_id, webview_window.label(), snapshot.payload)
        .map_err(|error| map_claim_error(&session_id, error))?;
    emit_handoff_available(&app, &session_id, &to_label, &stored)?;
    emit_snapshot(&app, &reg)
}

#[tauri::command]
pub fn read_session_handoff_snapshot(
    reg: State<'_, WindowSessionRegistry>,
    webview_window: WebviewWindow,
    session_id: String,
    after_version: Option<u64>,
) -> Result<Option<SessionHandoffSnapshot>, String> {
    ensure_supported()?;
    reg.read_snapshot(&session_id, webview_window.label(), after_version)
        .map_err(|error| map_claim_error(&session_id, error))
}

#[tauri::command]
pub fn recover_session_handoff(
    app: AppHandle,
    reg: State<'_, WindowSessionRegistry>,
    webview_window: WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    ensure_supported()?;
    reg.recover_handoff(&session_id, webview_window.label())
        .map_err(|error| map_claim_error(&session_id, error))?;
    emit_snapshot(&app, &reg)
}

#[tauri::command]
pub fn open_session_window(
    app: AppHandle,
    reg: State<'_, WindowSessionRegistry>,
    webview_window: WebviewWindow,
    session_id: String,
    handoff: bool,
) -> Result<(), String> {
    ensure_supported()?;
    let from_label = webview_window.label().to_string();
    let label = match claim_or_begin_handoff(&reg, &session_id, &from_label, handoff) {
        Ok(label) => label,
        Err(ClaimError::AlreadyOwned(existing)) => {
            focus_window(&app, &existing)?;
            return Ok(());
        }
        Err(error) => return Err(map_claim_error(&session_id, error)),
    };

    let url = format!("index.html?sessionKey={}", session_query_key(&session_id));
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Berd")
        .inner_size(900.0, 700.0)
        .min_inner_size(608.0, 600.0);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    let window = builder.build().map_err(|error| {
        reg.release_label(&label);
        format!("failed to build session window: {error}")
    })?;

    #[cfg(target_os = "macos")]
    attach_traffic_light_management(&window);

    let app_for_close = app.clone();
    let reg_for_close = reg.inner().clone();
    let label_for_close = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            crate::commands::native_voice::handle_voice_owner_window_destroyed(
                &app_for_close,
                &label_for_close,
            );
            crate::commands::voice_buddy::handle_realtime_voice_owner_window_destroyed(
                &app_for_close,
                &label_for_close,
            );
            reg_for_close.release_label(&label_for_close);
            let _ = emit_snapshot(&app_for_close, &reg_for_close);
        }
    });

    emit_snapshot(&app, &reg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(value: &str) -> Value {
        serde_json::json!({ "value": value })
    }

    #[test]
    fn claim_is_exclusive_and_releasable() {
        let reg = WindowSessionRegistry::default();
        assert_eq!(reg.label_for("s1"), None);

        let label = reg.claim("s1").expect("first claim should succeed");
        assert_eq!(label, label_for_session("s1"));
        assert_eq!(reg.label_for("s1"), Some(label_for_session("s1")));

        match reg.claim("s1") {
            Err(ClaimError::AlreadyOwned(existing)) => {
                assert_eq!(existing, label_for_session("s1"));
            }
            other => panic!("expected AlreadyOwned, got {other:?}"),
        }

        reg.release_label(&label_for_session("s1"));
        assert_eq!(reg.label_for("s1"), None);
    }

    #[test]
    fn labels_hash_session_ids_for_window_labels() {
        let label = label_for_session("session/with spaces?and=query");
        assert!(label.starts_with("session:"));
        assert_ne!(label, "session:session/with spaces?and=query");
        assert_eq!(label.len(), "session:".len() + 64);
        assert!(!label.contains('/'));
        assert!(!label.contains('?'));
        assert!(!label.contains(' '));
    }

    #[test]
    fn begin_handoff_records_source_and_destination_windows() {
        let reg = WindowSessionRegistry::default();
        let destination = reg
            .begin_handoff("s1", "main")
            .expect("handoff should create destination label");

        assert_eq!(destination, label_for_session("s1"));
        assert_eq!(
            reg.entry_for("s1"),
            Some(SessionWindowEntry {
                session_id: "s1".into(),
                window_label: label_for_session("s1"),
                mode: SessionWindowMode::Handoff {
                    from_label: "main".into(),
                    to_label: label_for_session("s1"),
                    destination_ready: false,
                    latest_version: 0,
                    final_version: None,
                },
            }),
        );
    }

    #[test]
    fn wrong_source_cannot_publish_finish_read_or_recover() {
        let reg = WindowSessionRegistry::default();
        reg.begin_handoff("s1", "main").unwrap();

        assert_eq!(
            reg.publish_snapshot("s1", "other", payload("a"), false),
            Err(ClaimError::InvalidCaller),
        );
        assert_eq!(
            reg.finish_handoff("s1", "other", payload("a")),
            Err(ClaimError::InvalidCaller),
        );
        assert_eq!(
            reg.read_snapshot("s1", "other", None),
            Err(ClaimError::InvalidCaller),
        );
        assert_eq!(
            reg.recover_handoff("s1", "other"),
            Err(ClaimError::InvalidCaller),
        );
    }

    #[test]
    fn destination_ready_handshake_transitions() {
        let reg = WindowSessionRegistry::default();
        let destination = reg.begin_handoff("s1", "main").unwrap();

        let result = reg
            .join_handoff("s1", &destination)
            .expect("destination should join");

        assert_eq!(
            result.mode,
            SessionWindowMode::Handoff {
                from_label: "main".into(),
                to_label: destination,
                destination_ready: true,
                latest_version: 0,
                final_version: None,
            }
        );
    }

    #[test]
    fn snapshots_version_monotonically_and_final_promotes_owner() {
        let reg = WindowSessionRegistry::default();
        let destination = reg.begin_handoff("s1", "main").unwrap();
        reg.join_handoff("s1", &destination).unwrap();

        let (_, first) = reg
            .publish_snapshot("s1", "main", payload("first"), false)
            .unwrap();
        let (_, final_snapshot) = reg.finish_handoff("s1", "main", payload("final")).unwrap();

        assert_eq!(first.version, 1);
        assert_eq!(final_snapshot.version, 2);
        assert!(final_snapshot.is_final);
        assert_eq!(
            reg.entry_for("s1").map(|entry| entry.mode),
            Some(SessionWindowMode::Owned),
        );
        assert_eq!(
            reg.read_snapshot("s1", &destination, Some(1))
                .unwrap()
                .map(|snapshot| snapshot.payload),
            Some(payload("final")),
        );
    }

    #[test]
    fn publish_and_recover_require_active_handoff() {
        let reg = WindowSessionRegistry::default();
        let owner = reg.claim("s1").unwrap();

        assert_eq!(
            reg.publish_snapshot("s1", &owner, payload("a"), false),
            Err(ClaimError::NotInHandoff),
        );
        assert_eq!(
            reg.finish_handoff("s1", &owner, payload("a")),
            Err(ClaimError::NotInHandoff),
        );
        assert_eq!(
            reg.recover_handoff("s1", &owner),
            Err(ClaimError::NotInHandoff),
        );
    }

    #[test]
    fn recover_handoff_clears_stale_snapshot() {
        let reg = WindowSessionRegistry::default();
        let destination = reg.begin_handoff("s1", "main").unwrap();
        reg.join_handoff("s1", &destination).unwrap();
        reg.publish_snapshot("s1", "main", payload("stale"), false)
            .unwrap();

        reg.recover_handoff("s1", &destination).unwrap();

        assert_eq!(reg.read_snapshot("s1", &destination, None).unwrap(), None);
        assert_eq!(
            reg.entry_for("s1").map(|entry| entry.mode),
            Some(SessionWindowMode::Owned),
        );
    }

    #[test]
    fn main_cannot_rehandoff_session_owned_by_popout() {
        let reg = WindowSessionRegistry::default();
        let owner = reg.claim("s1").unwrap();

        assert_eq!(
            reg.begin_handoff("s1", "main"),
            Err(ClaimError::AlreadyOwned(owner.clone())),
        );
        assert_eq!(reg.begin_handoff("s1", &owner), Ok(owner));
    }

    #[test]
    fn release_main_does_not_clear_main_sourced_handoffs() {
        let reg = WindowSessionRegistry::default();
        reg.begin_handoff("s1", "main").unwrap();

        reg.release_label("main");

        assert!(reg.entry_for("s1").is_some());
    }

    #[test]
    fn destination_close_releases_only_that_handoff() {
        let reg = WindowSessionRegistry::default();
        let first = reg.begin_handoff("s1", "main").unwrap();
        reg.begin_handoff("s2", "main").unwrap();

        reg.release_label(&first);

        assert!(reg.entry_for("s1").is_none());
        assert!(reg.entry_for("s2").is_some());
    }

    #[test]
    fn closing_non_main_handoff_source_releases_that_handoff() {
        let reg = WindowSessionRegistry::default();
        {
            let mut state = reg.lock();
            state.records.insert(
                "s1".into(),
                SessionWindowRecord::Handoff {
                    from_label: "source".into(),
                    to_label: "destination".into(),
                    destination_ready: true,
                    latest_version: 1,
                    final_version: None,
                },
            );
            state.snapshots.insert(
                "s1".into(),
                SessionHandoffSnapshot {
                    version: 1,
                    is_final: false,
                    payload: payload("live"),
                },
            );
        }

        reg.release_label("source");

        assert!(reg.entry_for("s1").is_none());
        assert!(reg.read_snapshot("s1", "destination", None).is_err());
    }

    #[test]
    fn double_join_handoff_is_idempotent() {
        let reg = WindowSessionRegistry::default();
        let destination = reg.begin_handoff("s1", "main").unwrap();

        let first = reg.join_handoff("s1", &destination).unwrap();
        let second = reg.join_handoff("s1", &destination).unwrap();

        assert_eq!(first.mode, second.mode);
        assert_eq!(
            reg.entry_for("s1").map(|entry| entry.mode),
            Some(SessionWindowMode::Handoff {
                from_label: "main".into(),
                to_label: destination,
                destination_ready: true,
                latest_version: 0,
                final_version: None,
            }),
        );
    }

    #[test]
    fn poisoned_registry_still_returns_snapshot() {
        let reg = WindowSessionRegistry::default();
        reg.claim("s1").unwrap();

        let clone = reg.clone();
        let _ = std::panic::catch_unwind(move || {
            let _guard = clone.inner.lock().unwrap();
            panic!("poison");
        });

        assert_eq!(reg.snapshot().len(), 1);
    }

    #[test]
    fn support_helper_is_cfg_backed() {
        let support = session_window_support();
        #[cfg(target_os = "macos")]
        assert!(support.supported);
        #[cfg(not(target_os = "macos"))]
        assert!(!support.supported);
    }
}
