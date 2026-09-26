//! Independent, user-selected OpenAI-compatible voice endpoints.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::services::atomic_file::write_bytes_atomically;

pub(crate) const REALTIME_DEFAULT: &str = "wss://api.openai.com/v1/realtime";
pub(crate) const STT_DEFAULT: &str = "wss://api.openai.com/v1/realtime?intent=transcription";
pub(crate) const TTS_DEFAULT: &str = "https://api.openai.com/v1/audio/speech";
const SETTINGS_CHANGED_EVENT: &str = "openai-voice:settings-changed";

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
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not read OpenAI voice endpoints: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
        Err(error) => Err(format!("Could not read OpenAI voice endpoints: {error}")),
    }
}

fn persist(settings: &VoiceEndpointSettings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!("Could not create OpenAI voice settings directory: {error}")
        })?;
    }
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Could not encode OpenAI voice endpoints: {error}"))?;
    write_bytes_atomically(&path, &bytes)
        .map_err(|error| format!("Could not save OpenAI voice endpoints: {error}"))
}

fn validate(kind: VoiceEndpointKind, raw: &str) -> Result<Option<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let mut url = url::Url::parse(raw).map_err(|error| format!("Invalid endpoint URL: {error}"))?;
    let allowed = match kind {
        VoiceEndpointKind::Realtime | VoiceEndpointKind::Stt => ["ws", "wss"].as_slice(),
        VoiceEndpointKind::Tts => ["http", "https"].as_slice(),
    };
    if !allowed.contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Endpoint must be an absolute URL with the correct protocol and no embedded credentials or fragment".into());
    }
    url.set_fragment(None);
    Ok(Some(url.to_string()))
}

pub(crate) fn effective_url(kind: VoiceEndpointKind) -> Result<String, String> {
    if let Some(saved) = read_settings()?.get(kind) {
        return Ok(saved.to_string());
    }
    if !matches!(kind, VoiceEndpointKind::Realtime)
        && std::env::var_os("BERD_OPENAI_VOICE_BASE_URL").is_some()
    {
        let base = super::openai_audio::base_url()?;
        let path = match kind {
            VoiceEndpointKind::Stt => "realtime",
            VoiceEndpointKind::Tts => "audio/speech",
            VoiceEndpointKind::Realtime => unreachable!(),
        };
        let mut url = url::Url::parse(&super::openai_audio::endpoint_for_base_url(&base, path)?)
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
    let mut settings = read_settings()?;
    let selected = validate(kind, &url)?;
    settings.set(kind, selected.filter(|url| url != kind.default_url()));
    persist(&settings)?;
    app.emit(SETTINGS_CHANGED_EVENT, ())
        .map_err(|error| format!("Could not refresh OpenAI voice settings: {error}"))
}

pub(crate) fn reset() -> Result<(), String> {
    persist(&VoiceEndpointSettings::default())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(validate(
            VoiceEndpointKind::Realtime,
            "wss://key@example.test/realtime"
        )
        .is_err());
    }
}
