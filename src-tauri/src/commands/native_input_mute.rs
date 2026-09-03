pub fn start<F>(on_change: F) -> bool
where
    F: Fn(bool) + Send + Sync + 'static,
{
    #[cfg(target_os = "macos")]
    return match macos::install(on_change) {
        Ok(()) => true,
        Err(error) => {
            log::info!("AirPods input mute listener is unavailable: {error}");
            false
        }
    };

    #[cfg(not(target_os = "macos"))]
    {
        let _ = on_change;
        false
    }
}

pub fn stop() {
    #[cfg(target_os = "macos")]
    if let Err(error) = macos::uninstall() {
        log::info!("Could not stop the AirPods input mute listener: {error}");
    }
}

pub fn set_muted(muted: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::set_muted(muted)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = muted;
        Err("native microphone mute is only available on macOS".to_string())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_avf_audio::AVAudioApplication;

    extern "C" {
        fn berd_airpods_capture_start() -> bool;
        fn berd_airpods_capture_stop();
    }

    pub fn install<F>(on_change: F) -> Result<(), String>
    where
        F: Fn(bool) + Send + Sync + 'static,
    {
        // SAFETY: Berd's minimum macOS version is 14.0, where
        // AVAudioApplication and these selectors are public API.
        let application = unsafe { AVAudioApplication::sharedInstance() };
        let handler = RcBlock::new(move |muted: Bool| {
            let muted = muted.as_bool();
            log::info!("AirPods input mute changed muted={muted}");
            on_change(muted);
            Bool::YES
        });
        // SAFETY: The block has the generated AVFAudio signature. The API
        // copies and retains it until a later registration or cancellation.
        if let Err(error) =
            unsafe { application.setInputMuteStateChangeHandler_error(Some(&handler)) }
        {
            return Err(error.localizedDescription().to_string());
        }
        if let Err(error) = unsafe { application.setInputMuted_error(false) } {
            let _ = unsafe { application.setInputMuteStateChangeHandler_error(None) };
            return Err(error.localizedDescription().to_string());
        }
        // SAFETY: The Swift bridge owns one process-global AVAudioEngine and
        // exposes a C-compatible lifecycle API.
        if !unsafe { berd_airpods_capture_start() } {
            let _ = unsafe { application.setInputMuteStateChangeHandler_error(None) };
            return Err("macOS microphone capture could not start".to_string());
        }
        log::info!("AirPods input mute listener started");
        Ok(())
    }

    pub fn uninstall() -> Result<(), String> {
        // SAFETY: Berd targets macOS 14+, and nil is the documented way to
        // cancel the process-wide handler at the end of a call lifecycle.
        let application = unsafe { AVAudioApplication::sharedInstance() };
        // Do not leave another Berd microphone feature inheriting the voice
        // conversation's last input-mute state after its handler is gone.
        let reset_result = unsafe { application.setInputMuted_error(false) }
            .map_err(|error| error.localizedDescription().to_string());
        let handler_result = unsafe { application.setInputMuteStateChangeHandler_error(None) }
            .map_err(|error| error.localizedDescription().to_string());
        unsafe { berd_airpods_capture_stop() };
        reset_result.and(handler_result)
    }

    pub fn set_muted(muted: bool) -> Result<(), String> {
        let application = unsafe { AVAudioApplication::sharedInstance() };
        unsafe { application.setInputMuted_error(muted) }
            .map_err(|error| error.localizedDescription().to_string())
    }
}
