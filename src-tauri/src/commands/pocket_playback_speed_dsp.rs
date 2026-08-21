//! Stateful pitch-preserving processing for streamed Pocket TTS PCM.
//!
//! Pocket emits cumulative PCM after each decoder block. A single stretcher
//! must span those blocks so its analysis window and latency are paid once per
//! synthesis attempt instead of once per callback.

const MIN_PLAYBACK_SPEED: f32 = 0.75;
const MAX_PLAYBACK_SPEED: f32 = 2.0;
const DEFAULT_PLAYBACK_SPEED: f32 = 1.0;
const UNITY_EPSILON: f32 = 0.000_1;

pub(super) struct StreamingSpeedProcessor {
    speed: f32,
    sample_rate: u32,
    stretch: Option<ssstretch::Stretch>,
    input_latency: usize,
    output_latency: usize,
    reset_pre_roll: usize,
    trim_remaining: usize,
    total_input: usize,
    requested_output: usize,
    emitted_output: usize,
}

impl StreamingSpeedProcessor {
    pub(super) fn new(speed: f32, sample_rate: u32) -> Result<Self, String> {
        validate_speed(speed)?;
        if (speed - DEFAULT_PLAYBACK_SPEED).abs() <= UNITY_EPSILON {
            return Ok(Self {
                speed,
                sample_rate,
                stretch: None,
                input_latency: 0,
                output_latency: 0,
                reset_pre_roll: 0,
                trim_remaining: 0,
                total_input: 0,
                requested_output: 0,
                emitted_output: 0,
            });
        }

        let mut stretch = ssstretch::Stretch::new();
        stretch.preset_default(1, sample_rate as f32);
        let input_latency = stretch.input_latency().max(0) as usize;
        let output_latency = stretch.output_latency().max(0) as usize;
        let reset_pre_roll = (input_latency as f64 / speed as f64).ceil() as usize;

        Ok(Self {
            speed,
            sample_rate,
            stretch: Some(stretch),
            input_latency,
            output_latency,
            reset_pre_roll,
            trim_remaining: reset_pre_roll.saturating_add(output_latency),
            total_input: 0,
            requested_output: 0,
            emitted_output: 0,
        })
    }

    pub(super) fn process(&mut self, input: &[f32]) -> Result<Vec<f32>, String> {
        if input.is_empty() {
            return Ok(Vec::new());
        }
        self.total_input = self
            .total_input
            .checked_add(input.len())
            .ok_or_else(|| "Pocket streamed audio is too large".to_string())?;
        if self.stretch.is_none() {
            self.requested_output = self.total_input;
            self.emitted_output = self.total_input;
            return Ok(input.to_vec());
        }

        let target_output = stretched_len(self.total_input, self.speed);
        let output_samples = target_output.saturating_sub(self.requested_output);
        self.requested_output = target_output;
        let inputs = [input.to_vec()];
        let mut output = [Vec::with_capacity(output_samples)];
        self.stretch
            .as_mut()
            .expect("non-unity processor has a stretcher")
            .process_vec(
                &inputs,
                i32_len(input.len())?,
                &mut output,
                i32_len(output_samples)?,
            );
        Ok(self.trim_and_count(output[0].as_slice()))
    }

    pub(super) fn finish(&mut self) -> Result<Vec<f32>, String> {
        if self.stretch.is_none() {
            return Ok(Vec::new());
        }

        let latency_input = [vec![0.0; self.input_latency]];
        let mut latency_output = [Vec::with_capacity(self.reset_pre_roll)];
        self.stretch
            .as_mut()
            .expect("non-unity processor has a stretcher")
            .process_vec(
                &latency_input,
                i32_len(self.input_latency)?,
                &mut latency_output,
                i32_len(self.reset_pre_roll)?,
            );
        let mut output = self.trim_and_count(latency_output[0].as_slice());

        let mut flushed = [Vec::with_capacity(self.output_latency)];
        self.stretch
            .as_mut()
            .expect("non-unity processor has a stretcher")
            .flush_vec(&mut flushed, i32_len(self.output_latency)?);
        output.extend(self.trim_and_count(flushed[0].as_slice()));

        let expected = stretched_len(self.total_input, self.speed);
        if self.trim_remaining != 0 || self.emitted_output != expected {
            return Err(format!(
                "time stretcher emitted {} samples with {} latency samples remaining, expected {expected}",
                self.emitted_output, self.trim_remaining
            ));
        }
        Ok(output)
    }

    pub(super) fn drain_and_reset(&mut self) -> Result<Vec<f32>, String> {
        let output = self.finish()?;
        *self = Self::new(self.speed, self.sample_rate)?;
        Ok(output)
    }

    fn trim_and_count(&mut self, samples: &[f32]) -> Vec<f32> {
        let trim = self.trim_remaining.min(samples.len());
        self.trim_remaining -= trim;
        let output = samples[trim..].to_vec();
        self.emitted_output = self.emitted_output.saturating_add(output.len());
        output
    }
}

fn stretched_len(input_len: usize, speed: f32) -> usize {
    (input_len as f64 / speed as f64).round() as usize
}

fn validate_speed(speed: f32) -> Result<(), String> {
    if speed.is_finite() && (MIN_PLAYBACK_SPEED..=MAX_PLAYBACK_SPEED).contains(&speed) {
        Ok(())
    } else {
        Err(format!(
            "Pocket playback speed must be between {MIN_PLAYBACK_SPEED} and {MAX_PLAYBACK_SPEED}"
        ))
    }
}

