//! Berd-owned credentials for OpenAI voice services.

const KEYCHAIN_SERVICE: &str = "berd-openai-voice";
const KEYCHAIN_ACCOUNT: &str = "api-key";

#[derive(Clone, Copy)]
pub(crate) enum OpenAiVoiceCredential {
    SpeechToText,
    TextToSpeech,
    Realtime,
}

impl OpenAiVoiceCredential {
    const fn account(self) -> &'static str {
        match self {
            Self::SpeechToText | Self::TextToSpeech | Self::Realtime => KEYCHAIN_ACCOUNT,
        }
    }

    const fn missing_message(self) -> &'static str {
        match self {
            Self::SpeechToText => {
                "OpenAI speech-to-text is not configured. Add the shared OpenAI voice API key in Voice settings, then try again."
            }
            Self::TextToSpeech => {
                "OpenAI text-to-speech is not configured. Add the shared OpenAI voice API key in Voice settings, then try again."
            }
            Self::Realtime => {
                "OpenAI Realtime voice is not configured. Add the shared OpenAI voice API key in Voice settings, then try again."
            }
        }
    }
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|error| format!("Could not access Berd's OpenAI voice credentials: {error}"))
}

fn read_account(account: &str) -> Result<Option<String>, String> {
    let entry = entry(account)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Could not read Berd's OpenAI voice credential: {error}"
        )),
    }
}

fn clear_account(account: &str) -> Result<(), String> {
    let entry = entry(account)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Could not remove Berd's OpenAI voice credential: {error}"
        )),
    }
}

pub(crate) fn read(credential: OpenAiVoiceCredential) -> Result<Option<String>, String> {
    read_account(credential.account())
}

pub(crate) fn store(credential: OpenAiVoiceCredential, api_key: &str) -> Result<(), String> {
    let entry = entry(credential.account())?;
    entry
        .set_password(api_key)
        .map_err(|error| format!("Could not save Berd's OpenAI voice credential: {error}"))
}

pub(crate) fn clear(credential: OpenAiVoiceCredential) -> Result<(), String> {
    clear_account(credential.account())
}

pub(crate) fn require(credential: OpenAiVoiceCredential) -> Result<String, String> {
    read(credential)?.ok_or_else(|| credential.missing_message().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speech_services_use_the_shared_voice_keychain_account() {
        assert_eq!(OpenAiVoiceCredential::SpeechToText.account(), "api-key");
        assert_eq!(OpenAiVoiceCredential::TextToSpeech.account(), "api-key");
        assert_eq!(OpenAiVoiceCredential::Realtime.account(), "api-key");
    }
}
