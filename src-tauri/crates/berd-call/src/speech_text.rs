/// Speech-only normalization. Source text remains in the delivery ledger.
/// Labels stream immediately; destinations are discarded without buffering URLs.
#[derive(Debug, Default)]
pub(crate) struct SpeechTextSanitizer {
    label_depth: usize,
    after_label: bool,
    destination_depth: usize,
    quote: bool,
    escaped: bool,
}

impl SpeechTextSanitizer {
    pub(crate) fn sanitize_segment(&mut self, text: &str) -> String {
        let mut spoken = String::new();
        for ch in text.chars() {
            if self.destination_depth > 0 {
                if self.escaped {
                    self.escaped = false;
                } else if ch == '\\' {
                    self.escaped = true;
                } else if ch == '"' {
                    self.quote = !self.quote;
                } else if !self.quote && ch == '(' {
                    self.destination_depth = self.destination_depth.saturating_add(1);
                } else if !self.quote && ch == ')' {
                    self.destination_depth -= 1;
                }
                continue;
            }
            if self.after_label {
                self.after_label = false;
                if ch == '(' {
                    self.destination_depth = 1;
                    continue;
                }
            }
            if self.escaped {
                spoken.push(ch);
                self.escaped = false;
            } else if ch == '\\' && self.label_depth > 0 {
                self.escaped = true;
            } else if ch == '[' {
                // Brackets are silent, including ordinary bracketed prose.
                // This lets labels stream without buffering unclosed brackets.
                if spoken.ends_with('!') {
                    spoken.pop();
                }
                self.label_depth = self.label_depth.saturating_add(1);
            } else if ch == ']' && self.label_depth > 0 {
                self.label_depth -= 1;
                self.after_label = self.label_depth == 0;
            } else {
                spoken.push(ch);
            }
        }
        spoken
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_links_speak_labels_not_destinations() {
        let text = "See [OpenAI’s official error documentation](https://developers.openai.com/api/docs/guides/error-codes) and [the handler](https://github.com/aaif-goose/goose/blob/7debb275d36559ee4e81799362e7f638275dfed3/crates/goose-providers/src/http_status.rs#L290-L294).";
        assert_eq!(
            SpeechTextSanitizer::default().sanitize_segment(text),
            "See OpenAI’s official error documentation and the handler."
        );
    }

    #[test]
    fn links_are_safe_at_every_streaming_boundary() {
        let text = "See [café docs](https://example.com/a_(b)?x=1) now.";
        for split in text.char_indices().map(|(i, _)| i).chain([text.len()]) {
            let mut sanitizer = SpeechTextSanitizer::default();
            let mut spoken = sanitizer.sanitize_segment(&text[..split]);
            spoken.push_str(&sanitizer.sanitize_segment(&text[split..]));
            assert_eq!(spoken, "See café docs now.", "split {split}");
        }
        let mut sanitizer = SpeechTextSanitizer::default();
        let spoken: String = text
            .chars()
            .map(|ch| sanitizer.sanitize_segment(&ch.to_string()))
            .collect();
        assert_eq!(spoken, "See café docs now.");
    }

    #[test]
    fn image_alt_text_and_quoted_titles() {
        assert_eq!(
            SpeechTextSanitizer::default()
                .sanitize_segment("![diagram](https://example.com/a \"title ) here\") done"),
            "diagram done"
        );
    }

    #[test]
    fn prose_and_unfinished_labels_are_not_buffered() {
        let mut sanitizer = SpeechTextSanitizer::default();
        assert_eq!(
            sanitizer.sanitize_segment("Hello (world), [draft] text."),
            "Hello (world), draft text."
        );
        assert_eq!(
            sanitizer.sanitize_segment("An [unfinished label"),
            "An unfinished label"
        );
    }
}
