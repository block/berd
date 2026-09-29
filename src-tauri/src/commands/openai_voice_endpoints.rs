//! Independent, user-selected OpenAI-compatible voice endpoints.

use berd_call::endpoint_url::{is_allowed_endpoint_url, EndpointProtocol};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::services::atomic_file::write_bytes_atomically;

pub(crate) const REALTIME_DEFAULT: &str = "wss://api.openai.com/v1/realtime";
pub(crate) const STT_DEFAULT: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
pub(crate) const TTS_DEFAULT: &str = "https://api.openai.com/v1/audio/speech";
pub(crate) const SETTINGS_CHANGED_EVENT: &str = "openai-voice:settings-changed";
const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
pub(crate) const BASE_URL_ENV: &str = "BERD_OPENAI_VOICE_BASE_URL";
static SETTINGS_UPDATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum VoiceEndpointKind {
    Realtime,
    Stt,
    Tts,
}

impl VoiceEndpointKind {
    pub(crate) const fn default_url(self) -> &'static str {
        match self {
            Self::Realtime => REALTIME_DEFAULT,
            Self::Stt => STT_DEFAULT,
            Self::Tts => TTS_DEFAULT,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceEndpointSettings {
    #[serde(default)]
    pub realtime: Option<String>,
    #[serde(default)]
    pub stt: Option<String>,
    #[serde(default)]
    pub tts: Option<String>,
}

impl VoiceEndpointSettings {
    fn get(&self, kind: VoiceEndpointKind) -> Option<&str> {
        match kind {
            VoiceEndpointKind::Realtime => self.realtime.as_deref(),
            VoiceEndpointKind::Stt => self.stt.as_deref(),
            VoiceEndpointKind::Tts => self.tts.as_deref(),
        }
    }

    fn set(&mut self, kind: VoiceEndpointKind, value: Option<String>) {
        *match kind {
            VoiceEndpointKind::Realtime => &mut self.realtime,
            VoiceEndpointKind::Stt => &mut self.stt,
            VoiceEndpointKind::Tts => &mut self.tts,
        } = value;
    }
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::services::goose_config::config_path()?
        .parent()
        .ok_or_else(|| "Could not resolve Goose's configuration directory".to_string())?
        .join("openai-voice-endpoints.json"))
}

fn read_settings() -> Result<VoiceEndpointSettings, String> {
    let path = settings_path()?;
    read_settings_from(&path)
}

fn read_settings_from(path: &std::path::Path) -> Result<VoiceEndpointSettings, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not read OpenAI voice endpoints: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
        Err(error) => Err(format!("Could not read OpenAI voice endpoints: {error}")),
    }
}

fn persist(settings: &VoiceEndpointSettings) -> Result<(), String> {
    let _guard = SETTINGS_UPDATE_LOCK
        .lock()
        .map_err(|_| "OpenAI voice settings lock is poisoned".to_string())?;
    let path = settings_path()?;
    persist_to(&path, settings)
}

fn persist_to(path: &std::path::Path, settings: &VoiceEndpointSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!("Could not create OpenAI voice settings directory: {error}")
        })?;
    }
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Could not encode OpenAI voice endpoints: {error}"))?;
    write_bytes_atomically(path, &bytes)
        .map_err(|error| format!("Could not save OpenAI voice endpoints: {error}"))
}

fn update_settings_file(
    path: &std::path::Path,
    update: impl FnOnce(&mut VoiceEndpointSettings),
) -> Result<(), String> {
    let _guard = SETTINGS_UPDATE_LOCK
        .lock()
        .map_err(|_| "OpenAI voice settings lock is poisoned".to_string())?;
    let mut settings = read_settings_from(path)?;
    update(&mut settings);
    persist_to(path, &settings)
}

fn validate(kind: VoiceEndpointKind, raw: &str) -> Result<Option<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let mut url = url::Url::parse(raw).map_err(|error| format!("Invalid endpoint URL: {error}"))?;
    let protocol = match kind {
        VoiceEndpointKind::Realtime | VoiceEndpointKind::Stt => EndpointProtocol::WebSocket,
        VoiceEndpointKind::Tts => EndpointProtocol::Http,
    };
    if !is_allowed_endpoint_url(&url, protocol) {
        return Err("Endpoint must be a full URL with the correct protocol, HTTPS/WSS outside loopback, and no embedded credentials or fragment".into());
    }
    url.set_fragment(None);
    Ok(Some(url.to_string()))
}

