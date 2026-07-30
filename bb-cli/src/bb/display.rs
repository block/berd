//! Small display layer for `bb skills` output.
//!
//! Centralizes color and message vocabulary so output sites stay consistent.
//! Color is suppressed by `--no-color`, `--json`, the `NO_COLOR` environment
//! variable, or when stdout is not a terminal.

use std::fmt::Write as _;
use std::io::IsTerminal;

use anyhow::{Context, Result};
use serde::Serialize;

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const RED: &str = "\x1b[31m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const CYAN: &str = "\x1b[36m";
const BOLD_CYAN: &str = "\x1b[1;36m";

#[derive(Debug, Clone, Copy)]
pub struct Style {
    color: bool,
    verbose: bool,
}

impl Style {
    pub fn new(no_color: bool, json: bool, verbose: bool) -> Self {
        let env_no_color = std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());
        let color = !no_color && !json && !env_no_color && std::io::stdout().is_terminal();
        Self { color, verbose }
    }

    fn paint(&self, code: &str, text: &str) -> String {
        if self.color {
            format!("{code}{text}{RESET}")
        } else {
            text.to_string()
        }
    }

    pub fn bold(&self, text: &str) -> String {
        self.paint(BOLD, text)
    }

    pub fn dim(&self, text: &str) -> String {
        self.paint(DIM, text)
    }

    pub fn green(&self, text: &str) -> String {
        self.paint(GREEN, text)
    }

    pub fn yellow(&self, text: &str) -> String {
        self.paint(YELLOW, text)
    }

    pub fn red(&self, text: &str) -> String {
        self.paint(RED, text)
    }

    pub fn cyan(&self, text: &str) -> String {
        self.paint(CYAN, text)
    }

    /// Emphasized identifier styling (skill slugs, command names).
    pub fn slug(&self, text: &str) -> String {
        self.paint(BOLD_CYAN, text)
    }

    /// Render a field label like `tags:` so key/value output reads at a
    /// glance; the value stays in the default color.
    pub fn label(&self, text: &str) -> String {
        self.cyan(text)
    }

    /// Print a success line: `✓ message`.
    pub fn success(&self, message: &str) {
        println!("{} {message}", self.green("✓"));
    }

    /// Print an informational line: `• message`.
    pub fn info(&self, message: &str) {
        println!("{} {message}", self.cyan("•"));
    }

    /// Print a warning line to stderr: `! message`.
    pub fn warn(&self, message: &str) {
        eprintln!("{} {message}", self.yellow("!"));
    }

    /// Log a verbose diagnostic line to stderr when `--verbose` is set.
    pub fn verbose(&self, message: &str) {
        if self.verbose {
            eprintln!("{}", self.dim(&format!("[verbose] {message}")));
        }
    }
}

/// True when stdin is attached to an interactive terminal, meaning the CLI
/// may prompt for confirmation instead of requiring `--yes`.
pub fn stdin_is_tty() -> bool {
    std::io::stdin().is_terminal()
}

pub fn print_json<T: Serialize>(value: &T) -> Result<()> {
    let json = serde_json::to_string_pretty(value).context("serialize JSON output")?;
    println!("{}", json_with_escaped_bidi_controls(&json));
    Ok(())
}

pub fn terminal_safe_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_control() || is_bidi_control(character) {
            escaped.extend(character.escape_default());
        } else {
            escaped.push(character);
        }
    }
    escaped
}

fn json_with_escaped_bidi_controls(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if is_bidi_control(character) {
            write!(escaped, "\\u{:04x}", character as u32)
                .expect("writing to a String cannot fail");
        } else {
            escaped.push(character);
        }
    }
    escaped
}

fn is_bidi_control(character: char) -> bool {
    matches!(
        character,
        '\u{061c}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
    )
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    #[test]
    fn terminal_safe_text_escapes_controls_and_preserves_unicode() {
        assert_eq!(
            terminal_safe_text("Workspace\u{1b}]52;c;secret\u{7}\n\u{202e}fake\u{2066}日本語"),
            "Workspace\\u{1b}]52;c;secret\\u{7}\\n\\u{202e}fake\\u{2066}日本語"
        );
    }

    #[test]
    fn json_with_escaped_bidi_controls_remains_valid_json() {
        let input = format!(r#"{{"name":"safe{}fake{}日本語"}}"#, '\u{202e}', '\u{2066}');
        let escaped = json_with_escaped_bidi_controls(&input);

        assert_eq!(escaped, r#"{"name":"safe\u202efake\u2066日本語"}"#);
        let parsed: Value = serde_json::from_str(&escaped).expect("valid escaped JSON");
        assert_eq!(parsed["name"], "safe\u{202e}fake\u{2066}日本語");
    }
}
