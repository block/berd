use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const MESSAGE_QUEUES_FILENAME: &str = "message-queues.json";
static MESSAGE_QUEUES_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn message_queues_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(MESSAGE_QUEUES_FILENAME))
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))
}

#[tauri::command]
pub async fn load_message_queues(app: AppHandle) -> Result<Option<String>, String> {
    let path = message_queues_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(serialized) => Ok(Some(serialized)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read message queues: {error}")),
    }
}

#[tauri::command]
pub async fn persist_message_queues(
    app: AppHandle,
    serialized: Option<String>,
) -> Result<(), String> {
    persist_message_queues_at_path(&message_queues_path(&app)?, serialized.as_deref())
}

#[tauri::command]
pub async fn persist_message_queue_updates(
    app: AppHandle,
    serialized_updates: String,
) -> Result<(), String> {
    persist_message_queue_updates_at_path(&message_queues_path(&app)?, &serialized_updates)
}

fn persist_message_queue_updates_at_path(
    path: &Path,
    serialized_updates: &str,
) -> Result<(), String> {
    let _guard = MESSAGE_QUEUES_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Message queue persistence lock was poisoned".to_string())?;
    let updates: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(serialized_updates)
            .map_err(|error| format!("Failed to parse message queue updates: {error}"))?;
    let mut queues = match fs::read_to_string(path) {
        Ok(serialized) => {
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&serialized)
                .map_err(|error| format!("Failed to parse persisted message queues: {error}"))?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(error) => return Err(format!("Failed to read message queues: {error}")),
    };
    for (session_id, records) in updates {
        if records.is_null() {
            queues.remove(&session_id);
        } else {
            queues.insert(session_id, records);
        }
    }
    let serialized = if queues.is_empty() {
        None
    } else {
        Some(
            serde_json::to_string(&queues)
                .map_err(|error| format!("Failed to serialize message queues: {error}"))?,
        )
    };
    persist_message_queues_at_path(path, serialized.as_deref())
}

fn persist_message_queues_at_path(path: &Path, serialized: Option<&str>) -> Result<(), String> {
    let Some(serialized) = serialized else {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to remove message queues: {error}")),
        };
    };
    let parent = path
        .parent()
        .ok_or_else(|| "Message queue path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create message queue directory: {error}"))?;
    let pending_path = path.with_extension("json.pending");
    fs::write(&pending_path, serialized)
        .map_err(|error| format!("Failed to write message queues: {error}"))?;
    fs::rename(&pending_path, path)
        .map_err(|error| format!("Failed to commit message queues: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_session_updates_without_losing_other_renderers_queues() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(MESSAGE_QUEUES_FILENAME);
        persist_message_queues_at_path(
            &path,
            Some(r#"{"main-only":[{"recordId":"large-image"}]}"#),
        )
        .unwrap();

        persist_message_queue_updates_at_path(&path, r#"{"detached":[{"recordId":"secondary"}]}"#)
            .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"detached":[{"recordId":"secondary"}],"main-only":[{"recordId":"large-image"}]}"#
        );

        persist_message_queue_updates_at_path(&path, r#"{"detached":null}"#).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"main-only":[{"recordId":"large-image"}]}"#
        );
    }

    #[test]
    fn writes_replaces_and_removes_queue_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(MESSAGE_QUEUES_FILENAME);

        persist_message_queues_at_path(&path, Some(r#"{"s1":[]}"#)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"s1":[]}"#);

        persist_message_queues_at_path(&path, Some(r#"{"s2":[1]}"#)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"s2":[1]}"#);

        persist_message_queues_at_path(&path, None).unwrap();
        assert!(!path.exists());
    }
}
