//! Berd-owned credentials for OpenAI voice services.

const KEYCHAIN_SERVICE: &str = "berd-openai-voice";
const KEYCHAIN_ACCOUNT: &str = "api-key";
const LEGACY_TTS_KEYCHAIN_ACCOUNT: &str = "tts-api-key";

#[derive(Clone, Copy)]
pub(crate) enum OpenAiVoiceCredential {
    SpeechToText,
    TextToSpeech,
}

impl OpenAiVoiceCredential {
    const fn account(self) -> &'static str {
        match self {
            Self::SpeechToText | Self::TextToSpeech => KEYCHAIN_ACCOUNT,
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

fn canonical_mutation_with_legacy_cleanup<T>(
    canonical_mutation: impl FnOnce() -> Result<T, String>,
    legacy_cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<T, String> {
    let value = canonical_mutation()?;
    if let Err(error) = legacy_cleanup() {
        log::warn!("Could not remove Berd's legacy OpenAI voice credential: {error}");
    }
    Ok(value)
}

pub(crate) fn read(credential: OpenAiVoiceCredential) -> Result<Option<String>, String> {
    if let Some(api_key) = read_account(credential.account())? {
        return Ok(Some(api_key));
    }
    let Some(api_key) = read_account(LEGACY_TTS_KEYCHAIN_ACCOUNT)? else {
        return Ok(None);
    };
    store(credential, &api_key)?;
    Ok(Some(api_key))
}

pub(crate) fn store(credential: OpenAiVoiceCredential, api_key: &str) -> Result<(), String> {
    let entry = entry(credential.account())?;
    canonical_mutation_with_legacy_cleanup(
        || {
            entry
                .set_password(api_key)
                .map_err(|error| format!("Could not save Berd's OpenAI voice credential: {error}"))
        },
        || clear_account(LEGACY_TTS_KEYCHAIN_ACCOUNT),
    )
}

pub(crate) fn clear(credential: OpenAiVoiceCredential) -> Result<(), String> {
    canonical_mutation_with_legacy_cleanup(
        || clear_account(credential.account()),
        || clear_account(LEGACY_TTS_KEYCHAIN_ACCOUNT),
    )
}

pub(crate) fn require(credential: OpenAiVoiceCredential) -> Result<String, String> {
    read(credential)?.ok_or_else(|| credential.missing_message().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn speech_services_use_the_shared_voice_keychain_account() {
        assert_eq!(OpenAiVoiceCredential::SpeechToText.account(), "api-key");
        assert_eq!(OpenAiVoiceCredential::TextToSpeech.account(), "api-key");
    }

    #[test]
    fn legacy_cleanup_failure_does_not_change_canonical_mutation_result() {
        let credential = RefCell::new(None);
        let save = canonical_mutation_with_legacy_cleanup(
            || {
                credential.replace(Some("shared-key"));
                Ok(())
            },
            || Err("legacy cleanup failed".to_string()),
        );
        assert_eq!(save, Ok(()));
        assert_eq!(*credential.borrow(), Some("shared-key"));

        let clear = canonical_mutation_with_legacy_cleanup(
            || {
                credential.replace(None);
                Ok(())
            },
            || Err("legacy cleanup failed".to_string()),
        );
        assert_eq!(clear, Ok(()));
        assert_eq!(*credential.borrow(), None);
    }
}
