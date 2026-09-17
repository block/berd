use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const APPROVED_CONTENT_FILE: &str = ".approved-content.json";

pub fn memory_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".me"))
        .ok_or_else(|| "No home directory".to_string())
}

fn approved_key(root: &Path, target: &Path) -> Result<String, String> {
    target
        .strip_prefix(root)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "Memory path escaped the store".to_string())
}

fn content_hash(contents: &str) -> String {
    hex::encode(Sha256::digest(contents.as_bytes()))
}

fn approved_manifest(root: &Path) -> Option<BTreeMap<String, String>> {
    let contents = fs::read_to_string(root.join(APPROVED_CONTENT_FILE)).ok()?;
    serde_json::from_str(&contents).ok()
}

/// Mark one exact document version as approved. The manifest replacement is
/// atomic, so readers see either the previous complete map or the new one.
fn atomic_replace(temporary: &Path, target: &Path) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    let result = fs::rename(temporary, target);

    #[cfg(target_os = "windows")]
    let result = {
        use std::os::windows::ffi::OsStrExt;
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
        }
        let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let ok = unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    };

    result.map_err(|error| {
        let _ = fs::remove_file(temporary);
        format!("Couldn't replace '{}': {error}", target.display())
    })
}

pub fn mark_content_approved(root: &Path, target: &Path, contents: &str) -> Result<(), String> {
    let path = root.join(APPROVED_CONTENT_FILE);
    let mut manifest = approved_manifest(root).unwrap_or_default();
    manifest.insert(approved_key(root, target)?, content_hash(contents));
    let body = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    let temporary = root.join(format!("{APPROVED_CONTENT_FILE}.tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&temporary, body)
        .map_err(|error| format!("Failed to write approved memory manifest: {error}"))?;
    atomic_replace(&temporary, &path)
}

/// Missing, malformed, or mismatched manifests are never treated as approval.
pub fn content_is_approved(root: &Path, target: &Path, contents: &str) -> bool {
    let Ok(key) = approved_key(root, target) else {
        return false;
    };
    approved_manifest(root)
        .and_then(|manifest| manifest.get(&key).cloned())
        .is_some_and(|hash| hash == content_hash(contents))
}

pub fn looks_like_credential(content: &str) -> bool {
    let text = content.trim();
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
        let value = capture.get(1).map(|match_| match_.as_str()).unwrap_or_default();
        value.chars().any(char::is_numeric)
            || value.chars().any(|character| !character.is_alphanumeric())
            || (value.chars().any(char::is_uppercase)
                && value.chars().any(char::is_lowercase))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_detected() {
        assert!(looks_like_credential("PIN: 1234"));
        assert!(looks_like_credential("API key: ghp_16CharsAtLeastHere00"));
        assert!(!looks_like_credential("I use 1Password"));
    }

    #[test]
    fn approved_content_requires_an_exact_valid_manifest_entry() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        let target = root.join("me.md");
        fs::create_dir_all(&root).unwrap();
        fs::write(&target, "approved").unwrap();

        assert!(!content_is_approved(&root, &target, "approved"));
        fs::write(root.join(APPROVED_CONTENT_FILE), "not json").unwrap();
        assert!(!content_is_approved(&root, &target, "approved"));

        mark_content_approved(&root, &target, "approved").unwrap();
        assert!(content_is_approved(&root, &target, "approved"));
        assert!(!content_is_approved(&root, &target, "changed"));
    }

    #[test]
    fn approval_manifest_never_accepts_paths_outside_the_store() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        fs::create_dir_all(&root).unwrap();
        assert!(mark_content_approved(&root, &temp.path().join("outside.md"), "x").is_err());
    }
}
