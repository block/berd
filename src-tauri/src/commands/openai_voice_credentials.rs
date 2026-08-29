//! Berd-owned credentials for OpenAI voice services.

const KEYCHAIN_SERVICE: &str = "berd-openai-voice";

#[derive(Clone, Copy)]
pub(crate) enum OpenAiVoiceCredential {
    TextToSpeech,
}

impl OpenAiVoiceCredential {
    const fn account(self) -> &'static str {
        match self {
            Self::TextToSpeech => "tts-api-key",
        }
    }

    const fn missing_message(self) -> &'static str {
        match self {
            Self::TextToSpeech => {
                "OpenAI text-to-speech is not configured. Add its API key in Voice settings, then try again."
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn read(credential: OpenAiVoiceCredential) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, credential.account())
        .map_err(|error| format!("Could not access Berd's OpenAI voice credentials: {error}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Could not read Berd's OpenAI voice credential: {error}"
        )),
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read(_credential: OpenAiVoiceCredential) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(target_os = "macos")]
pub(crate) fn store(credential: OpenAiVoiceCredential, api_key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, credential.account())
        .map_err(|error| format!("Could not access Berd's OpenAI voice credentials: {error}"))?;
    entry
        .set_password(api_key)
        .map_err(|error| format!("Could not save Berd's OpenAI voice credential: {error}"))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn store(_credential: OpenAiVoiceCredential, _api_key: &str) -> Result<(), String> {
    Err("OpenAI voice credentials are unsupported on this platform".to_string())
}

#[cfg(target_os = "macos")]
pub(crate) fn clear(credential: OpenAiVoiceCredential) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, credential.account())
        .map_err(|error| format!("Could not access Berd's OpenAI voice credentials: {error}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Could not remove Berd's OpenAI voice credential: {error}"
        )),
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn clear(_credential: OpenAiVoiceCredential) -> Result<(), String> {
    Err("OpenAI voice credentials are unsupported on this platform".to_string())
}

pub(crate) fn require(credential: OpenAiVoiceCredential) -> Result<String, String> {
    read(credential)?.ok_or_else(|| credential.missing_message().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_to_speech_uses_the_stable_voice_keychain_account() {
        assert_eq!(OpenAiVoiceCredential::TextToSpeech.account(), "tts-api-key");
    }
}
