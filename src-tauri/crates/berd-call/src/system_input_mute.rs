//! Per-call system mute integration, including AirPods gestures.
//! Temporary TTS suppression is not system mute.

use block2::RcBlock;
use objc2::{
    rc::Retained,
    runtime::{Bool, ProtocolObject},
};
use objc2_avf_audio::{AVAudioApplication, AVAudioApplicationInputMuteStateChangeNotification};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
use std::ptr::NonNull;
use std::sync::{
    atomic::AtomicU64,
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(crate) fn update_mute_state(
    requested: &AtomicBool,
    mute_epoch: &AtomicU64,
    muted: bool,
) -> u64 {
    loop {
        let epoch = mute_epoch.load(Ordering::SeqCst);
        if epoch & 1 != 0 {
            std::hint::spin_loop();
            continue;
        }
        if mute_epoch
            .compare_exchange(
                epoch,
                epoch.wrapping_add(1),
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_err()
        {
            continue;
        }
        let changed = requested.swap(muted, Ordering::SeqCst) != muted;
        let stable_epoch = if changed {
            epoch.wrapping_add(2)
        } else {
            epoch
        };
        mute_epoch.store(stable_epoch, Ordering::SeqCst);
        return stable_epoch;
    }
}

pub(crate) fn mute_state_snapshot(requested: &AtomicBool, mute_epoch: &AtomicU64) -> (bool, u64) {
    loop {
        let before = mute_epoch.load(Ordering::SeqCst);
        if before & 1 != 0 {
            std::hint::spin_loop();
            continue;
        }
        let muted = requested.load(Ordering::SeqCst);
        let after = mute_epoch.load(Ordering::SeqCst);
        if before == after {
            return (muted, after);
        }
    }
}

struct MuteIntent {
    // Shared capture gate: native intent takes effect without waiting for the
    // actor. `sent` tracks intent forwarded to the child, not acknowledgement.
    requested: Arc<AtomicBool>,
    mute_epoch: Arc<AtomicU64>,
    sent: bool,
    sent_epoch: u64,
    native_applied: bool,
}

impl MuteIntent {
    fn new(requested: Arc<AtomicBool>, mute_epoch: Arc<AtomicU64>) -> Self {
        let sent = requested.load(Ordering::SeqCst);
        let sent_epoch = mute_epoch.load(Ordering::SeqCst);
        Self {
            requested,
            mute_epoch,
            sent,
            sent_epoch,
            native_applied: sent,
        }
    }

    fn take_change(&mut self) -> Option<bool> {
        let mute_epoch = self.mute_epoch.load(Ordering::SeqCst);
        if mute_epoch & 1 != 0 || mute_epoch == self.sent_epoch {
            return None;
        }
        self.sent = !self.sent;
        self.sent_epoch = self.sent_epoch.wrapping_add(2);
        Some(self.sent)
    }

    fn mark_forwarded(&mut self, muted: bool, mute_epoch: u64) {
        self.sent = muted;
        self.sent_epoch = mute_epoch;
    }

    fn set(&mut self, muted: bool) {
        self.sent = muted;
        self.sent_epoch = update_mute_state(&self.requested, &self.mute_epoch, muted);
    }

    fn apply_native(
        &mut self,
        muted: bool,
        apply: impl FnOnce(bool) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.sent == muted
            && self.requested.load(Ordering::SeqCst) == muted
            && self.native_applied == muted
        {
            return Ok(());
        }
        self.set(muted);
        apply(muted)?;
        self.native_applied = muted;
        Ok(())
    }
}

pub(crate) struct SystemInputMute {
    intent: MuteIntent,
    _notification_observer: InputMuteNotificationObserver,
}

struct InputMuteNotificationObserver(Retained<ProtocolObject<dyn NSObjectProtocol>>);

// NSNotificationCenter is thread-safe, and the retained token is only used to
// remove this registration when the call-owned listener is dropped.
unsafe impl Send for InputMuteNotificationObserver {}

impl InputMuteNotificationObserver {
    fn install() -> Self {
        let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
            // Reading the state from this notification opts the active call into
            // AirPods mute gesture delivery. The mute handler is
            // still the sole path that updates the capture gate.
            let _ = unsafe { AVAudioApplication::sharedInstance().isInputMuted() };
        });
        let center = NSNotificationCenter::defaultCenter();
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(AVAudioApplicationInputMuteStateChangeNotification),
                None,
                None,
                &block,
            )
        };
        Self(observer)
    }
}

