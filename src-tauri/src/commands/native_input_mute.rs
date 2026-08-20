use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub fn start(input_muted: &Arc<AtomicBool>) {
    clear(input_muted);

    #[cfg(target_os = "macos")]
    if let Err(error) = macos::install(Arc::clone(input_muted)) {
        log::info!("AirPods input mute listener is unavailable: {error}");
    }
}

pub fn stop(input_muted: &Arc<AtomicBool>) {
    clear(input_muted);

    #[cfg(target_os = "macos")]
    if let Err(error) = macos::uninstall() {
        log::info!("Could not stop the AirPods input mute listener: {error}");
    }
}

fn clear(input_muted: &AtomicBool) {
    input_muted.store(false, Ordering::Release);
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_avf_audio::AVAudioApplication;

    pub fn install(input_muted: Arc<AtomicBool>) -> Result<(), String> {
        // SAFETY: Berd's minimum macOS version is 14.0, where
        // AVAudioApplication and these selectors are public API.
        let application = unsafe { AVAudioApplication::sharedInstance() };
        unsafe { application.setInputMuted_error(false) }
            .map_err(|error| error.localizedDescription().to_string())?;

        let handler = RcBlock::new(move |muted: Bool| {
            let muted = muted.as_bool();
            input_muted.store(muted, Ordering::Release);
            log::info!("AirPods input mute changed muted={muted}");
            Bool::YES
        });
        // SAFETY: The block has the generated AVFAudio signature. The API
        // copies and retains it until a later registration or cancellation.
        unsafe { application.setInputMuteStateChangeHandler_error(Some(&handler)) }
            .map_err(|error| error.localizedDescription().to_string())?;
        log::info!("AirPods input mute listener started");
        Ok(())
    }

    pub fn uninstall() -> Result<(), String> {
        // SAFETY: Berd targets macOS 14+, and nil is the documented way to
        // cancel the process-wide handler at the end of a call lifecycle.
        let application = unsafe { AVAudioApplication::sharedInstance() };
        unsafe { application.setInputMuteStateChangeHandler_error(None) }
            .map_err(|error| error.localizedDescription().to_string())?;
        // Do not leave another Berd microphone feature inheriting the voice
        // conversation's last input-mute state after its handler is gone.
        unsafe { application.setInputMuted_error(false) }
            .map_err(|error| error.localizedDescription().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_boundary_clears_mute() {
        let input_muted = Arc::new(AtomicBool::new(true));
        clear(&input_muted);
        assert!(!input_muted.load(Ordering::Acquire));
    }
}
