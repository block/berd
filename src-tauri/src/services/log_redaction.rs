//! Shared log-line redaction.
//!
//! `redact_log_line` masks the values of a fixed allowlist of secret-ish keys
//! (`authorization`, `api_key`, `token`, …) wherever they appear in a line. It
//! is applied both when capturing the goosed sidecar's stdout/stderr into the
//! Tauri shell log (see `services::acp::goose_serve`) and when exporting the
//! shell log for a feedback attachment (see `services::log_export`).
//!
//! NOTE: this is a *key-based* redactor — it scrubs `key=value` / `key: "value"`
//! pairs, not free-form prose. It cannot tell whether arbitrary text contains
//! user/LLM content. Callers that export logs must additionally drop any line
//! that can carry such content (see `sanitize_app_log_line`).

/// Substrings that identify lines echoing the goosed sidecar's captured
/// stdout/stderr. Those lines can contain free-form user or LLM content that
/// the key-based redactor cannot scrub, so they are dropped before export.
const SIDECAR_CAPTURE_MARKERS: [&str; 2] = ["[goose serve stdout]", "[goose serve stderr]"];

pub(crate) fn redact_log_line(line: &str) -> String {
    [
        "goose_server__secret_key",
        "authorization",
        "refresh_token",
        "access_token",
        "secret_key",
        "api_key",
        "apikey",
        "password",
        "secret",
        "token",
    ]
    .into_iter()
    .fold(line.to_string(), redact_sensitive_key)
}

/// Sanitize one line of the Tauri shell log (`goose.log`) for export.
///
/// Returns `None` for lines that echo the goosed sidecar's captured
/// stdout/stderr — those are dropped because they can carry conversation/LLM
/// content the key-based redactor would not catch (and the same diagnostics are
/// already covered, content-free, by goosed's own `logs/{cli,server}` files).
/// All other lines are passed through [`redact_log_line`].
pub(crate) fn sanitize_app_log_line(line: &str) -> Option<String> {
    if SIDECAR_CAPTURE_MARKERS
        .iter()
        .any(|marker| line.contains(marker))
    {
        return None;
    }
    Some(redact_log_line(line))
}

fn redact_sensitive_key(line: String, key: &str) -> String {
    let mut redacted = line;
    let mut search_start = 0;

    loop {
        let lower = redacted.to_ascii_lowercase();
        let Some(relative_key_start) = lower[search_start..].find(key) else {
            break;
        };
        let key_start = search_start + relative_key_start;
        let key_end = key_start + key.len();

        if !is_key_boundary(lower.as_bytes(), key_start, key_end) {
            search_start = key_end;
            continue;
        }

        let mut delimiter_index = key_end;
        if matches!(
            lower.as_bytes().get(delimiter_index).copied(),
            Some(b'"' | b'\'')
        ) {
            delimiter_index += 1;
        }
        delimiter_index = skip_ascii_whitespace(lower.as_bytes(), delimiter_index);

        if !matches!(
            lower.as_bytes().get(delimiter_index).copied(),
            Some(b':' | b'=')
        ) {
            search_start = delimiter_index;
            continue;
        }

        let mut value_start = skip_ascii_whitespace(lower.as_bytes(), delimiter_index + 1);
        let quote = match lower.as_bytes().get(value_start).copied() {
            Some(b'"') => {
                value_start += 1;
                Some(b'"')
            }
            Some(b'\'') => {
                value_start += 1;
                Some(b'\'')
            }
            _ => None,
        };

        let value_end = find_value_end(lower.as_bytes(), value_start, quote, key);
        if value_end <= value_start {
            search_start = value_start;
            continue;
        }

        redacted.replace_range(value_start..value_end, "[redacted]");
        search_start = value_start + "[redacted]".len();
    }

    redacted
}

fn is_key_boundary(bytes: &[u8], key_start: usize, key_end: usize) -> bool {
    let before_is_key_char = key_start
        .checked_sub(1)
        .and_then(|index| bytes.get(index))
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'));
    let after_is_key_char = bytes
        .get(key_end)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'));

    !before_is_key_char && !after_is_key_char
}

fn skip_ascii_whitespace(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while bytes
        .get(index)
        .is_some_and(|byte| byte.is_ascii_whitespace())
    {
        index += 1;
    }
    index
}

fn find_value_end(bytes: &[u8], value_start: usize, quote: Option<u8>, key: &str) -> usize {
    if let Some(quote) = quote {
        return bytes[value_start..]
            .iter()
            .position(|byte| *byte == quote)
            .map(|relative| value_start + relative)
            .unwrap_or(bytes.len());
    }

    let allow_spaces = key == "authorization";
    let mut value_end = value_start;
    while let Some(byte) = bytes.get(value_end) {
        if matches!(*byte, b',' | b';' | b'&') || (!allow_spaces && byte.is_ascii_whitespace()) {
            break;
        }
        value_end += 1;
    }
    value_end
}

#[cfg(test)]
mod tests {
    use super::{redact_log_line, sanitize_app_log_line};

    #[test]
    fn redacts_common_secret_key_value_pairs() {
        let redacted =
            redact_log_line("token=abc123 api_key: xyz password = hunter2 secret='keep' ok=value");

        assert_eq!(
            redacted,
            "token=[redacted] api_key: [redacted] password = [redacted] secret='[redacted]' ok=value"
        );
    }

    #[test]
    fn redacts_json_style_secret_values() {
        let redacted = redact_log_line(
            r#"{"authorization":"Bearer abc.def","GOOSE_SERVER__SECRET_KEY":"local-secret"}"#,
        );

        assert_eq!(
            redacted,
            r#"{"authorization":"[redacted]","GOOSE_SERVER__SECRET_KEY":"[redacted]"}"#
        );
    }

    #[test]
    fn redacts_unquoted_authorization_header_value_with_spaces() {
        let redacted = redact_log_line("Authorization: Bearer abc.def, status=401");

        assert_eq!(redacted, "Authorization: [redacted], status=401");
    }

    #[test]
    fn sanitize_drops_captured_sidecar_lines_and_redacts_the_rest() {
        // Captured goosed stdout/stderr lines are dropped wholesale.
        assert_eq!(
            sanitize_app_log_line("[2026-01-01][INFO] [goose serve stdout] user said hello"),
            None
        );
        assert_eq!(
            sanitize_app_log_line("[2026-01-01][WARN] [goose serve stderr] panic: secret stuff"),
            None
        );

        // Native shell-log lines are kept, with secret values still redacted.
        assert_eq!(
            sanitize_app_log_line("[INFO] Spawning goose serve token=abc port=1234"),
            Some("[INFO] Spawning goose serve token=[redacted] port=1234".to_string())
        );
    }
}
