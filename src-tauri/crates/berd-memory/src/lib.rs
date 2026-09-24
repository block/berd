#![cfg_attr(
    not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(
            feature = "portable-store",
            any(target_os = "macos", target_os = "linux", target_os = "windows")
        )
    )),
    doc = "Native storage is absent on unsupported targets.

```compile_fail
use berd_memory::store::MemoryStore;
```

Home discovery is absent too.

```compile_fail
use berd_memory::memory_root;
```"
)]

#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        feature = "portable-store",
        any(target_os = "macos", target_os = "linux", target_os = "windows")
    )
))]
pub mod store;

use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        feature = "portable-store",
        any(target_os = "macos", target_os = "linux", target_os = "windows")
    )
))]
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use unicode_general_category::{get_general_category, GeneralCategory};
use unicode_normalization::UnicodeNormalization;

pub const PENDING_FILE: &str = "pending.jsonl";
pub const DISMISSED_FILE: &str = "dismissed.jsonl";

#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        feature = "portable-store",
        any(target_os = "macos", target_os = "linux", target_os = "windows")
    )
))]
pub fn memory_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".me"))
        .ok_or_else(|| "No home directory".to_string())
}

pub fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsafeMemoryTextError {
    character: char,
}

impl std::fmt::Display for UnsafeMemoryTextError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Memory text can't include hidden Unicode control characters"
        )
    }
}

impl std::error::Error for UnsafeMemoryTextError {}

fn is_default_ignorable_outside_format_category(character: char) -> bool {
    matches!(
        character,
        '\u{034f}'
            | '\u{061c}'
            | '\u{115f}'..='\u{1160}'
            | '\u{17b4}'..='\u{17b5}'
            | '\u{180b}'..='\u{180d}'
            | '\u{180f}'
            | '\u{3164}'
            | '\u{ffa0}'
            | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0100}'..='\u{e01ef}'
    )
}

fn is_unsafe_format_character(character: char) -> bool {
    matches!(get_general_category(character), GeneralCategory::Format)
        || is_default_ignorable_outside_format_category(character)
}

fn assert_review_safe_text(content: &str) -> Result<(), UnsafeMemoryTextError> {
    for character in content.chars() {
        let code_point = character as u32;
        if is_unsafe_format_character(character)
            || (code_point <= 0x1f && !matches!(character, '\n' | '\t'))
            || (0x7f..=0x9f).contains(&code_point)
        {
            return Err(UnsafeMemoryTextError { character });
        }
    }
    Ok(())
}

fn normalize_line_endings(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

/// Normalize and validate one reviewed memory entry.
///
/// Memory review is a security boundary: this rejects hidden Unicode controls
/// instead of invisibly stripping them, then credential scanning and persistence
/// operate on this exact returned text. Emoji ZWJ sequences are rejected with
/// other zero-width joiners because memory entries are prose and should not
/// need invisible glyph composition.
pub fn normalize_memory_proposal_text(content: &str) -> Result<String, UnsafeMemoryTextError> {
    let normalized = normalize_line_endings(content).nfc().collect::<String>();
    let normalized = normalized.trim().to_string();
    assert_review_safe_text(&normalized)?;
    Ok(normalized)
}

pub fn normalize_memory_proposal_topic(
    topic: Option<&str>,
) -> Result<Option<String>, UnsafeMemoryTextError> {
    let Some(topic) = topic else {
        return Ok(None);
    };
    let normalized = normalize_line_endings(topic).nfc().collect::<String>();
    let normalized = normalized.trim().to_string();
    assert_review_safe_text(&normalized)?;
    Ok((!normalized.is_empty()).then_some(normalized))
}

/// Normalize and validate a complete memory document before approval.
pub fn normalize_memory_document_text(content: &str) -> Result<String, UnsafeMemoryTextError> {
    let normalized = normalize_line_endings(content).nfc().collect::<String>();
    assert_review_safe_text(&normalized)?;
    Ok(normalized)
}

pub fn normalized_fact(content: &str, topic: Option<&str>) -> String {
    format!(
        "{}\n{}",
        content.trim().to_lowercase(),
        topic.unwrap_or_default().trim().to_lowercase()
    )
}

pub fn suppression_fingerprint(content: &str, topic: Option<&str>, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b"\0");
    hasher.update(normalized_fact(content, topic).as_bytes());
    hex::encode(hasher.finalize())
}

pub fn same_fact(record: &Value, content: &str, topic: Option<&str>) -> bool {
    let record_content = record.get("content").and_then(Value::as_str).unwrap_or("");
    let record_topic = record.get("topic").and_then(Value::as_str);
    normalized_fact(record_content, record_topic) == normalized_fact(content, topic)
}