impl Drop for InputMuteNotificationObserver {
    fn drop(&mut self) {
        let center = NSNotificationCenter::defaultCenter();
        let observer: &objc2::runtime::AnyObject = self.0.as_ref();
        unsafe { center.removeObserver(observer) };
    }
}

impl SystemInputMute {
    pub(crate) fn install(
        requested: Arc<AtomicBool>,
        mute_epoch: Arc<AtomicU64>,
    ) -> Result<Self, String> {
        let intent = MuteIntent::new(requested.clone(), mute_epoch.clone());
        // SAFETY: berd-call targets macOS 14+. This process owns the audio I/O.
        let application = unsafe { AVAudioApplication::sharedInstance() };
        let handler = RcBlock::new(move |muted: Bool| {
            // Capture checks this gate before queueing or forwarding audio. No socket,
            // actor wait, or UI work runs on the native callback thread.
            let muted = muted.as_bool();
            update_mute_state(&requested, &mute_epoch, muted);
            Bool::YES
        });
        // SAFETY: AVAudioApplication copies the correctly typed block.
        unsafe { application.setInputMuteStateChangeHandler_error(Some(&handler)) }
            .map_err(|error| error.localizedDescription().to_string())?;
        let notification_observer = InputMuteNotificationObserver::install();
        // macOS requires a handler before setting mute. The capture gate already
        // holds the saved state, and capture starts after installation.
        if let Err(error) = unsafe { application.setInputMuted_error(intent.sent) } {
            let _ = unsafe { application.setInputMuteStateChangeHandler_error(None) };
            return Err(error.localizedDescription().to_string());
        }
        Ok(Self {
            intent,
            _notification_observer: notification_observer,
        })
    }

    pub(crate) fn take_change(&mut self) -> Option<bool> {
        self.intent.take_change()
    }

    pub(crate) fn mark_forwarded(&mut self, muted: bool, mute_epoch: u64) {
        self.intent.mark_forwarded(muted, mute_epoch);
    }

    pub(crate) fn set_muted(&mut self, muted: bool) -> Result<(), String> {
        self.intent.apply_native(muted, |muted| {
            // SAFETY: only the session actor invokes this method. Any synchronous
            // native callback writes the same intent and does not wait for the actor.
            unsafe { AVAudioApplication::sharedInstance().setInputMuted_error(muted) }
                .map_err(|error| error.localizedDescription().to_string())
        })
    }
}

