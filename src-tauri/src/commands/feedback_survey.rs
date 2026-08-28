use std::{fs, io::Write, path::PathBuf, sync::Mutex, time::SystemTime};

use serde::Deserialize;

const SESSION_SURVEY_COOLDOWN_FILE: &str = "session-feedback-survey-cooldown-v1";
const SESSION_SURVEY_COOLDOWN_MINIMUM_MS: u64 = 27 * 60 * 60 * 1_000;
const SESSION_SURVEY_COOLDOWN_JITTER_MS: u64 = 2 * 60 * 60 * 1_000;

/// Coordinates survey cooldown claims within one app process and restores the
/// persisted deadline after restart. Independent app processes may race; this
/// feedback path is intentionally best-effort.
pub struct SessionFeedbackSurveyCooldownState {
    path: PathBuf,
    next_eligible_at_ms: Mutex<u64>,
}

impl SessionFeedbackSurveyCooldownState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let path = app_data_dir.join(SESSION_SURVEY_COOLDOWN_FILE);
        let next_eligible_at_ms = fs::read_to_string(&path)
            .ok()
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0);
        Self {
            path,
            next_eligible_at_ms: Mutex::new(next_eligible_at_ms),
        }
    }

    fn claim(
        &self,
        input: SessionFeedbackSurveyCooldownInput,
        now_ms: u64,
    ) -> Result<bool, String> {
        if input.sampling_rate_basis_points > 10_000
            || !input.random.is_finite()
            || !(0.0..=1.0).contains(&input.random)
            || !input.cooldown_random.is_finite()
            || !(0.0..=1.0).contains(&input.cooldown_random)
        {
            return Err("invalid session feedback survey cooldown input".to_string());
        }
        let mut next_eligible_at_ms = self
            .next_eligible_at_ms
            .lock()
            .map_err(|_| "session feedback survey cooldown lock poisoned".to_string())?;
        if input.sampling_rate_basis_points == 0
            || now_ms < *next_eligible_at_ms
            || input.random * 10_000.0 >= f64::from(input.sampling_rate_basis_points)
        {
            return Ok(false);
        }

        let jitter_ms = (input.cooldown_random * SESSION_SURVEY_COOLDOWN_JITTER_MS as f64) as u64;
        let claimed_until = now_ms
            .saturating_add(SESSION_SURVEY_COOLDOWN_MINIMUM_MS)
            .saturating_add(jitter_ms);
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "survey cooldown path has no parent".to_string())?;
        let mut part_file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| format!("failed to persist survey cooldown: {error}"))?;
        part_file
            .write_all(claimed_until.to_string().as_bytes())
            .map_err(|error| format!("failed to persist survey cooldown: {error}"))?;
        part_file
            .persist(&self.path)
            .map_err(|error| format!("failed to finalize survey cooldown: {error}"))?;
        *next_eligible_at_ms = claimed_until;
        Ok(true)
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFeedbackSurveyCooldownInput {
    sampling_rate_basis_points: u16,
    random: f64,
    cooldown_random: f64,
}

#[tauri::command]
pub fn claim_session_feedback_survey_cooldown(
    state: tauri::State<'_, SessionFeedbackSurveyCooldownState>,
    input: SessionFeedbackSurveyCooldownInput,
) -> Result<bool, String> {
    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|error| format!("system clock is before Unix epoch: {error}"))?
        .as_millis()
        .try_into()
        .map_err(|_| "system time does not fit in milliseconds".to_string())?;
    state.claim(input, now_ms)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;

    #[test]
    fn cooldown_claim_is_process_atomic_and_persists_across_restart() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(SessionFeedbackSurveyCooldownState::new(
            dir.path().to_path_buf(),
        ));
        let barrier = Arc::new(Barrier::new(3));
        let input = SessionFeedbackSurveyCooldownInput {
            sampling_rate_basis_points: 250,
            random: 0.0,
            cooldown_random: 0.0,
        };
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let state = Arc::clone(&state);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    state.claim(input, 1_000).unwrap()
                })
            })
            .collect();
        barrier.wait();
        let selected = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|selected| *selected)
            .count();
        assert_eq!(selected, 1);

        let reloaded = SessionFeedbackSurveyCooldownState::new(dir.path().to_path_buf());
        assert!(!reloaded
            .claim(input, 1_000 + SESSION_SURVEY_COOLDOWN_MINIMUM_MS - 1)
            .unwrap());
        assert!(reloaded
            .claim(input, 1_000 + SESSION_SURVEY_COOLDOWN_MINIMUM_MS)
            .unwrap());
    }

    #[test]
    fn cooldown_applies_jitter_and_validates_input() {
        let dir = tempfile::tempdir().unwrap();
        let state = SessionFeedbackSurveyCooldownState::new(dir.path().to_path_buf());
        let input = SessionFeedbackSurveyCooldownInput {
            sampling_rate_basis_points: 10_000,
            random: 0.0,
            cooldown_random: 1.0,
        };
        assert!(state.claim(input, 1_000).unwrap());
        assert!(!state
            .claim(
                input,
                1_000 + SESSION_SURVEY_COOLDOWN_MINIMUM_MS + SESSION_SURVEY_COOLDOWN_JITTER_MS - 1,
            )
            .unwrap());
        assert!(state
            .claim(
                input,
                1_000 + SESSION_SURVEY_COOLDOWN_MINIMUM_MS + SESSION_SURVEY_COOLDOWN_JITTER_MS,
            )
            .unwrap());
        assert!(state
            .claim(
                SessionFeedbackSurveyCooldownInput {
                    random: f64::NAN,
                    ..input
                },
                u64::MAX,
            )
            .is_err());
    }
}