fn normalize_base_url(raw_url: String) -> Result<String, String> {
    let mut url = url::Url::parse(&raw_url)
        .map_err(|error| format!("OpenAI voice endpoint is invalid: {error}"))?;
    if url.scheme() != "https" {
        return Err("OpenAI voice endpoint must use HTTPS".to_string());
    }
    let path = url.path().trim_end_matches('/').to_string();
    if path.is_empty() {
        url.set_path("/v1");
    } else {
        url.set_path(&path);
    }
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn base_url() -> Result<String, String> {
    let base = std::env::var(BASE_URL_ENV)
        .ok()
        .map(|value| value.trim().to_string());
    match base.filter(|value| !value.is_empty()) {
        Some(base) => normalize_base_url(base),
        None => Ok(DEFAULT_BASE_URL.to_string()),
    }
}

fn endpoint_for_base_url(base_url: &str, path: &str) -> Result<String, String> {
    let mut url = url::Url::parse(base_url)
        .map_err(|error| format!("OpenAI voice endpoint is invalid: {error}"))?;
    let base_path = url.path().trim_end_matches('/');
    url.set_path(&format!("{base_path}/{}", path.trim_start_matches('/')));
    Ok(url.to_string())
}

pub(crate) fn effective_url(kind: VoiceEndpointKind) -> Result<String, String> {
    if let Some(saved) = read_settings()?.get(kind) {
        return Ok(saved.to_string());
    }
    if !matches!(kind, VoiceEndpointKind::Realtime)
        && std::env::var_os("BERD_OPENAI_VOICE_BASE_URL").is_some()
    {
        let base = base_url()?;
        let path = match kind {
            VoiceEndpointKind::Stt => "realtime",
            VoiceEndpointKind::Tts => "audio/speech",
            VoiceEndpointKind::Realtime => unreachable!(),
        };
        let mut url = url::Url::parse(&endpoint_for_base_url(&base, path)?)
            .map_err(|error| format!("Invalid OpenAI voice endpoint: {error}"))?;
        if matches!(kind, VoiceEndpointKind::Stt) {
            url.set_scheme("wss").expect("https can become wss");
            url.query_pairs_mut().append_pair("intent", "transcription");
        }
        return Ok(url.to_string());
    }
    Ok(kind.default_url().to_string())
}

#[tauri::command]
pub(crate) fn get_openai_voice_endpoints() -> Result<VoiceEndpointSettings, String> {
    read_settings()
}

#[tauri::command]
pub(crate) fn set_openai_voice_endpoint(
    app: AppHandle,
    kind: VoiceEndpointKind,
    url: String,
) -> Result<(), String> {
    let selected = validate(kind, &url)?;
    update_settings_file(&settings_path()?, |settings| {
        settings.set(kind, selected.filter(|url| url != kind.default_url()));
    })?;
    app.emit(SETTINGS_CHANGED_EVENT, ())
        .map_err(|error| format!("Could not refresh OpenAI voice settings: {error}"))
}

pub(crate) fn reset() -> Result<(), String> {
    persist(&VoiceEndpointSettings::default())
}

pub(crate) fn restore(settings: &VoiceEndpointSettings) -> Result<(), String> {
    persist(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn concurrent_endpoint_updates_preserve_both_services() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("endpoints.json");
        let first_path = path.clone();
        let second_path = path.clone();
        let (first_started_tx, first_started_rx) = mpsc::channel();
        let (second_finished_tx, second_finished_rx) = mpsc::channel();

        let first = std::thread::spawn(move || {
            update_settings_file(&first_path, |settings| {
                settings.set(VoiceEndpointKind::Stt, Some("wss://stt.example".into()));
                first_started_tx.send(()).unwrap();
                // An unlocked update lets the second save complete against stale settings.
                let _ = second_finished_rx.recv_timeout(Duration::from_millis(300));
            })
            .unwrap();
        });
        first_started_rx.recv().unwrap();
        let second = std::thread::spawn(move || {
            update_settings_file(&second_path, |settings| {
                settings.set(VoiceEndpointKind::Tts, Some("https://tts.example".into()));
            })
            .unwrap();
            let _ = second_finished_tx.send(());
        });
        first.join().unwrap();
        second.join().unwrap();

        let saved = read_settings_from(&path).unwrap();
        assert_eq!(saved.stt.as_deref(), Some("wss://stt.example"));
        assert_eq!(saved.tts.as_deref(), Some("https://tts.example"));
    }

    #[test]
    fn base_url_environment_override_keeps_the_v1_root_and_custom_path() {
        assert_eq!(
            normalize_base_url("https://proxy.example".into()).unwrap(),
            "https://proxy.example/v1"
        );
        assert_eq!(
            normalize_base_url("https://proxy.example/v1/".into()).unwrap(),
            "https://proxy.example/v1"
        );
        assert_eq!(
            normalize_base_url("http://proxy.example".into()).unwrap_err(),
            "OpenAI voice endpoint must use HTTPS"
        );
        let base = normalize_base_url("https://proxy.example/openai?api-version=2026-01-01".into())
            .unwrap();
        assert_eq!(
            endpoint_for_base_url(&base, "audio/speech").unwrap(),
            "https://proxy.example/openai/audio/speech?api-version=2026-01-01"
        );
    }

    #[test]
    fn endpoints_are_full_urls_with_independent_openai_defaults() {
        assert_eq!(VoiceEndpointKind::Realtime.default_url(), REALTIME_DEFAULT);
        assert_eq!(VoiceEndpointKind::Stt.default_url(), STT_DEFAULT);
        assert_eq!(VoiceEndpointKind::Tts.default_url(), TTS_DEFAULT);
        assert!(validate(VoiceEndpointKind::Stt, "wss://example.test/stt?mode=live").is_ok());
        assert!(validate(
            VoiceEndpointKind::Tts,
            "https://example.test/audio/speech?api-version=1"
        )
        .is_ok());
        assert!(validate(VoiceEndpointKind::Tts, "wss://example.test/audio/speech").is_err());
        assert!(validate(VoiceEndpointKind::Tts, "http://example.test/audio/speech").is_err());
        assert!(validate(VoiceEndpointKind::Stt, "ws://example.test/realtime").is_err());
        assert!(validate(
            VoiceEndpointKind::Tts,
            "http://localhost:18870/v1/audio/speech"
        )
        .is_ok());
        assert!(validate(VoiceEndpointKind::Stt, "ws://[::1]:18870/v1/realtime").is_ok());
        assert!(validate(
            VoiceEndpointKind::Realtime,
            "wss://key@example.test/realtime"
        )
        .is_err());
    }
}