impl Drop for SystemInputMute {
    fn drop(&mut self) {
        // Do not unmute on teardown: ending a muted call must not play an
        // unmute sound. A subsequent call explicitly seeds its own mute state.
        // SAFETY: nil is the documented handler cancellation operation.
        if let Err(error) = unsafe {
            AVAudioApplication::sharedInstance().setInputMuteStateChangeHandler_error(None)
        } {
            eprintln!(
                "could not remove system input mute handler: {}",
                error.localizedDescription()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static NATIVE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn saved_mute_and_programmatic_changes_do_not_echo_as_gestures() {
        let gate = Arc::new(AtomicBool::new(true));
        let mut intent = MuteIntent::new(gate.clone(), Arc::new(AtomicU64::new(0)));
        assert_eq!(intent.take_change(), None);
        intent.set(false);
        assert!(!gate.load(Ordering::SeqCst));
        assert_eq!(intent.take_change(), None);
    }

    #[test]
    fn gesture_gates_capture_before_actor_consumes_it() {
        let gate = Arc::new(AtomicBool::new(false));
        let epoch = Arc::new(AtomicU64::new(0));
        let mut intent = MuteIntent::new(gate.clone(), epoch.clone());
        update_mute_state(&gate, &epoch, true);
        assert!(gate.load(Ordering::SeqCst));
        assert_eq!(intent.take_change(), Some(true));
        assert_eq!(intent.take_change(), None);
        update_mute_state(&gate, &epoch, false);
        assert_eq!(intent.take_change(), Some(false));
    }

    #[test]
    fn failed_native_update_remains_retryable_without_echoing() {
        let gate = Arc::new(AtomicBool::new(false));
        let mut intent = MuteIntent::new(gate.clone(), Arc::new(AtomicU64::new(0)));
        assert!(intent
            .apply_native(true, |_| Err("rejected".to_string()))
            .is_err());
        assert!(gate.load(Ordering::SeqCst));
        assert_eq!(intent.take_change(), None);

        let attempts = std::cell::Cell::new(0);
        intent
            .apply_native(true, |_| {
                attempts.set(attempts.get() + 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(attempts.get(), 1);
    }

    #[test]
    fn restart_forwarding_preserves_the_next_native_toggle() {
        let gate = Arc::new(AtomicBool::new(false));
        let epoch = Arc::new(AtomicU64::new(0));
        let mut intent = MuteIntent::new(gate.clone(), epoch.clone());
        update_mute_state(&gate, &epoch, true);
        intent.mark_forwarded(true, 2);
        update_mute_state(&gate, &epoch, false);
        assert_eq!(intent.take_change(), Some(false));
    }

    #[test]
    fn complete_native_mute_cycle_preserves_both_edges() {
        let gate = Arc::new(AtomicBool::new(false));
        let epoch = Arc::new(AtomicU64::new(0));
        let mut intent = MuteIntent::new(gate.clone(), epoch.clone());
        update_mute_state(&gate, &epoch, true);
        update_mute_state(&gate, &epoch, false);

        assert_eq!(intent.take_change(), Some(true));
        assert_eq!(intent.take_change(), Some(false));
        assert_eq!(intent.take_change(), None);
    }

    #[test]
    fn snapshot_waits_for_an_in_progress_mute_update() {
        let gate = Arc::new(AtomicBool::new(false));
        let epoch = Arc::new(AtomicU64::new(1));
        let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
        let snapshot_gate = gate.clone();
        let snapshot_epoch = epoch.clone();
        let worker = std::thread::spawn(move || {
            done_tx
                .send(mute_state_snapshot(&snapshot_gate, &snapshot_epoch))
                .unwrap();
        });

        gate.store(true, Ordering::SeqCst);
        assert!(done_rx.try_recv().is_err());
        epoch.store(2, Ordering::SeqCst);
        assert_eq!(done_rx.recv().unwrap(), (true, 2));
        worker.join().unwrap();
    }

    #[test]
    #[ignore = "changes this test process's macOS input mute registration"]
    fn native_listener_retains_mute_notification_opt_in() {
        let _guard = NATIVE_TEST_LOCK.lock().unwrap();
        let listener = SystemInputMute::install(
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicU64::new(0)),
        )
        .unwrap();
        let _retained_for_listener_lifetime = &listener._notification_observer;
    }

    #[test]
    #[ignore = "changes this test process's macOS input mute state"]
    fn native_mute_callback_reaches_capture_and_teardown_preserves_mute() {
        let _guard = NATIVE_TEST_LOCK.lock().unwrap();
        let gate = Arc::new(AtomicBool::new(false));
        let epoch = Arc::new(AtomicU64::new(0));
        let mut listener = SystemInputMute::install(gate.clone(), epoch).unwrap();
        // Exercise the same handler macOS uses for hardware gestures.
        let application = unsafe { AVAudioApplication::sharedInstance() };
        unsafe { application.setInputMuted_error(true) }.unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !gate.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let gated = gate.load(Ordering::SeqCst);
        let changed = listener.take_change();
        drop(listener);
        let remained_muted = unsafe { application.isInputMuted() };
        // Explicit test cleanup, not call teardown behavior.
        drop(
            SystemInputMute::install(
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicU64::new(0)),
            )
            .unwrap(),
        );
        assert!(gated);
        assert_eq!(changed, Some(true));
        assert!(remained_muted);
    }
}
