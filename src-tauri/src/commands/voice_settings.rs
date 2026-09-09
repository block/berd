use tauri::{AppHandle, Emitter, State};

use super::{openai_audio, pocket_voice, siri_voice};

const OPENAI_SETTINGS_CHANGED_EVENT: &str = "openai-voice:settings-changed";

fn transaction_error(primary: String, rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        return primary;
    }
    format!(
        "{primary}; restoring the previous voice settings also failed: {}",
        rollback_errors.join("; ")
    )
}

fn reset_transaction<P, S>(
    previous_pocket: &P,
    previous_siri: &S,
    mut reset_pocket: impl FnMut() -> Result<(), String>,
    mut reset_siri: impl FnMut() -> Result<(), String>,
    mut reset_openai: impl FnMut() -> Result<(), String>,
    mut restore_pocket: impl FnMut(&P) -> Result<(), String>,
    mut restore_siri: impl FnMut(&S) -> Result<(), String>,
) -> Result<(), String> {
    reset_pocket().map_err(|error| format!("reset Pocket voice settings: {error}"))?;

    if let Err(error) = reset_siri() {
        let rollback_errors = restore_pocket(previous_pocket)
            .err()
            .map(|cause| format!("Pocket: {cause}"))
            .into_iter()
            .collect();
        return Err(transaction_error(
            format!("reset Apple voice settings: {error}"),
            rollback_errors,
        ));
    }

    if let Err(error) = reset_openai() {
        let rollback_errors = [
            restore_siri(previous_siri)
                .err()
                .map(|cause| format!("Apple: {cause}")),
            restore_pocket(previous_pocket)
                .err()
                .map(|cause| format!("Pocket: {cause}")),
        ]
        .into_iter()
        .flatten()
        .collect();
        return Err(transaction_error(
            format!("reset OpenAI voice settings: {error}"),
            rollback_errors,
        ));
    }

    Ok(())
}

#[tauri::command]
pub fn reset_all_voice_backend_settings(
    app: AppHandle,
    openai_state: State<'_, openai_audio::OpenAiVoiceState>,
) -> Result<(), String> {
    let pocket_base = pocket_voice::cache_base(&app)?;
    let siri_path = siri_voice::settings_path(&app)?;
    let _pocket_guard = pocket_voice::POCKET_SETTINGS_LOCK
        .lock()
        .map_err(|_| "Pocket settings lock was poisoned".to_string())?;
    let _siri_guard = siri_voice::SIRI_SETTINGS_LOCK
        .lock()
        .map_err(|_| "Apple voice settings lock was poisoned".to_string())?;

    let previous_pocket = pocket_voice::settings(&pocket_base);
    let previous_siri = siri_voice::read_settings(&siri_path);
    reset_transaction(
        &previous_pocket,
        &previous_siri,
        || pocket_voice::write_settings(&pocket_base, &Default::default()),
        || siri_voice::write_settings(&siri_path, &Default::default()),
        || openai_audio::replace_voice_settings(&openai_state, &Default::default()),
        |settings| pocket_voice::write_settings(&pocket_base, settings),
        |settings| siri_voice::write_settings(&siri_path, settings),
    )?;

    if let Err(error) = app.emit(OPENAI_SETTINGS_CHANGED_EVENT, ()) {
        log::warn!("Could not refresh OpenAI voice settings after reset: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::reset_transaction;

    #[test]
    fn restores_completed_resets_when_a_later_backend_fails() {
        let pocket = Cell::new(7);
        let siri = Cell::new(8);

        let result = reset_transaction(
            &7,
            &8,
            || {
                pocket.set(0);
                Ok(())
            },
            || {
                siri.set(0);
                Ok(())
            },
            || Err("unavailable".to_string()),
            |previous| {
                pocket.set(*previous);
                Ok(())
            },
            |previous| {
                siri.set(*previous);
                Ok(())
            },
        );

        assert!(result.is_err());
        assert_eq!(pocket.get(), 7);
        assert_eq!(siri.get(), 8);
    }
}
