/// A destination for streamed mono, unit-scale `f32` PCM audio.
///
/// The host constructs the output with its chosen input sample rate and device.
/// In unit-scale PCM, `-1.0` and `1.0` represent negative and positive full
/// scale respectively.
pub trait PcmAudioOutput {
    /// Queues source frames for playback.
    ///
    /// A successful return means every borrowed frame was synchronously
    /// accepted or copied; the implementation does not retain `samples`.
    fn write(&self, samples: &[f32]) -> Result<(), String>;

    /// Permanently cancels queued and active playback for this output instance.
    ///
    /// Further writes are not accepted. Status and progress may still be
    /// observed, and repeated cancellation must be harmless.
    fn cancel(&self);

    /// Cancels playback and returns the final confirmed source-frame count.
    ///
    /// The default preserves local-output semantics by freezing progress before
    /// cancellation can discard native bookkeeping. Outputs with a remote
    /// quiescence acknowledgement may override this to cancel first and return
    /// the settled count reported by the remote host.
    fn cancel_and_snapshot(&self) -> Result<u64, String> {
        let played_frames = self.played_frames();
        self.cancel();
        Ok(played_frames)
    }

    /// Returns whether all queued source frames have drained.
    fn is_drained(&self) -> bool;

    /// Checks for a playback failure that may occur after a successful write.
    fn check_health(&self) -> Result<(), String>;

    /// Returns the cumulative, monotonic count of source frames confirmed
    /// played since construction, measured at the configured input sample rate.
    fn played_frames(&self) -> u64;
}

/// Waits for queued PCM to drain, cancelling when session authority is revoked.
pub fn wait_until_drained(
    output: &dyn PcmAudioOutput,
    active: &std::sync::atomic::AtomicBool,
    poll_interval: std::time::Duration,
) -> Result<bool, String> {
    use std::sync::atomic::Ordering;

    while !output.is_drained() {
        if !active.load(Ordering::SeqCst) {
            output.cancel();
            return Ok(false);
        }
        output.check_health()?;
        std::thread::sleep(poll_interval);
    }
    if !active.load(Ordering::SeqCst) {
        output.cancel();
        return Ok(false);
    }
    output.check_health()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{wait_until_drained, PcmAudioOutput};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    struct FakeOutput {
        polls: AtomicUsize,
        cancelled: AtomicBool,
        fail: bool,
    }

    impl PcmAudioOutput for FakeOutput {
        fn write(&self, _samples: &[f32]) -> Result<(), String> {
            Ok(())
        }
        fn cancel(&self) {
            self.cancelled.store(true, Ordering::SeqCst);
        }
        fn is_drained(&self) -> bool {
            self.polls.fetch_add(1, Ordering::SeqCst) >= 1
        }
        fn check_health(&self) -> Result<(), String> {
            if self.fail {
                Err("failed".into())
            } else {
                Ok(())
            }
        }
        fn played_frames(&self) -> u64 {
            0
        }
    }

    #[test]
    fn fake_output_proves_drain_and_cancellation_contract() {
        let output = FakeOutput {
            polls: AtomicUsize::new(0),
            cancelled: AtomicBool::new(false),
            fail: false,
        };
        assert!(wait_until_drained(&output, &AtomicBool::new(true), Duration::ZERO).unwrap());
        let cancelled = FakeOutput {
            polls: AtomicUsize::new(0),
            cancelled: AtomicBool::new(false),
            fail: false,
        };
        assert!(!wait_until_drained(&cancelled, &AtomicBool::new(false), Duration::ZERO).unwrap());
        assert!(cancelled.cancelled.load(Ordering::SeqCst));

        let already_drained = FakeOutput {
            polls: AtomicUsize::new(1),
            cancelled: AtomicBool::new(false),
            fail: false,
        };
        assert!(
            !wait_until_drained(&already_drained, &AtomicBool::new(false), Duration::ZERO).unwrap()
        );
        assert!(already_drained.cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn asynchronous_output_failure_propagates() {
        let output = FakeOutput {
            polls: AtomicUsize::new(0),
            cancelled: AtomicBool::new(false),
            fail: true,
        };
        assert_eq!(
            wait_until_drained(&output, &AtomicBool::new(true), Duration::ZERO).unwrap_err(),
            "failed"
        );
    }
}
