//! Bounded recovery of a default-input capture, independent of the call state.

use std::time::{Duration, Instant};

const RECOVERY_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct MicrophoneRecovery<C> {
    capture: Option<(String, C)>,
    unavailable_since: Option<Instant>,
}

impl<C> MicrophoneRecovery<C> {
    pub(crate) fn new(key: String, capture: C) -> Self {
        Self {
            capture: Some((key, capture)),
            unavailable_since: None,
        }
    }

    pub(crate) fn capture(&self) -> Option<&C> {
        self.capture.as_ref().map(|(_, capture)| capture)
    }

    /// Opening a stream is not recovery until it delivers audio callbacks.
    pub(crate) fn confirm_activity(&mut self) -> bool {
        self.unavailable_since.take().is_some()
    }

    /// Drop the old capture before opening its replacement. The caller controls
    /// retry cadence and resets input between capture generations.
    pub(crate) fn reconcile(
        &mut self,
        now: Instant,
        desired: Result<String, String>,
        failed: bool,
        close: impl FnOnce(&mut C) -> Result<(), String>,
        open: impl FnOnce() -> Result<C, String>,
    ) -> Result<bool, String> {
        if self
            .unavailable_since
            .is_some_and(|since| now.saturating_duration_since(since) >= RECOVERY_TIMEOUT)
        {
            return Err("default microphone did not recover within 10 seconds".into());
        }
        if !failed
            && self
                .capture
                .as_ref()
                .is_some_and(|(key, _)| desired.as_ref() == Ok(key))
        {
            return Ok(false);
        }
        if let Some((_, mut capture)) = self.capture.take() {
            close(&mut capture)?;
        }
        self.unavailable_since.get_or_insert(now);
        match desired.and_then(|key| open().map(|capture| (key, capture))) {
            Ok(capture) => {
                self.capture = Some(capture);
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    struct Capture(Arc<AtomicBool>);
    impl Drop for Capture {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn callback_activity_completes_recovery_once() {
        let now = Instant::now();
        let mut recovery = MicrophoneRecovery::new("input".into(), 0);
        assert!(!recovery.confirm_activity());
        recovery
            .reconcile(now, Ok("input".into()), true, |_| Ok(()), || Ok(1))
            .unwrap();
        assert!(recovery.confirm_activity());
        assert!(!recovery.confirm_activity());
        assert!(!recovery
            .reconcile(
                now + Duration::from_secs(20),
                Ok("input".into()),
                false,
                |_| Ok(()),
                || panic!("healthy capture must remain open")
            )
            .unwrap());
    }

    #[test]
    fn repeated_callback_silent_reopens_do_not_reset_recovery_deadline() {
        let now = Instant::now();
        let mut recovery = MicrophoneRecovery::new("input".into(), 0);
        for seconds in [0, 2, 4, 6, 8] {
            recovery
                .reconcile(
                    now + Duration::from_secs(seconds),
                    Ok("input".into()),
                    true,
                    |_| Ok(()),
                    || Ok(1),
                )
                .unwrap();
        }
        assert!(recovery
            .reconcile(
                now + Duration::from_secs(10),
                Ok("input".into()),
                true,
                |_| Ok(()),
                || Ok(1)
            )
            .is_err());
    }

    #[test]
    fn failed_teardown_never_opens_a_replacement() {
        let dropped = Arc::new(AtomicBool::new(false));
        let mut recovery = MicrophoneRecovery::new("first".into(), Capture(dropped.clone()));
        let result = recovery.reconcile(
            Instant::now(),
            Ok("second".into()),
            false,
            |_| Err("writer remained blocked".into()),
            || panic!("reset/reopen must not run after incomplete teardown"),
        );
        assert_eq!(result.unwrap_err(), "writer remained blocked");
        assert!(dropped.load(Ordering::SeqCst));
        assert!(recovery.capture().is_none());
    }

    #[test]
    fn route_change_drops_old_capture_before_opening_new_one() {
        let dropped = Arc::new(AtomicBool::new(false));
        let mut recovery = MicrophoneRecovery::new("first".into(), Capture(dropped.clone()));
        assert!(recovery
            .reconcile(
                Instant::now(),
                Ok("second".into()),
                false,
                |_| Ok(()),
                || {
                    assert!(dropped.load(Ordering::SeqCst));
                    Ok(Capture(Arc::new(AtomicBool::new(false))))
                }
            )
            .unwrap());
        assert!(!recovery
            .reconcile(
                Instant::now(),
                Ok("second".into()),
                false,
                |_| Ok(()),
                || panic!("unchanged route reopened")
            )
            .unwrap());
    }

    #[test]
    fn stream_failure_reopens_the_same_device() {
        let mut recovery = MicrophoneRecovery::new("input".into(), 1);
        assert!(recovery
            .reconcile(
                Instant::now(),
                Ok("input".into()),
                true,
                |_| Ok(()),
                || Ok(2)
            )
            .unwrap());
        assert_eq!(recovery.capture(), Some(&2));
    }

    #[test]
    fn missing_input_can_return_without_ending_the_call() {
        let now = Instant::now();
        let mut recovery = MicrophoneRecovery::new("input".into(), 1);
        assert!(!recovery
            .reconcile(
                now,
                Err("disconnected".into()),
                false,
                |_| Ok(()),
                || panic!("no device")
            )
            .unwrap());
        assert!(recovery.capture().is_none());
        assert!(recovery
            .reconcile(
                now + Duration::from_secs(2),
                Ok("replacement".into()),
                false,
                |_| Ok(()),
                || Ok(2)
            )
            .unwrap());
        assert_eq!(recovery.capture(), Some(&2));
    }

    #[test]
    fn repeated_open_failures_have_a_bounded_recovery_window() {
        let now = Instant::now();
        let mut recovery = MicrophoneRecovery::new("input".into(), 1);
        assert!(!recovery
            .reconcile(
                now,
                Ok("input".into()),
                true,
                |_| Ok(()),
                || Err("engine stopped".into())
            )
            .unwrap());
        assert!(!recovery
            .reconcile(
                now + Duration::from_secs(9),
                Ok("input".into()),
                false,
                |_| Ok(()),
                || Err("engine stopped".into())
            )
            .unwrap());
        assert!(recovery
            .reconcile(
                now + Duration::from_secs(10),
                Ok("input".into()),
                false,
                |_| Ok(()),
                || Err("engine stopped".into())
            )
            .unwrap_err()
            .contains("within 10 seconds"));
    }
}
