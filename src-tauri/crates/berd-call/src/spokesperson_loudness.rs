/// Capped level compensation for the Spokesperson's 24 kHz mono stream.
/// The limiter attacks immediately and recovers over 250 ms, without delaying audio.
pub struct SpokespersonLoudness {
    gain: f32,
}

const BOOST: f32 = 1.6;
const CEILING: f32 = 0.95;
const RECOVERY: f32 = 1.0 / (0.25 * 24_000.0);

impl Default for SpokespersonLoudness {
    fn default() -> Self {
        Self { gain: BOOST }
    }
}

impl SpokespersonLoudness {
    pub fn process(&mut self, samples: &mut [f32]) {
        for sample in samples {
            let input = if sample.is_finite() { *sample } else { 0.0 };
            self.gain += (BOOST - self.gain) * RECOVERY;
            if input != 0.0 {
                self.gain = self.gain.min(CEILING / input.abs());
            }
            *sample = (input * self.gain).clamp(-CEILING, CEILING);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_speech_gets_only_the_bounded_boost() {
        let mut samples = [0.1, -0.2, 0.0];
        SpokespersonLoudness::default().process(&mut samples);
        for (actual, expected) in samples.into_iter().zip([0.16, -0.32, 0.0]) {
            assert!((actual - expected).abs() < 0.00001);
        }
    }

    #[test]
    fn loud_and_clipped_input_stay_below_the_peak_ceiling() {
        let mut samples = [0.9, -0.9, 2.0, -2.0, f32::MAX, -f32::MAX];
        SpokespersonLoudness::default().process(&mut samples);
        assert!(samples
            .into_iter()
            .all(|sample| sample.is_finite() && sample.abs() <= CEILING + f32::EPSILON));
    }

    #[test]
    fn silence_and_non_finite_input_are_silent() {
        let mut samples = [0.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY];
        SpokespersonLoudness::default().process(&mut samples);
        assert_eq!(samples, [0.0; 4]);
    }

    #[test]
    fn chunk_boundaries_do_not_change_the_stream() {
        let samples = [0.1, 0.9, -0.8, 0.2, 0.0, 0.1];
        let mut whole = samples;
        SpokespersonLoudness::default().process(&mut whole);
        let mut chunks = samples;
        let mut level = SpokespersonLoudness::default();
        for chunk in chunks.chunks_mut(2) {
            level.process(chunk);
        }
        assert_eq!(whole, chunks);
    }

    #[test]
    fn limiter_recovers_gradually_without_amplifying_silence() {
        let mut level = SpokespersonLoudness::default();
        level.process(&mut [1.0]);
        let mut quiet = [0.1];
        level.process(&mut quiet);
        assert!(quiet[0] < 0.1);
        let mut silence = [0.0; 24_000];
        level.process(&mut silence);
        assert_eq!(silence, [0.0; 24_000]);
        quiet = [0.1];
        level.process(&mut quiet);
        assert!((quiet[0] - 0.16).abs() < 0.002);
    }
}
