use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(target_os = "macos")]
use crate::attach_traffic_light_management;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

const SESSION_WINDOWS_CHANGED: &str = "session-windows-changed";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SessionWindowMode {
    Owned,
    Handoff {
        from_label: String,
        to_label: String,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionWindowEntry {
    pub session_id: String,
    pub window_label: String,
    pub mode: SessionWindowMode,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SessionWindowRecord {
    window_label: String,
    mode: SessionWindowMode,
}

#[derive(Clone, Default)]
pub struct WindowSessionRegistry {
    inner: Arc<Mutex<HashMap<String, SessionWindowRecord>>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClaimError {
    AlreadyOwned(String),
    NotFound,
    Poisoned,
}

pub fn label_for_session(session_id: &str) -> String {
    let digest = Sha256::digest(session_id.as_bytes());
    let hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("session:{hash}")
}

impl WindowSessionRegistry {
    pub fn label_for(&self, session_id: &str) -> Option<String> {
        self.inner
            .lock()
            .ok()?
            .get(session_id)
            .map(|record| record.window_label.clone())
    }

    #[cfg(test)]
    fn entry_for(&self, session_id: &str) -> Option<SessionWindowEntry> {
        self.inner
            .lock()
            .ok()?
            .get(session_id)
            .map(|record| SessionWindowEntry {
                session_id: session_id.to_string(),
                window_label: record.window_label.clone(),
                mode: record.mode.clone(),
            })
    }

    pub fn claim(&self, session_id: &str) -> Result<String, ClaimError> {
        let mut map = self.inner.lock().map_err(|_| ClaimError::Poisoned)?;
        if let Some(existing) = map.get(session_id) {
            return Err(ClaimError::AlreadyOwned(existing.window_label.clone()));
        }

        let label = label_for_session(session_id);
        map.insert(
            session_id.to_string(),
            SessionWindowRecord {
                window_label: label.clone(),
                mode: SessionWindowMode::Owned,
            },
        );
        Ok(label)
    }

    pub fn begin_handoff(&self, session_id: &str, from_label: &str) -> Result<String, ClaimError> {
        let mut map = self.inner.lock().map_err(|_| ClaimError::Poisoned)?;
        if let Some(existing) = map.get(session_id) {
            return Err(ClaimError::AlreadyOwned(existing.window_label.clone()));
        }

        let to_label = label_for_session(session_id);
        map.insert(
            session_id.to_string(),
            SessionWindowRecord {
                window_label: to_label.clone(),
                mode: SessionWindowMode::Handoff {
                    from_label: from_label.to_string(),
                    to_label: to_label.clone(),
                },
            },
        );
        Ok(to_label)
    }

    pub fn complete_handoff(&self, session_id: &str) -> Result<(), ClaimError> {
        let mut map = self.inner.lock().map_err(|_| ClaimError::Poisoned)?;
        let Some(record) = map.get_mut(session_id) else {
            return Err(ClaimError::NotFound);
        };

        record.mode = SessionWindowMode::Owned;
        Ok(())
    }

    pub fn release_label(&self, label: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.retain(|_, record| match &record.mode {
                SessionWindowMode::Owned => record.window_label != label,
                SessionWindowMode::Handoff {
                    from_label,
                    to_label,
                } => from_label != label && to_label != label && record.window_label != label,
            });
        }
    }

    pub fn snapshot(&self) -> Vec<SessionWindowEntry> {
        self.inner
            .lock()
            .map(|map| {
                map.iter()
                    .map(|(session_id, record)| SessionWindowEntry {
                        session_id: session_id.clone(),
                        window_label: record.window_label.clone(),
                        mode: record.mode.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn emit_snapshot(app: &AppHandle, reg: &WindowSessionRegistry) -> Result<(), String> {
    app.emit(SESSION_WINDOWS_CHANGED, reg.snapshot())
        .map_err(|error| format!("failed to emit session window snapshot: {error}"))
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

#[tauri::command]
pub fn list_session_windows(
    reg: State<'_, WindowSessionRegistry>,
) -> Result<Vec<SessionWindowEntry>, String> {
    Ok(reg.snapshot())
}

#[tauri::command]
pub fn focus_session_window(
    app: AppHandle,
    reg: State<'_, WindowSessionRegistry>,
    session_id: String,
) -> Result<(), String> {
    let Some(label) = reg.label_for(&session_id) else {
        return Err(format!("session {session_id} is not open in a window"));
    };
    focus_window(&app, &label)
}

#[tauri::command]
pub fn release_session(
    app: AppHandle,
    reg: State<'_, WindowSessionRegistry>,
    session_id: String,
) -> Result<(), String> {
    if let Some(label) = reg.label_for(&session_id) {
        reg.release_label(&label);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
        emit_snapshot(&app, &reg)?;
    }
    Ok(())
}

#[tauri::command]
pub fn complete_session_handoff(
    app: AppHandle,
    reg: State<'_, WindowSessionRegistry>,
    session_id: String,
) -> Result<(), String> {
    reg.complete_handoff(&session_id)
        .map_err(|error| match error {
            ClaimError::AlreadyOwned(existing) => {
                format!("session {session_id} is already owned by {existing}")
            }
            ClaimError::NotFound => format!("session {session_id} is not in handoff"),
            ClaimError::Poisoned => "window session registry lock poisoned".to_string(),
        })?;
    emit_snapshot(&app, &reg)
}

#[tauri::command]
pub fn open_session_window(
    app: AppHandle,
    reg: State<'_, WindowSessionRegistry>,
    session_id: String,
    handoff_from: Option<String>,
) -> Result<(), String> {
    let label = match handoff_from {
        Some(from_label) => match reg.begin_handoff(&session_id, &from_label) {
            Ok(label) => label,
            Err(ClaimError::AlreadyOwned(existing)) => {
                focus_window(&app, &existing)?;
                return Ok(());
            }
            Err(ClaimError::NotFound) => return Err("handoff source was not found".into()),
            Err(ClaimError::Poisoned) => return Err("window session registry lock poisoned".into()),
        },
        None => match reg.claim(&session_id) {
            Ok(label) => label,
            Err(ClaimError::AlreadyOwned(existing)) => {
                focus_window(&app, &existing)?;
                return Ok(());
            }
            Err(ClaimError::NotFound) => return Err("session window claim was not found".into()),
            Err(ClaimError::Poisoned) => return Err("window session registry lock poisoned".into()),
        },
    };

    let url = format!("index.html?sessionKey={}", session_query_key(&session_id));
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Goose")
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
            reg_for_close.release_label(&label_for_close);
            let _ = emit_snapshot(&app_for_close, &reg_for_close);
            let any_visible = app_for_close
                .webview_windows()
                .values()
                .any(|window| window.is_visible().unwrap_or(false));
            if !any_visible {
                app_for_close.exit(0);
            }
        }
    });

    emit_snapshot(&app, &reg)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn snapshot_lists_open_sessions() {
        let reg = WindowSessionRegistry::default();
        reg.claim("a").unwrap();
        reg.claim("b").unwrap();

        let mut snap = reg.snapshot();
        snap.sort_by(|left, right| left.session_id.cmp(&right.session_id));

        assert_eq!(
            snap,
            vec![
                SessionWindowEntry {
                    session_id: "a".into(),
                    window_label: label_for_session("a"),
                    mode: SessionWindowMode::Owned,
                },
                SessionWindowEntry {
                    session_id: "b".into(),
                    window_label: label_for_session("b"),
                    mode: SessionWindowMode::Owned,
                },
            ],
        );
    }

    #[test]
    fn labels_do_not_embed_raw_session_ids() {
        let label = label_for_session("session/with spaces?and=query");
        assert!(label.starts_with("session:"));
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
                },
            }),
        );
    }

    #[test]
    fn serializes_handoff_fields_for_typescript_consumers() {
        let value = serde_json::to_value(SessionWindowEntry {
            session_id: "s1".into(),
            window_label: label_for_session("s1"),
            mode: SessionWindowMode::Handoff {
                from_label: "main".into(),
                to_label: label_for_session("s1"),
            },
        })
        .expect("entry should serialize");

        assert_eq!(value["sessionId"], "s1");
        assert_eq!(value["mode"]["handoff"]["fromLabel"], "main");
        assert_eq!(value["mode"]["handoff"]["toLabel"], label_for_session("s1"),);
    }

    #[test]
    fn complete_handoff_promotes_destination_to_owner() {
        let reg = WindowSessionRegistry::default();
        reg.begin_handoff("s1", "main").unwrap();

        reg.complete_handoff("s1")
            .expect("handoff should be completable");

        assert_eq!(
            reg.entry_for("s1").map(|entry| entry.mode),
            Some(SessionWindowMode::Owned),
        );
    }

    #[test]
    fn closing_handoff_source_or_destination_releases_the_session() {
        let reg = WindowSessionRegistry::default();
        reg.begin_handoff("s1", "main").unwrap();

        reg.release_label("main");
        assert_eq!(reg.entry_for("s1"), None);

        reg.begin_handoff("s2", "main").unwrap();
        reg.release_label(&label_for_session("s2"));
        assert_eq!(reg.entry_for("s2"), None);
    }
}
