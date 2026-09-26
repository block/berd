//! Berd-owned credentials for OpenAI voice services.

use sha2::{Digest, Sha256};

use super::openai_voice_endpoints::{self, VoiceEndpointKind};

const KEYCHAIN_SERVICE: &str = "berd-openai-voice";
const KEYCHAIN_ACCOUNT: &str = "api-key";

#[derive(Clone, Copy)]
pub(crate) enum OpenAiVoiceCredential {
    SpeechToText,
    TextToSpeech,
    Realtime,
}

impl OpenAiVoiceCredential {
    const fn kind(self) -> VoiceEndpointKind {
        match self {
            Self::SpeechToText => VoiceEndpointKind::Stt,
            Self::TextToSpeech => VoiceEndpointKind::Tts,
            Self::Realtime => VoiceEndpointKind::Realtime,
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

fn account(credential: OpenAiVoiceCredential) -> Result<String, String> {
    let kind = credential.kind();
    let url = openai_voice_endpoints::effective_url(kind)?;
    Ok(account_for_url(kind, &url))
}

fn account_for_url(kind: VoiceEndpointKind, url: &str) -> String {
    if url == kind.default_url() {
        return KEYCHAIN_ACCOUNT.to_string();
    }
    format!("endpoint-{}", hex::encode(Sha256::digest(url.as_bytes())))
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
    read_account(&account(credential)?)
}

/// Check only Keychain item metadata; status polling must never request secret access.
pub(crate) fn is_present(credential: OpenAiVoiceCredential) -> Result<bool, String> {
    let account = account(credential)?;
    #[cfg(target_os = "macos")]
    {
        use security_framework::item::{ItemClass, ItemSearchOptions};
        match ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(KEYCHAIN_SERVICE)
            .account(&account)
            .load_attributes(true)
            .skip_authenticated_items(true)
            .search()
        {
            Ok(items) => Ok(!items.is_empty()),
            Err(error) if error.code() == -25300 => Ok(false),
            Err(error) => Err(format!("Could not check Berd's voice credential: {error}")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(read_account(&account)?.is_some())
    }
}

pub(crate) fn store(credential: OpenAiVoiceCredential, api_key: &str) -> Result<(), String> {
    let entry = entry(&account(credential)?)?;
    entry
        .set_password(api_key)
        .map_err(|error| format!("Could not save Berd's OpenAI voice credential: {error}"))
}

pub(crate) fn clear(credential: OpenAiVoiceCredential) -> Result<(), String> {
    clear_account(&account(credential)?)
}

pub(crate) fn require(credential: OpenAiVoiceCredential) -> Result<String, String> {
    read(credential)?.ok_or_else(|| credential.missing_message().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speech_services_use_independent_endpoints() {
        assert!(matches!(
            OpenAiVoiceCredential::SpeechToText.kind(),
            VoiceEndpointKind::Stt
        ));
        assert!(matches!(
            OpenAiVoiceCredential::TextToSpeech.kind(),
            VoiceEndpointKind::Tts
        ));
        assert!(matches!(
            OpenAiVoiceCredential::Realtime.kind(),
            VoiceEndpointKind::Realtime
        ));
    }

    #[test]
    fn custom_endpoint_keys_never_alias_the_default_or_other_urls() {
        assert_eq!(
            account_for_url(
                VoiceEndpointKind::Realtime,
                VoiceEndpointKind::Realtime.default_url()
            ),
            "api-key"
        );
        assert_eq!(
            account_for_url(VoiceEndpointKind::Stt, VoiceEndpointKind::Stt.default_url()),
            "api-key"
        );
        assert_ne!(
            account_for_url(
                VoiceEndpointKind::Realtime,
                "wss://frankie.test/v1/realtime"
            ),
            "api-key"
        );
        assert_ne!(
            account_for_url(
                VoiceEndpointKind::Realtime,
                "wss://frankie.test/v1/realtime"
            ),
            account_for_url(VoiceEndpointKind::Realtime, "wss://other.test/v1/realtime")
        );
    }
}
