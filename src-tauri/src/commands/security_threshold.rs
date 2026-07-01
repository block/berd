use std::fs;

use crate::services::goose_config;

const THRESHOLD_KEY: &str = "SECURITY_PROMPT_THRESHOLD";
const DEFAULT_THRESHOLD: f64 = 0.8;
const MIN_THRESHOLD: f64 = 0.0;
const MAX_THRESHOLD: f64 = 1.0;

#[tauri::command]
pub fn get_security_threshold() -> Result<f64, String> {
    let path = goose_config::config_path()?;

    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DEFAULT_THRESHOLD);
        }
        Err(error) => return Err(format!("failed to read goose config: {error}")),
    };

    let value: yaml_serde::Value = yaml_serde::from_str(&contents)
        .map_err(|error| format!("failed to parse goose config: {error}"))?;

    let threshold = value
        .get(THRESHOLD_KEY)
        .and_then(|value| value.as_f64())
        .unwrap_or(DEFAULT_THRESHOLD);

    Ok(threshold)
}

#[tauri::command]
pub fn set_security_threshold(threshold: f64) -> Result<(), String> {
    if !threshold.is_finite() || !(MIN_THRESHOLD..=MAX_THRESHOLD).contains(&threshold) {
        return Err(format!(
            "threshold must be between {MIN_THRESHOLD} and {MAX_THRESHOLD}"
        ));
    }

    let path = goose_config::config_path()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create goose config directory: {error}"))?;
    }

    let mut value: yaml_serde::Value = match fs::read_to_string(&path) {
        Ok(contents) if !contents.trim().is_empty() => yaml_serde::from_str(&contents)
            .map_err(|error| format!("failed to parse goose config: {error}"))?,
        Ok(_) => yaml_serde::Value::Mapping(yaml_serde::Mapping::new()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            yaml_serde::Value::Mapping(yaml_serde::Mapping::new())
        }
        Err(error) => return Err(format!("failed to read goose config: {error}")),
    };

    let mapping = value
        .as_mapping_mut()
        .ok_or_else(|| "goose config is not a mapping".to_string())?;

    mapping.insert(
        yaml_serde::Value::String(THRESHOLD_KEY.to_string()),
        yaml_serde::Value::Number(threshold.into()),
    );

    let serialized = yaml_serde::to_string(&value)
        .map_err(|error| format!("failed to serialize goose config: {error}"))?;

    fs::write(&path, serialized)
        .map_err(|error| format!("failed to write goose config: {error}"))?;

    Ok(())
}
