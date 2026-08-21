use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

pub fn start<F, A, C>(
    input_muted: &Arc<AtomicBool>,
    mute_epoch: &Arc<AtomicU64>,
    on_change: F,
    on_audio: A,
    on_capture_state: C,
) -> bool
where
    F: Fn(bool) + Send + Sync + 'static,
    A: Fn(&[f32]) + Send + Sync + 'static,
    C: Fn(bool) + Send + Sync + 'static,
{
    clear(input_muted, mute_epoch);

    #[cfg(target_os = "macos")]
    let started = match macos::install(
        Arc::clone(input_muted),
        Arc::clone(mute_epoch),
        Arc::new(on_change),
        Arc::new(on_audio),
        Arc::new(on_capture_state),
    ) {
        Ok(()) => true,
        Err(error) => {
            log::info!("AirPods input mute listener is unavailable: {error}");
            false
        }
    };

    #[cfg(not(target_os = "macos"))]
    let started = {
        let _ = (on_change, on_audio, on_capture_state);
        false
    };

    started
}

pub fn stop(input_muted: &Arc<AtomicBool>, mute_epoch: &Arc<AtomicU64>) {
    clear(input_muted, mute_epoch);

    #[cfg(target_os = "macos")]
    if let Err(error) = macos::uninstall() {
        log::info!("Could not stop the AirPods input mute listener: {error}");
    }
}

pub fn set_muted(
    input_muted: &AtomicBool,
    mute_epoch: &AtomicU64,
    muted: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::set_muted(muted)?;
        apply_change(input_muted, mute_epoch, muted, &|_| {});
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (input_muted, mute_epoch, muted);
        Err("native microphone mute is only available on macOS".to_string())
    }
}

fn clear(input_muted: &AtomicBool, mute_epoch: &AtomicU64) {
    input_muted.store(false, Ordering::Release);
    mute_epoch.store(0, Ordering::Release);
}