pub fn is_suppressed(record: &Value, content: &str, topic: Option<&str>) -> bool {
    let Some(salt) = record.get("salt").and_then(Value::as_str) else {
        return false;
    };
    record.get("fingerprint").and_then(Value::as_str)
        == Some(suppression_fingerprint(content, topic, salt).as_str())
}

pub fn looks_like_credential(content: &str) -> bool {
    let text = normalize_line_endings(content).nfc().collect::<String>();
    let text = text.trim();
    if text.is_empty() {
        return false;
    }
    let known = regex::Regex::new(
        r"(?i)(?:\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{12,}|\bASIA[0-9A-Z]{12,}|\bAIza[0-9A-Za-z_-]{30,}|\bya29\.[0-9A-Za-z_-]+|\bglpat-[A-Za-z0-9_-]{16,}|\bnpm_[A-Za-z0-9]{30,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-{3,}\s*BEGIN [A-Z ]*PRIVATE KEY)",
    )
    .expect("credential regex");
    if known.is_match(text) {
        return true;
    }
    let labelled = regex::Regex::new(
        r#"(?i)\b(?:pass(?:word|wd|phrase)|secret|api[\s_-]?key|access[\s_-]?(?:key|token)|auth[\s_-]?token|bearer|private[\s_-]?key|client[\s_-]?secret|credentials?|otp|mfa[\s_-]?code|pin|cvv|cvc|passcode|security[\s_-]?code|routing[\s_-]?number|account[\s_-]?number|ssn|social security)\b[\s:=>-]{1,4}["'`]?([^\s"'`]{3,})"#,
    )
    .expect("labelled credential regex");
    labelled.captures(text).is_some_and(|capture| {
        let value = capture
            .get(1)
            .map(|match_| match_.as_str())
            .unwrap_or_default();
        value.chars().any(char::is_numeric)
            || value.chars().any(|character| !character.is_alphanumeric())
            || (value.chars().any(char::is_uppercase) && value.chars().any(char::is_lowercase))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppression_never_contains_original_content() {
        let fingerprint = suppression_fingerprint("Private preference", Some("Home"), "salt");
        assert!(!fingerprint.contains("Private preference"));
    }

    #[test]
    fn credentials_are_detected() {
        assert!(looks_like_credential("PIN: 1234"));
        assert!(looks_like_credential("API key: ghp_16CharsAtLeastHere00"));
        assert!(!looks_like_credential("I use 1Password"));
    }

    #[test]
    fn credentials_are_detected_after_unicode_normalization() {
        assert!(looks_like_credential("API key: ghp_16CharsAtLeastHere00"));
        assert!(looks_like_credential("PIN: 1234"));
    }

    #[test]
    fn normalizes_visible_unicode_and_line_endings() {
        assert_eq!(
            normalize_memory_proposal_text("  cafe\u{301} prefers 中文\r\n  ").unwrap(),
            "café prefers 中文"
        );
        assert_eq!(
            normalize_memory_document_text("# Cafe\u{301}\r\n\tTabbed\n").unwrap(),
            "# Café\n\tTabbed\n"
        );
    }

    #[test]
    fn normalizes_and_rejects_unsafe_topics() {
        assert_eq!(
            normalize_memory_proposal_topic(Some(" Travel\r\n ")).unwrap(),
            Some("Travel".to_string())
        );
        assert_eq!(normalize_memory_proposal_topic(Some("   ")).unwrap(), None);
        assert!(normalize_memory_proposal_topic(Some("Tra\u{202e}vel")).is_err());
    }

    #[test]
    fn rejects_hidden_unicode_and_control_characters() {
        for unsafe_text in [
            "ghp_16Chars\u{200b}AtLeastHere00",
            "abc\u{202e}txt",
            "abc\u{2066}txt\u{2069}",
            "abc\u{0007}txt",
            "abc\u{0085}txt",
            "abc\u{e0020}txt",
            "abc\u{e0100}txt",
            "family 👨‍👩‍👧‍👦",
        ] {
            assert!(
                normalize_memory_proposal_text(unsafe_text).is_err(),
                "{unsafe_text:?} should be rejected"
            );
        }
    }

    #[test]
    fn preserves_ordinary_visible_unicode_and_emoji_without_zwj() {
        let text = "São Paulo résumé Привет 中文 🚀";
        assert_eq!(normalize_memory_proposal_text(text).unwrap(), text);
    }
}
