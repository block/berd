use crate::openai_realtime_protocol::{
    resolve_interrupted_spokesperson_transcript, RealtimeInterruptedTranscriptInput,
    RealtimeTranscriptAudioPart,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RealtimeAudioPartKey {
    pub item_id: String,
    pub output_index: u64,
    pub content_index: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RealtimeAudioTruncation {
    pub key: RealtimeAudioPartKey,
    pub audio_end_ms: u64,
}

#[derive(Debug, Default)]
pub struct RealtimeAudioDelivery {
    parts: Vec<RealtimeAudioPart>,
    total_frames: u64,
    played_frames: u64,
    received_audio: bool,
}

#[derive(Debug)]
struct RealtimeAudioPart {
    key: RealtimeAudioPartKey,
    transcript: String,
    total_frames: u64,
    truncation_required: bool,
    truncation_sent: bool,
}

impl RealtimeAudioDelivery {
    pub fn ensure_part(
        &mut self,
        item_id: &str,
        output_index: u64,
        content_index: u64,
    ) -> Result<(), String> {
        self.part_index(item_id, output_index, content_index)
            .map(|_| ())
    }

    pub fn record_audio(
        &mut self,
        item_id: &str,
        output_index: u64,
        content_index: u64,
        frame_count: u64,
        require_truncation: bool,
    ) -> Result<(), String> {
        let index = self.part_index(item_id, output_index, content_index)?;
        self.total_frames = self
            .total_frames
            .checked_add(frame_count)
            .ok_or("Spokesperson audio frame count overflowed")?;
        let part = &mut self.parts[index];
        part.total_frames = part
            .total_frames
            .checked_add(frame_count)
            .ok_or("Spokesperson audio part frame count overflowed")?;
        part.truncation_required |= require_truncation;
        self.received_audio = true;
        Ok(())
    }

    pub fn replace_transcript(
        &mut self,
        item_id: &str,
        output_index: u64,
        content_index: u64,
        text: String,
    ) -> Result<(), String> {
        let index = self.part_index(item_id, output_index, content_index)?;
        self.parts[index].transcript = text;
        Ok(())
    }

    pub fn append_transcript(
        &mut self,
        item_id: &str,
        output_index: u64,
        content_index: u64,
        text: &str,
    ) -> Result<(), String> {
        let index = self.part_index(item_id, output_index, content_index)?;
        self.parts[index].transcript.push_str(text);
        Ok(())
    }

    pub fn transcript(&self) -> String {
        self.parts
            .iter()
            .filter(|part| !part.transcript.is_empty())
            .map(|part| part.transcript.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn has_transcript(&self) -> bool {
        self.parts.iter().any(|part| !part.transcript.is_empty())
    }

    pub fn set_played_frames(&mut self, played_frames: u64) {
        self.played_frames = played_frames.min(self.total_frames);
    }

    pub fn played_frames(&self) -> u64 {
        self.played_frames
    }

    pub fn total_frames(&self) -> u64 {
        self.total_frames
    }

    pub fn received_audio(&self) -> bool {
        self.received_audio
    }

    pub fn delivered_transcript(&self, interrupted: bool, sample_rate: u32) -> String {
        let text = self.transcript();
        if !interrupted {
            return text;
        }
        resolve_interrupted_spokesperson_transcript(
            RealtimeInterruptedTranscriptInput::HostPlayedFrames {
                text,
                audio_parts: self
                    .parts
                    .iter()
                    .map(|part| RealtimeTranscriptAudioPart {
                        text: part.transcript.clone(),
                        total_audio_frames: part.total_frames,
                    })
                    .collect(),
                played_audio_frames: self.played_frames,
                total_audio_frames: self.total_frames,
                sample_rate,
            },
        )
        .0
    }

    pub fn require_all_truncations(&mut self) -> Result<(), String> {
        if self.received_audio && self.parts.is_empty() {
            return Err("Spokesperson audio had no provider item identity".into());
        }
        for part in &mut self.parts {
            if part.total_frames > 0 {
                part.truncation_required = true;
            }
        }
        Ok(())
    }

    pub fn truncation_pending(&self) -> bool {
        self.parts.iter().any(|part| part.truncation_required)
    }

    pub fn unsent_truncations(
        &self,
        sample_rate: u32,
    ) -> Result<Vec<RealtimeAudioTruncation>, String> {
        let mut remaining_played = self.played_frames.min(self.total_frames);
        self.parts
            .iter()
            .filter_map(|part| {
                let part_played_frames = remaining_played.min(part.total_frames);
                remaining_played -= part_played_frames;
                (part.truncation_required && !part.truncation_sent).then(|| {
                    part_played_frames
                        .checked_mul(1_000)
                        .ok_or_else(|| "Spokesperson truncation duration overflowed".to_string())
                        .map(|frames_ms| RealtimeAudioTruncation {
                            key: part.key.clone(),
                            audio_end_ms: frames_ms / u64::from(sample_rate.max(1)),
                        })
                })
            })
            .collect()
    }

    pub fn mark_truncation_sent(
        &mut self,
        item_id: &str,
        output_index: u64,
        content_index: u64,
    ) -> Result<(), String> {
        let index = self
            .parts
            .iter()
            .position(|part| {
                part.key.item_id == item_id
                    && part.key.output_index == output_index
                    && part.key.content_index == content_index
            })
            .ok_or_else(|| "Spokesperson truncation targeted an unknown audio part".to_string())?;
        self.parts[index].truncation_sent = true;
        Ok(())
    }

    pub fn acknowledge_truncation(&mut self, item_id: &str, content_index: u64) {
        if let Some(part) = self
            .parts
            .iter_mut()
            .find(|part| part.key.item_id == item_id && part.key.content_index == content_index)
        {
            part.truncation_required = false;
        }
    }

    fn part_index(
        &mut self,
        item_id: &str,
        output_index: u64,
        content_index: u64,
    ) -> Result<usize, String> {
        if let Some(index) = self.parts.iter().position(|part| {
            part.key.output_index == output_index && part.key.content_index == content_index
        }) {
            if self.parts[index].key.item_id != item_id {
                return Err("Spokesperson audio part changed provider item identity".into());
            }
            return Ok(index);
        }
        if self.parts.iter().any(|part| {
            part.key.item_id == item_id
                && part.key.content_index == content_index
                && part.key.output_index != output_index
        }) {
            return Err("Spokesperson audio part changed provider output identity".into());
        }
        self.parts.push(RealtimeAudioPart {
            key: RealtimeAudioPartKey {
                item_id: item_id.into(),
                output_index,
                content_index,
            },
            transcript: String::new(),
            total_frames: 0,
            truncation_required: false,
            truncation_sent: false,
        });
        self.parts
            .sort_by_key(|part| (part.key.output_index, part.key.content_index));
        Ok(self
            .parts
            .iter()
            .position(|part| {
                part.key.output_index == output_index && part.key.content_index == content_index
            })
            .expect("inserted audio part exists"))
    }
}

#[cfg(test)]
mod tests {
    use super::RealtimeAudioDelivery;

    #[test]
    fn delivered_transcript_uses_host_frames_across_ordered_parts() {
        let mut delivery = RealtimeAudioDelivery::default();
        delivery
            .record_audio("second", 1, 0, 12_000, false)
            .unwrap();
        delivery.record_audio("first", 0, 0, 12_000, false).unwrap();
        delivery
            .replace_transcript("first", 0, 0, "One two three four".into())
            .unwrap();
        delivery
            .replace_transcript("second", 1, 0, "Five six seven eight".into())
            .unwrap();
        delivery.set_played_frames(18_000);

        assert_eq!(
            delivery.delivered_transcript(true, 24_000),
            "One two three four Five six"
        );
    }

    #[test]
    fn truncations_use_source_frame_time_and_preserve_part_identity() {
        let mut delivery = RealtimeAudioDelivery::default();
        delivery.record_audio("first", 0, 0, 12_000, false).unwrap();
        delivery
            .record_audio("second", 1, 2, 12_000, false)
            .unwrap();
        delivery.set_played_frames(18_000);
        delivery.require_all_truncations().unwrap();

        let truncations = delivery.unsent_truncations(24_000).unwrap();
        assert_eq!(truncations.len(), 2);
        assert_eq!(truncations[0].key.item_id, "first");
        assert_eq!(truncations[0].audio_end_ms, 500);
        assert_eq!(truncations[1].key.item_id, "second");
        assert_eq!(truncations[1].key.content_index, 2);
        assert_eq!(truncations[1].audio_end_ms, 250);
    }

    #[test]
    fn provider_identity_changes_are_rejected() {
        let mut delivery = RealtimeAudioDelivery::default();
        delivery.ensure_part("first", 0, 0).unwrap();
        assert!(delivery.ensure_part("other", 0, 0).is_err());
        assert!(delivery.ensure_part("first", 1, 0).is_err());
    }
}
