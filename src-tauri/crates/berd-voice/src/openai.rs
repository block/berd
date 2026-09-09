use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::json;

#[derive(Clone, Debug)]
pub struct OpenAiSpeechConfig {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub voice: String,
    pub speed: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenAiPcmOutcome {
    Completed,
    Cancelled,
}

/// Streams OpenAI's 24 kHz mono PCM response as unit-scale `f32` frames.
///
/// This operation owns HTTP and PCM framing only. Its caller remains
/// responsible for buffering, playback, device selection, and delivery policy.
/// The callback receives an empty slice on idle polls so a host can update
/// playback guards while the network stream is temporarily quiet.
pub async fn stream_openai_pcm<F>(
    client: &reqwest::Client,
    config: &OpenAiSpeechConfig,
    input: &str,
    active: &AtomicBool,
    mut on_frames: F,
) -> Result<OpenAiPcmOutcome, String>
where
    F: FnMut(&[f32]) -> Result<(), String>,
{
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", config.api_key))
            .map_err(|_| "OpenAI API key is not a valid header value".to_string())?,
    );
    let request = client
        .post(&config.endpoint)
        .headers(headers)
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "model": config.model,
            "voice": config.voice,
            "input": input,
            "speed": config.speed,
            "response_format": "pcm",
            "stream_format": "audio"
        }))
        .send();
    tokio::pin!(request);
    let response = loop {
        tokio::select! {
            response = &mut request => break response.map_err(|error| format_request_error("start speech audio", error))?,
            _ = tokio::time::sleep(Duration::from_millis(20)) => {
                if !active.load(Ordering::SeqCst) { return Ok(OpenAiPcmOutcome::Cancelled); }
            }
        }
    };
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format_response_error("start speech audio", status, &body));
    }

    let mut stream = response.bytes_stream();
    let mut remainder = Vec::new();
    loop {
        if !active.load(Ordering::SeqCst) {
            return Ok(OpenAiPcmOutcome::Cancelled);
        }
        let item = match tokio::time::timeout(Duration::from_millis(50), stream.next()).await {
            Ok(item) => item,
            Err(_) => {
                on_frames(&[])?;
                continue;
            }
        };
        let Some(item) = item else { break };
        let item = item.map_err(|error| format_request_error("stream speech audio", error))?;
        remainder.extend_from_slice(&item);
        let sample_bytes = remainder.len() / 2 * 2;
        if sample_bytes != 0 {
            let samples = pcm16le_to_f32(&remainder[..sample_bytes]);
            remainder.drain(..sample_bytes);
            on_frames(&samples)?;
        }
    }
    if !remainder.is_empty() {
        return Err("OpenAI speech returned an incomplete PCM sample".to_string());
    }
    Ok(OpenAiPcmOutcome::Completed)
}

fn format_request_error(action: &str, error: reqwest::Error) -> String {
    if error.is_timeout() {
        format!("OpenAI voice could not {action}: the request timed out")
    } else if error.is_connect() {
        format!("OpenAI voice could not {action}: check your network connection")
    } else {
        format!("OpenAI voice could not {action}: {error}")
    }
}

fn format_response_error(action: &str, status: reqwest::StatusCode, body: &str) -> String {
    let preview: String = body.chars().take(500).collect();
    format!("OpenAI voice could not {action}: HTTP {status}: {preview}")
}

fn pcm16le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|sample| {
            let sample = i16::from_le_bytes([sample[0], sample[1]]);
            if sample < 0 {
                sample as f32 / 32_768.0
            } else {
                sample as f32 / i16::MAX as f32
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::pcm16le_to_f32;

    #[test]
    fn decodes_little_endian_pcm_without_changing_frame_units() {
        let samples = pcm16le_to_f32(&[0, 0, 0xff, 0x7f, 0, 0x80]);
        assert_eq!(samples.len(), 3);
        assert_eq!(samples[0], 0.0);
        assert_eq!(samples[1], 1.0);
        assert_eq!(samples[2], -1.0);
    }
}