fn i32_len(length: usize) -> Result<i32, String> {
    i32::try_from(length).map_err(|_| "audio chunk is too large to process".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_RATE: u32 = 24_000;

    #[test]
    fn unity_streaming_is_a_bit_exact_bypass() {
        let first = vec![0.0, 0.125];
        let second = vec![-0.5, 1.0];
        let mut processor = StreamingSpeedProcessor::new(1.0, SAMPLE_RATE).expect("processor");

        assert_eq!(processor.process(&first).expect("first"), first);
        assert_eq!(processor.process(&second).expect("second"), second);
        assert!(processor.finish().expect("finish").is_empty());
    }

    #[test]
    fn streaming_blocks_preserve_length_pitch_order_and_continuity() {
        let input: Vec<f32> = (0..48_000)
            .map(|sample| {
                let frequency = if sample < 16_000 {
                    220.0
                } else if sample < 32_000 {
                    440.0
                } else {
                    660.0
                };
                (2.0 * std::f32::consts::PI * frequency * sample as f32 / SAMPLE_RATE as f32).sin()
            })
            .collect();
        let mut processor = StreamingSpeedProcessor::new(1.25, SAMPLE_RATE).expect("processor");
        let mut output = Vec::new();
        let mut callback_boundaries = Vec::new();
        for block in input.chunks(1_920) {
            let processed = processor.process(block).expect("stream block");
            if !processed.is_empty() && !output.is_empty() {
                callback_boundaries.push(output.len());
            }
            output.extend(processed);
        }
        output.extend(processor.finish().expect("finish"));

        assert_eq!(output.len(), 38_400);
        assert_frequency(&output[2_000..10_000], 220.0, 8.0);
        assert_frequency(&output[14_000..23_000], 440.0, 10.0);
        assert_frequency(&output[27_000..36_000], 660.0, 12.0);
        for boundary in callback_boundaries {
            let jump = (output[boundary] - output[boundary - 1]).abs();
            assert!(jump < 0.5, "callback boundary jump was {jump}");
        }
    }

    #[test]
    fn two_x_streaming_preserves_pitch_and_tail() {
        let frequency = 220.0_f32;
        let input: Vec<f32> = (0..SAMPLE_RATE * 2)
            .map(|sample| {
                (2.0 * std::f32::consts::PI * frequency * sample as f32 / SAMPLE_RATE as f32).sin()
            })
            .collect();
        let mut processor = StreamingSpeedProcessor::new(2.0, SAMPLE_RATE).expect("processor");
        let mut output = Vec::new();
        for block in input.chunks(1_920) {
            output.extend(processor.process(block).expect("stream block"));
        }
        output.extend(processor.finish().expect("finish"));

        assert_eq!(output.len(), SAMPLE_RATE as usize);
        assert!(
            root_mean_square(&output[..480]) > 0.2,
            "initial latency was not removed"
        );
        assert!(
            root_mean_square(&output[output.len() - 480..]) > 0.2,
            "speech tail was truncated"
        );
        assert_frequency(&output[2_000..], frequency, 4.0);
    }

    #[test]
    fn two_x_boundary_drain_emits_complete_stretched_length() {
        let input: Vec<f32> = (0..SAMPLE_RATE)
            .map(|sample| {
                (2.0 * std::f32::consts::PI * 220.0 * sample as f32 / SAMPLE_RATE as f32).sin()
            })
            .collect();
        let mut processor = StreamingSpeedProcessor::new(2.0, SAMPLE_RATE).expect("processor");
        let mut output = Vec::new();
        for block in input.chunks(1_920) {
            output.extend(processor.process(block).expect("stream block"));
        }

        let tail = processor.drain_and_reset().expect("boundary drain");
        assert!(!tail.is_empty(), "boundary drain did not emit a tail");
        output.extend(tail);

        assert_eq!(output.len(), stretched_len(input.len(), 2.0));
    }

    #[test]
    fn two_x_processing_continues_after_boundary_reset() {
        let first = vec![0.25; SAMPLE_RATE as usize];
        let second: Vec<f32> = (0..SAMPLE_RATE)
            .map(|sample| {
                (2.0 * std::f32::consts::PI * 440.0 * sample as f32 / SAMPLE_RATE as f32).sin()
            })
            .collect();
        let mut processor = StreamingSpeedProcessor::new(2.0, SAMPLE_RATE).expect("processor");
        for block in first.chunks(1_920) {
            processor.process(block).expect("first stream block");
        }
        processor.drain_and_reset().expect("boundary drain");

        let mut output = Vec::new();
        for block in second.chunks(1_920) {
            output.extend(processor.process(block).expect("second stream block"));
        }
        output.extend(processor.finish().expect("finish second segment"));

        assert_eq!(output.len(), stretched_len(second.len(), 2.0));
        assert_frequency(&output[2_000..], 440.0, 8.0);
    }

    fn assert_frequency(samples: &[f32], expected: f32, tolerance: f32) {
        let measured = zero_crossing_frequency(samples);
        assert!(
            (measured - expected).abs() <= tolerance,
            "expected {expected} Hz, measured {measured} Hz"
        );
    }

    fn zero_crossing_frequency(samples: &[f32]) -> f32 {
        let crossings = samples
            .windows(2)
            .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
            .count();
        crossings as f32 * SAMPLE_RATE as f32 / samples.len() as f32
    }

    fn root_mean_square(samples: &[f32]) -> f32 {
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
    }
}
