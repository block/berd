use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::commands::{artifacts, avatars};

const LOCAL_MEDIA_CACHES_CLEARED_EVENT: &str = "berd:local-media-caches-cleared";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalMediaCachesClearedPayload {
    avatars: bool,
    artifacts: bool,
}

#[tauri::command]
pub async fn clear_local_media_caches(app: AppHandle) -> Result<(), String> {
    let avatar_result = avatars::clear_avatar_cache(app.clone()).await;
    let artifacts_result = artifacts::clear_artifacts_cache(app.clone()).await;

    clear_local_media_caches_result(avatar_result, artifacts_result, |payload| {
        app.emit(LOCAL_MEDIA_CACHES_CLEARED_EVENT, payload)
            .map_err(|error| format!("Failed to emit local media cache clear event: {error}"))
    })
}

fn clear_local_media_caches_result(
    avatar_result: Result<(), String>,
    artifacts_result: Result<(), String>,
    emit_cleared: impl FnOnce(LocalMediaCachesClearedPayload) -> Result<(), String>,
) -> Result<(), String> {
    let payload = LocalMediaCachesClearedPayload {
        avatars: avatar_result.is_ok(),
        artifacts: artifacts_result.is_ok(),
    };

    let emit_result = if payload.avatars || payload.artifacts {
        emit_cleared(payload)
    } else {
        Ok(())
    };

    let mut errors = Vec::new();
    if let Err(error) = avatar_result {
        errors.push(format!("avatars: {error}"));
    }
    if let Err(error) = artifacts_result {
        errors.push(format!("artifact assets: {error}"));
    }

    if !errors.is_empty() {
        Err(format!(
            "Failed to clear local media caches: {}",
            errors.join("; ")
        ))
    } else {
        emit_result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn clear_result_emits_event_and_succeeds_when_both_caches_clear() {
        let emitted = RefCell::new(None);

        let result = clear_local_media_caches_result(Ok(()), Ok(()), |payload| {
            emitted.replace(Some(payload));
            Ok(())
        });

        assert!(result.is_ok());
        assert_eq!(
            emitted.into_inner(),
            Some(LocalMediaCachesClearedPayload {
                avatars: true,
                artifacts: true,
            })
        );
    }

    #[test]
    fn clear_result_emits_partial_event_and_fails_when_artifacts_fail() {
        let emitted = RefCell::new(None);

        let result = clear_local_media_caches_result(
            Ok(()),
            Err("permission denied".to_string()),
            |payload| {
                emitted.replace(Some(payload));
                Ok(())
            },
        );

        assert_eq!(
            result.unwrap_err(),
            "Failed to clear local media caches: artifact assets: permission denied"
        );
        assert_eq!(
            emitted.into_inner(),
            Some(LocalMediaCachesClearedPayload {
                avatars: true,
                artifacts: false,
            })
        );
    }

    #[test]
    fn clear_result_does_not_emit_event_when_both_caches_fail() {
        let emitted = RefCell::new(false);

        let result = clear_local_media_caches_result(
            Err("avatar locked".to_string()),
            Err("project locked".to_string()),
            |_| {
                emitted.replace(true);
                Ok(())
            },
        );

        assert_eq!(
            result.unwrap_err(),
            "Failed to clear local media caches: avatars: avatar locked; artifact assets: project locked"
        );
        assert!(!emitted.into_inner());
    }
}
