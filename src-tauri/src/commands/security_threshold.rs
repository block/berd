const SECURITY_ML_DISABLED_ERROR: &str = "security ML is disabled for this build";

#[tauri::command]
pub fn get_security_threshold() -> Result<f64, String> {
    Err(SECURITY_ML_DISABLED_ERROR.to_string())
}

#[tauri::command]
pub fn set_security_threshold(_threshold: f64) -> Result<(), String> {
    Err(SECURITY_ML_DISABLED_ERROR.to_string())
}
