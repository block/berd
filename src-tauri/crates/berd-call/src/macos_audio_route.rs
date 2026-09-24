use std::mem;
use std::ptr::{null, NonNull};
use std::time::Duration;

use coreaudio::audio_unit::macos_helpers::{
    get_default_device_id, get_device_id_from_name, get_device_transport_type,
};
use objc2_core_audio::{
    kAudioDevicePropertyScopeOutput, kAudioDevicePropertyStreams, kAudioDeviceTransportTypeBuiltIn,
    kAudioHardwareNoError, kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal,
    kAudioStreamPropertyTerminalType, kAudioStreamTerminalTypeSpeaker, AudioObjectGetPropertyData,
    AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectPropertyAddress,
};

const LOCAL_PLAYBACK_LATENCY: Duration = Duration::from_millis(100);
const BLUETOOTH_PLAYBACK_LATENCY: Duration = Duration::from_millis(500);
const AIRPLAY_PLAYBACK_LATENCY: Duration = Duration::from_secs(2);
const UNKNOWN_PLAYBACK_LATENCY: Duration = Duration::from_secs(2);
const BUILT_IN_TRANSPORT: u32 = kAudioDeviceTransportTypeBuiltIn;
const BLUETOOTH_TRANSPORT: u32 = 0x626c_7565;
const BLUETOOTH_LE_TRANSPORT: u32 = 0x626c_6561;
const AIRPLAY_TRANSPORT: u32 = 0x6169_7270;

pub fn playback_latency_safety_duration(output_device: Option<&str>) -> Duration {
    let device_id = resolve_output_device(output_device);
    playback_latency_safety_duration_for_transport(
        device_id.and_then(|id| get_device_transport_type(id).ok()),
    )
}

pub fn output_device_is_builtin_speaker(output_device: Option<&str>) -> bool {
    let Some(device_id) = resolve_output_device(output_device) else {
        return false;
    };
    let transport_type = get_device_transport_type(device_id).ok();
    let streams_address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut streams_size = 0;
    // SAFETY: `streams_address` and `streams_size` remain valid for the duration
    // of this synchronous CoreAudio property-size query.
    let status = unsafe {
        AudioObjectGetPropertyDataSize(
            device_id,
            NonNull::from(&streams_address),
            0,
            null(),
            NonNull::from(&mut streams_size),
        )
    };
    if status != kAudioHardwareNoError || streams_size == 0 {
        return false;
    }

    let mut streams =
        vec![0 as AudioObjectID; streams_size as usize / mem::size_of::<AudioObjectID>()];
    // SAFETY: CoreAudio writes at most `streams_size` bytes into the allocated
    // `streams` buffer, whose pointer remains valid for this synchronous call.
    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            NonNull::from(&streams_address),
            0,
            null(),
            NonNull::from(&mut streams_size),
            NonNull::new(streams.as_mut_ptr())
                .expect("non-empty stream buffer")
                .cast(),
        )
    };
    if status != kAudioHardwareNoError {
        return false;
    }

    streams.into_iter().any(|stream_id| {
        let terminal_address = AudioObjectPropertyAddress {
            mSelector: kAudioStreamPropertyTerminalType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let mut terminal_type = 0;
        let mut terminal_size = mem::size_of::<u32>() as u32;
        // SAFETY: `terminal_type` is a live `u32` output buffer and
        // `terminal_size` accurately describes it for this synchronous call.
        let status = unsafe {
            AudioObjectGetPropertyData(
                stream_id,
                NonNull::from(&terminal_address),
                0,
                null(),
                NonNull::from(&mut terminal_size),
                NonNull::from(&mut terminal_type).cast(),
            )
        };
        status == kAudioHardwareNoError
            && output_metadata_uses_builtin_speakers(transport_type, terminal_type)
    })
}

fn resolve_output_device(output_device: Option<&str>) -> Option<AudioObjectID> {
    match output_device {
        Some(name) => get_device_id_from_name(name, false),
        None => get_default_device_id(false),
    }
}

pub fn playback_latency_safety_duration_for_transport(transport: Option<u32>) -> Duration {
    match transport {
        Some(BUILT_IN_TRANSPORT) => LOCAL_PLAYBACK_LATENCY,
        Some(BLUETOOTH_TRANSPORT) | Some(BLUETOOTH_LE_TRANSPORT) => BLUETOOTH_PLAYBACK_LATENCY,
        Some(AIRPLAY_TRANSPORT) => AIRPLAY_PLAYBACK_LATENCY,
        Some(_) | None => UNKNOWN_PLAYBACK_LATENCY,
    }
}

pub fn output_metadata_uses_builtin_speakers(
    transport_type: Option<u32>,
    terminal_type: u32,
) -> bool {
    const USB_AUDIO_SPEAKER_TERMINAL: u32 = 0x0301;
    transport_type == Some(kAudioDeviceTransportTypeBuiltIn)
        && (terminal_type == kAudioStreamTerminalTypeSpeaker
            || terminal_type == USB_AUDIO_SPEAKER_TERMINAL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_latency_is_conservative_for_wireless_and_unknown_devices() {
        assert_eq!(
            playback_latency_safety_duration_for_transport(Some(BUILT_IN_TRANSPORT)),
            Duration::from_millis(100)
        );
        assert_eq!(
            playback_latency_safety_duration_for_transport(Some(BLUETOOTH_TRANSPORT)),
            Duration::from_millis(500)
        );
        assert_eq!(
            playback_latency_safety_duration_for_transport(Some(AIRPLAY_TRANSPORT)),
            Duration::from_secs(2)
        );
        assert_eq!(
            playback_latency_safety_duration_for_transport(None),
            Duration::from_secs(2)
        );
    }

    #[test]
    fn builtin_transport_requires_a_speaker_terminal() {
        assert!(output_metadata_uses_builtin_speakers(
            Some(kAudioDeviceTransportTypeBuiltIn),
            kAudioStreamTerminalTypeSpeaker
        ));
        assert!(!output_metadata_uses_builtin_speakers(
            Some(kAudioDeviceTransportTypeBuiltIn),
            0
        ));
    }
}