#[cfg(any(target_os = "macos", test))]
fn apply_change(
    input_muted: &AtomicBool,
    mute_epoch: &AtomicU64,
    muted: bool,
    on_change: &dyn Fn(bool),
) {
    let previous = input_muted.swap(muted, Ordering::AcqRel);
    if previous != muted {
        if muted {
            mute_epoch.fetch_add(1, Ordering::AcqRel);
        }
        on_change(muted);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    type MuteChangeHandler = Arc<dyn Fn(bool) + Send + Sync>;
    type AudioInputHandler = Arc<dyn Fn(&[f32]) + Send + Sync>;
    type CaptureStateHandler = Arc<dyn Fn(bool) + Send + Sync>;

    struct CallbackState {
        input_muted: Arc<AtomicBool>,
        mute_epoch: Arc<AtomicU64>,
        on_change: MuteChangeHandler,
        on_audio: AudioInputHandler,
        on_capture_state: CaptureStateHandler,
    }

    static CALLBACK_STATE: OnceLock<Mutex<Option<CallbackState>>> = OnceLock::new();

    fn callback_state() -> &'static Mutex<Option<CallbackState>> {
        CALLBACK_STATE.get_or_init(|| Mutex::new(None))
    }

    extern "C" {
        fn berd_airpods_mute_start(
            callback: extern "C" fn(bool),
            audio_callback: extern "C" fn(*const f32, usize),
            capture_state_callback: extern "C" fn(bool),
        ) -> bool;
        fn berd_airpods_mute_stop() -> bool;
        fn berd_airpods_mute_set_muted(muted: bool) -> bool;
    }

    extern "C" fn handle_input_mute_change(muted: bool) {
        let Ok(state) = callback_state().lock() else {
            return;
        };
        let Some(state) = state.as_ref() else {
            return;
        };
        apply_change(&state.input_muted, &state.mute_epoch, muted, &|muted| {
            log::info!("AirPods input mute changed muted={muted}");
            (state.on_change)(muted);
        });
    }

    extern "C" fn handle_audio_input(samples: *const f32, sample_count: usize) {
        if samples.is_null() || sample_count == 0 || sample_count > 48_000 {
            return;
        }
        let callback = {
            let Ok(state) = callback_state().lock() else {
                return;
            };
            let Some(state) = state.as_ref() else {
                return;
            };
            Arc::clone(&state.on_audio)
        };
        // SAFETY: AVAudioEngine owns this non-interleaved Float32 channel for
        // the duration of the synchronous tap callback. We do not retain it.
        let samples = unsafe { std::slice::from_raw_parts(samples, sample_count) };
        callback(samples);
    }

    extern "C" fn handle_capture_state_change(available: bool) {
        let callback = {
            let Ok(state) = callback_state().lock() else {
                return;
            };
            let Some(state) = state.as_ref() else {
                return;
            };
            Arc::clone(&state.on_capture_state)
        };
        callback(available);
    }

    pub fn install(
        input_muted: Arc<AtomicBool>,
        mute_epoch: Arc<AtomicU64>,
        on_change: MuteChangeHandler,
        on_audio: AudioInputHandler,
        on_capture_state: CaptureStateHandler,
    ) -> Result<(), String> {
        *callback_state()
            .lock()
            .map_err(|_| "input mute callback lock was poisoned".to_string())? =
            Some(CallbackState {
                input_muted,
                mute_epoch,
                on_change,
                on_audio,
                on_capture_state,
            });
        // SAFETY: The Swift shim retains the callback and AVAudioEngine for its
        // process-wide lifecycle and invokes it with a C-compatible boolean.
        if !unsafe {
            berd_airpods_mute_start(
                handle_input_mute_change,
                handle_audio_input,
                handle_capture_state_change,
            )
        } {
            callback_state()
                .lock()
                .map_err(|_| "input mute callback lock was poisoned".to_string())?
                .take();
            return Err("the Swift AVAudioApplication listener could not start".to_string());
        }
        log::info!("AirPods input mute listener started");
        Ok(())
    }

    pub fn uninstall() -> Result<(), String> {
        // SAFETY: This mirrors the successful start call and clears the Swift
        // process-global before Rust releases its callback state.
        let stopped = unsafe { berd_airpods_mute_stop() };
        callback_state()
            .lock()
            .map_err(|_| "input mute callback lock was poisoned".to_string())?
            .take();
        stopped
            .then_some(())
            .ok_or_else(|| "the Swift AVAudioApplication listener could not stop".to_string())
    }

    pub fn set_muted(muted: bool) -> Result<(), String> {
        // SAFETY: The Swift bridge accepts a C-compatible boolean and remains
        // alive for the active native microphone lifecycle.
        unsafe { berd_airpods_mute_set_muted(muted) }
            .then_some(())
            .ok_or_else(|| "macOS rejected the native microphone mute change".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_boundary_clears_mute() {
        let input_muted = Arc::new(AtomicBool::new(true));
        let mute_epoch = Arc::new(AtomicU64::new(3));
        clear(&input_muted, &mute_epoch);
        assert!(!input_muted.load(Ordering::Acquire));
        assert_eq!(mute_epoch.load(Ordering::Acquire), 0);
    }

    #[test]
    fn unchanged_initial_state_is_not_reported_as_a_gesture() {
        let input_muted = AtomicBool::new(false);
        let mute_epoch = AtomicU64::new(0);
        let changes = std::sync::Mutex::new(Vec::new());

        apply_change(&input_muted, &mute_epoch, false, &|muted| {
            changes.lock().expect("changes lock").push(muted);
        });
        apply_change(&input_muted, &mute_epoch, true, &|muted| {
            changes.lock().expect("changes lock").push(muted);
        });
        apply_change(&input_muted, &mute_epoch, true, &|muted| {
            changes.lock().expect("changes lock").push(muted);
        });
        apply_change(&input_muted, &mute_epoch, false, &|muted| {
            changes.lock().expect("changes lock").push(muted);
        });

        assert_eq!(*changes.lock().expect("changes lock"), vec![true, false]);
        assert_eq!(mute_epoch.load(Ordering::Acquire), 1);
    }
}
