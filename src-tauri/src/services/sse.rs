use std::str;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SseMessage {
    pub(crate) id: Option<String>,
    pub(crate) event: String,
    pub(crate) data: String,
}

#[derive(Default)]
pub(crate) struct SseDecoder {
    utf8_buffer: Vec<u8>,
    text_buffer: String,
}

impl SseDecoder {
    pub(crate) fn push_chunk(&mut self, chunk: &[u8]) -> Vec<SseMessage> {
        self.utf8_buffer.extend_from_slice(chunk);
        loop {
            match str::from_utf8(&self.utf8_buffer) {
                Ok(text) => {
                    self.text_buffer.push_str(text);
                    self.utf8_buffer.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        let valid_text = str::from_utf8(&self.utf8_buffer[..valid_up_to])
                            .expect("valid utf8 prefix");
                        self.text_buffer.push_str(valid_text);
                    }
                    if let Some(error_len) = error.error_len() {
                        self.utf8_buffer.drain(..valid_up_to + error_len);
                        continue;
                    }
                    self.utf8_buffer.drain(..valid_up_to);
                    break;
                }
            }
        }
        drain_sse_messages(&mut self.text_buffer)
    }
}

fn drain_sse_messages(buffer: &mut String) -> Vec<SseMessage> {
    let mut messages = Vec::new();
    while let Some((event_end, drain_end)) = find_sse_event_boundary(buffer) {
        let message = parse_sse_message(&buffer[..event_end]);
        buffer.drain(..drain_end);
        if let Some(message) = message {
            messages.push(message);
        }
    }
    messages
}

fn find_sse_event_boundary(buffer: &str) -> Option<(usize, usize)> {
    let bytes = buffer.as_bytes();
    let mut line_start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\r' && bytes[index] != b'\n' {
            index += 1;
            continue;
        }

        let ending_len = line_ending_len(bytes, index);
        if index == line_start {
            return Some((index, index + ending_len));
        }

        index += ending_len;
        line_start = index;
    }
    None
}

fn line_ending_len(bytes: &[u8], index: usize) -> usize {
    if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
        2
    } else {
        1
    }
}

fn parse_sse_message(raw_event: &str) -> Option<SseMessage> {
    let mut id = None;
    let mut event = None;
    let mut data_lines = Vec::new();

    for line in raw_event.split(['\n', '\r']) {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(value) = line.strip_prefix("id:") {
            id = Some(strip_one_space(value).to_string());
        } else if let Some(value) = line.strip_prefix("event:") {
            event = Some(strip_one_space(value).to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            data_lines.push(strip_one_space(value).to_string());
        }
    }

    let event = event.unwrap_or_else(|| "message".to_string());
    if event == "message" && data_lines.is_empty() && id.is_none() {
        return None;
    }

    Some(SseMessage {
        id,
        event,
        data: data_lines.join("\n"),
    })
}

fn strip_one_space(value: &str) -> &str {
    value.strip_prefix(' ').unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::SseDecoder;

    fn decode_events(input: &[u8]) -> Vec<super::SseMessage> {
        let mut decoder = SseDecoder::default();
        decoder.push_chunk(input)
    }

    #[test]
    fn drains_complete_sse_messages_and_keeps_partial_buffer() {
        let mut decoder = SseDecoder::default();
        let events = decoder.push_chunk(
            b"id: 1\nevent: messages\ndata: {\"ok\":true}\n\nevent: heartbeat\n\nid: 2",
        );

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id.as_deref(), Some("1"));
        assert_eq!(events[0].event, "messages");
        assert_eq!(events[0].data, "{\"ok\":true}");
        assert_eq!(events[1].event, "heartbeat");
        assert_eq!(decoder.push_chunk(b"\n\n").len(), 1);
    }

    #[test]
    fn drains_sse_messages_with_crlf_and_bare_cr_boundaries() {
        let events = decode_events(b"id: 1\revent: messages\rdata: {\"ok\":true}\r\rid: 2\r\n\r\n");

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id.as_deref(), Some("1"));
        assert_eq!(events[0].data, "{\"ok\":true}");
        assert_eq!(events[1].id.as_deref(), Some("2"));
    }

    #[test]
    fn decodes_split_multibyte_utf8_before_sse_parsing() {
        let mut decoder = SseDecoder::default();
        let bytes = "event: messages\ndata: {\"text\":\"cafe\u{301}\"}\n\n".as_bytes();
        let split_at = bytes
            .iter()
            .position(|byte| *byte == 0xcc)
            .expect("combining mark lead byte should exist")
            + 1;

        assert!(decoder.push_chunk(&bytes[..split_at]).is_empty());
        let events = decoder.push_chunk(&bytes[split_at..]);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "{\"text\":\"cafe\u{301}\"}");
    }

    #[test]
    fn strips_only_one_optional_space_after_field_separator() {
        let events =
            decode_events(b"id:  abc\nevent:\tmessages\ndata:\tindented\ndata:  spaced\n\n");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id.as_deref(), Some(" abc"));
        assert_eq!(events[0].event, "\tmessages");
        assert_eq!(events[0].data, "\tindented\n spaced");
    }
}
