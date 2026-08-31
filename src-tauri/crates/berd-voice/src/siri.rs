//! Safe Siri voice management and device-free sirittsd synthesis primitives.

use std::collections::BTreeSet;
#[cfg(target_os = "macos")]
use std::ffi::{c_char, c_void, CStr, CString};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize};

#[cfg(target_os = "macos")]
use crate::{TtsBackend, TtsOutcome, TtsPcmSpec, TtsSynthesisEvent};

#[cfg(target_os = "macos")]
const SIRI_PCM_SAMPLE_RATE: u32 = 48_000;
#[cfg(target_os = "macos")]
const PCM_CHANNEL_CAPACITY: usize = 8;
#[cfg(target_os = "macos")]
const SYNTHESIS_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(target_os = "macos")]
const SIRI_SYNTHESIS_STALL_TIMEOUT: Duration = Duration::from_secs(60);
pub const DEFAULT_SIRI_DOWNLOAD_WAIT_TIMEOUT: Duration = Duration::from_secs(300);
const MIN_SIRI_DOWNLOAD_WAIT_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_SIRI_DOWNLOAD_WAIT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn berd_siri_tts_catalog_json(
        language: *const c_char,
        error_out: *mut *mut c_char,
    ) -> *mut c_char;
    fn berd_siri_tts_languages_json(error_out: *mut *mut c_char) -> *mut c_char;
    fn berd_siri_tts_download_voice(
        language: *const c_char,
        voice_name: *const c_char,
        availability_wait_timeout_seconds: f64,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_siri_tts_validate_voice(
        language: *const c_char,
        voice_name: *const c_char,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_siri_tts_synthesize_pcm(
        text: *const c_char,
        language: *const c_char,
        voice_name: *const c_char,
        rate: f32,
        should_stop: unsafe extern "C" fn(*mut c_void) -> bool,
        pcm_frames: unsafe extern "C" fn(*const f32, u32, *mut c_void) -> bool,
        context: *mut c_void,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_siri_tts_free_string(value: *mut c_char);
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiriVoiceIdentity {
    name: String,
    language: String,
}

impl SiriVoiceIdentity {
    pub fn new(name: impl Into<String>, language: &str) -> Result<Self, String> {
        let name = name.into();
        if name.is_empty() || name.trim() != name {
            return Err(
                "Siri voice name must be nonempty and have no surrounding whitespace".into(),
            );
        }
        if name.contains('\0') {
            return Err("Siri voice name contains NUL".into());
        }
        Ok(Self {
            name,
            language: normalize_bcp47(language)?,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn language(&self) -> &str {
        &self.language
    }
}

impl<'de> Deserialize<'de> for SiriVoiceIdentity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawIdentity {
            name: String,
            language: String,
        }

        let raw = RawIdentity::deserialize(deserializer)?;
        Self::new(raw.name, &raw.language).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiriVoice {
    pub name: String,
    pub language: String,
    pub size_bytes: u64,
    pub installed: bool,
}

impl SiriVoice {
    pub fn identity(&self) -> SiriVoiceIdentity {
        SiriVoiceIdentity {
            name: self.name.clone(),
            language: self.language.clone(),
        }
    }

    pub fn matches(&self, identity: &SiriVoiceIdentity) -> bool {
        self.name == identity.name && self.language == identity.language
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiriVoiceCatalog {
    pub available_languages: Vec<String>,
    pub voices: Vec<SiriVoice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawSiriVoice {
    name: String,
    language: String,
    size_bytes: u64,
    installed: bool,
}

fn normalize_bcp47(value: &str) -> Result<String, String> {
    let value = value.trim().replace('_', "-");
    if value.is_empty() || value.contains('\0') {
        return Err("Siri voice language must be a nonempty BCP-47 tag".into());
    }
    let mut normalized = Vec::new();
    let mut has_script = false;
    let mut has_region = false;
    let mut in_extension = false;
    for (index, segment) in value.split('-').enumerate() {
        if segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
            return Err(format!("invalid Siri voice BCP-47 language: {value}"));
        }
        let segment = if index == 0 {
            segment.to_ascii_lowercase()
        } else if segment.len() == 1 {
            in_extension = true;
            segment.to_ascii_lowercase()
        } else if in_extension {
            segment.to_ascii_lowercase()
        } else if !has_script
            && segment.len() == 4
            && segment.bytes().all(|byte| byte.is_ascii_alphabetic())
        {
            has_script = true;
            let mut chars = segment.chars();
            let first = chars.next().expect("four-character segment");
            format!(
                "{}{}",
                first.to_ascii_uppercase(),
                chars.as_str().to_ascii_lowercase()
            )
        } else if !has_region
            && ((segment.len() == 2 && segment.bytes().all(|byte| byte.is_ascii_alphabetic()))
                || (segment.len() == 3 && segment.bytes().all(|byte| byte.is_ascii_digit())))
        {
            has_region = true;
            segment.to_ascii_uppercase()
        } else {
            segment.to_ascii_lowercase()
        };
        normalized.push(segment);
    }
    Ok(normalized.join("-"))
}

fn parse_catalog_json(json: &str) -> Result<Vec<SiriVoice>, String> {
    serde_json::from_str::<Vec<RawSiriVoice>>(json)
        .map_err(|error| format!("decode Siri voice catalog: {error}"))?
        .into_iter()
        .map(|raw| {
            let identity = SiriVoiceIdentity::new(raw.name, &raw.language)?;
            Ok(SiriVoice {
                name: identity.name,
                language: identity.language,
                size_bytes: raw.size_bytes,
                installed: raw.installed,
            })
        })
        .collect()
}

fn parse_languages_json(json: &str) -> Result<Vec<String>, String> {
    let raw = serde_json::from_str::<Vec<String>>(json)
        .map_err(|error| format!("decode Siri voice languages: {error}"))?;
    let mut seen = BTreeSet::new();
    let mut languages = Vec::new();
    for language in raw {
        let language = normalize_bcp47(&language)?;
        if seen.insert(language.clone()) {
            languages.push(language);
        }
    }
    Ok(languages)
}

/// Loads the Siri voice catalog for one exact language, or all languages when
/// `None`. Voice identities use exact catalog names and normalized languages.
#[cfg(target_os = "macos")]
pub fn load_voice_catalog(language: Option<&str>) -> Result<SiriVoiceCatalog, String> {
    let language = language
        .map(normalize_bcp47)
        .transpose()?
        .unwrap_or_default();
    let language = CString::new(language).expect("normalized language has no NUL");
    let mut error = std::ptr::null_mut();
    // SAFETY: The bridge copies the input and returns malloc-owned strings.
    let voices = unsafe { berd_siri_tts_catalog_json(language.as_ptr(), &mut error) };
    let voices = take_string(voices)
        .ok_or_else(|| take_error(error, "Could not load the Siri voice catalog"))?;

    error = std::ptr::null_mut();
    // SAFETY: The bridge returns a malloc-owned string.
    let languages = unsafe { berd_siri_tts_languages_json(&mut error) };
    let languages = take_string(languages)
        .ok_or_else(|| take_error(error, "Could not load Siri voice languages"))?;

    Ok(SiriVoiceCatalog {
        available_languages: parse_languages_json(&languages)?,
        voices: parse_catalog_json(&voices)?,
    })
}

/// Returns an empty unsupported-platform catalog outside macOS.
#[cfg(not(target_os = "macos"))]
pub fn load_voice_catalog(_language: Option<&str>) -> Result<SiriVoiceCatalog, String> {
    Ok(SiriVoiceCatalog {
        available_languages: Vec::new(),
        voices: Vec::new(),
    })
}

/// Validates that one exact Siri voice identity is currently installed.
#[cfg(target_os = "macos")]
pub fn validate_installed_voice(identity: &SiriVoiceIdentity) -> Result<(), String> {
    let language =
        CString::new(identity.language.as_str()).expect("normalized language has no NUL");
    let name = CString::new(identity.name.as_str()).expect("validated name has no NUL");
    let mut error = std::ptr::null_mut();
    // SAFETY: Both strings remain valid for the duration of the call.
    if unsafe { berd_siri_tts_validate_voice(language.as_ptr(), name.as_ptr(), &mut error) } {
        Ok(())
    } else {
        Err(take_error(error, "Siri voice is not installed"))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn validate_installed_voice(_identity: &SiriVoiceIdentity) -> Result<(), String> {
    Err("Siri TTS is only available on macOS".into())
}

fn validate_download_wait_timeout(timeout: Duration) -> Result<(), String> {
    if !(MIN_SIRI_DOWNLOAD_WAIT_TIMEOUT..=MAX_SIRI_DOWNLOAD_WAIT_TIMEOUT).contains(&timeout) {
        return Err(format!(
            "Siri download availability wait must be between {} and {} seconds",
            MIN_SIRI_DOWNLOAD_WAIT_TIMEOUT.as_secs(),
            MAX_SIRI_DOWNLOAD_WAIT_TIMEOUT.as_secs()
        ));
    }
    Ok(())
}

/// Requests one exact voice and blocks until it is available or the bounded
/// availability-polling wait elapses. Native validation and subscription have
/// their own bounded calls, so this is not a hard whole-operation deadline.
pub fn download_voice(
    identity: &SiriVoiceIdentity,
    availability_wait_timeout: Duration,
) -> Result<(), String> {
    validate_download_wait_timeout(availability_wait_timeout)?;
    download_voice_platform(identity, availability_wait_timeout)
}

#[cfg(target_os = "macos")]
fn download_voice_platform(
    identity: &SiriVoiceIdentity,
    availability_wait_timeout: Duration,
) -> Result<(), String> {
    let language =
        CString::new(identity.language.as_str()).expect("normalized language has no NUL");
    let name = CString::new(identity.name.as_str()).expect("validated name has no NUL");
    let mut error = std::ptr::null_mut();
    // SAFETY: Both strings remain live for this blocking call.
    if unsafe {
        berd_siri_tts_download_voice(
            language.as_ptr(),
            name.as_ptr(),
            availability_wait_timeout.as_secs_f64(),
            &mut error,
        )
    } {
        Ok(())
    } else {
        Err(take_error(error, "Siri voice download failed"))
    }
}

#[cfg(not(target_os = "macos"))]
fn download_voice_platform(
    _identity: &SiriVoiceIdentity,
    _availability_wait_timeout: Duration,
) -> Result<(), String> {
    Err("Siri TTS is only available on macOS".into())
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
pub struct SiriTts {
    language: CString,
    voice_name: CString,
    rate: f32,
}

#[cfg(target_os = "macos")]
impl SiriTts {
    pub fn new(language: &str, voice_name: &str, rate: f32) -> Result<Self, String> {
        if !rate.is_finite() || !(0.5..=2.0).contains(&rate) {
            return Err("Siri rate must be between 0.5 and 2.0".into());
        }
        let identity = SiriVoiceIdentity::new(voice_name, language)?;
        validate_installed_voice(&identity)?;
        let language = CString::new(identity.language).expect("normalized language has no NUL");
        let voice_name = CString::new(identity.name).expect("validated name has no NUL");
        Ok(Self {
            language,
            voice_name,
            rate,
        })
    }
}

#[cfg(target_os = "macos")]
struct CallbackContext<'a> {
    active: &'a AtomicBool,
    callback_cancelled: &'a AtomicBool,
    sender: mpsc::SyncSender<Vec<f32>>,
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn should_stop(context: *mut c_void) -> bool {
    // SAFETY: The native call is scoped to the lifetime of this context.
    let context = unsafe { &*(context.cast::<CallbackContext<'_>>()) };
    !context.active.load(Ordering::SeqCst) || context.callback_cancelled.load(Ordering::SeqCst)
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn receive_pcm(
    samples: *const f32,
    frame_count: u32,
    context: *mut c_void,
) -> bool {
    // SAFETY: The bridge guarantees `frame_count` valid samples for this call.
    let frames = unsafe { std::slice::from_raw_parts(samples, frame_count as usize) };
    // SAFETY: The native call is scoped to the lifetime of this context.
    let context = unsafe { &*(context.cast::<CallbackContext<'_>>()) };
    context.active.load(Ordering::SeqCst) && context.sender.send(frames.to_vec()).is_ok()
}

#[cfg(target_os = "macos")]
impl TtsBackend for SiriTts {
    fn pcm_spec(&self) -> TtsPcmSpec {
        TtsPcmSpec {
            sample_rate: SIRI_PCM_SAMPLE_RATE,
            playback_rate: 1.0,
        }
    }

    fn synthesize(
        &self,
        text: &str,
        active: &AtomicBool,
        on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
    ) -> Result<TtsOutcome, String> {
        self.synthesize_with_poll(text, active, &mut |event| match event {
            TtsSynthesisEvent::Frames(frames) => on_frames(frames),
            TtsSynthesisEvent::Poll => Ok(()),
        })
    }

    fn synthesize_with_poll(
        &self,
        text: &str,
        active: &AtomicBool,
        on_event: &mut dyn FnMut(TtsSynthesisEvent<'_>) -> Result<(), String>,
    ) -> Result<TtsOutcome, String> {
        if !active.load(Ordering::SeqCst) {
            return Ok(TtsOutcome::Cancelled);
        }
        let text = CString::new(text).map_err(|_| "Siri text contains NUL")?;
        let (sender, receiver) = mpsc::sync_channel(PCM_CHANNEL_CAPACITY);
        let callback_cancelled = AtomicBool::new(false);
        let language = self.language.clone();
        let voice_name = self.voice_name.clone();
        let rate = self.rate;
        let result = std::thread::scope(|scope| {
            let mut context = CallbackContext {
                active,
                callback_cancelled: &callback_cancelled,
                sender,
            };
            let native = scope.spawn(move || {
                let mut error = std::ptr::null_mut();
                // SAFETY: All pointers remain valid until this blocking native
                // call returns, and callbacks only borrow the scoped context.
                let completed = unsafe {
                    berd_siri_tts_synthesize_pcm(
                        text.as_ptr(),
                        language.as_ptr(),
                        voice_name.as_ptr(),
                        rate,
                        should_stop,
                        receive_pcm,
                        (&mut context as *mut CallbackContext<'_>).cast(),
                        &mut error,
                    )
                };
                if completed {
                    Ok(())
                } else {
                    Err(take_error(error, "Siri synthesis failed"))
                }
            });
            let receive_result = receive_pcm_until_complete(
                receiver,
                &callback_cancelled,
                SYNTHESIS_POLL_INTERVAL,
                SIRI_SYNTHESIS_STALL_TIMEOUT,
                on_event,
            );
            let native = native
                .join()
                .map_err(|_| "Siri synthesis thread panicked".to_string())?;
            receive_result.and(native)
        });
        result?;
        Ok(if active.load(Ordering::SeqCst) {
            TtsOutcome::Completed
        } else {
            TtsOutcome::Cancelled
        })
    }
}

#[cfg(target_os = "macos")]
fn receive_pcm_until_complete(
    receiver: mpsc::Receiver<Vec<f32>>,
    callback_cancelled: &AtomicBool,
    poll_interval: Duration,
    stall_timeout: Duration,
    on_event: &mut dyn FnMut(TtsSynthesisEvent<'_>) -> Result<(), String>,
) -> Result<(), String> {
    let mut last_progress_at = std::time::Instant::now();
    loop {
        match receiver.recv_timeout(poll_interval) {
            Ok(frames) => {
                last_progress_at = std::time::Instant::now();
                if let Err(error) = on_event(TtsSynthesisEvent::Frames(&frames)) {
                    callback_cancelled.store(true, Ordering::SeqCst);
                    return Err(error);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Err(error) = on_event(TtsSynthesisEvent::Poll) {
                    callback_cancelled.store(true, Ordering::SeqCst);
                    return Err(error);
                }
                if last_progress_at.elapsed() >= stall_timeout {
                    callback_cancelled.store(true, Ordering::SeqCst);
                    return Err("Siri synthesis stopped making progress".into());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

#[cfg(target_os = "macos")]
fn take_error(error: *mut c_char, fallback: &str) -> String {
    if error.is_null() {
        return fallback.to_string();
    }
    // SAFETY: Bridge errors are malloc strings paired with this free function.
    let message = unsafe { CStr::from_ptr(error) }
        .to_string_lossy()
        .into_owned();
    unsafe { berd_siri_tts_free_string(error) };
    message
}

#[cfg(target_os = "macos")]
fn take_string(value: *mut c_char) -> Option<String> {
    if value.is_null() {
        return None;
    }
    // SAFETY: Bridge strings are malloc-owned and paired with this free function.
    let result = unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned();
    unsafe { berd_siri_tts_free_string(value) };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_catalog_json, parse_languages_json, validate_download_wait_timeout,
        SiriVoiceIdentity, MAX_SIRI_DOWNLOAD_WAIT_TIMEOUT, MIN_SIRI_DOWNLOAD_WAIT_TIMEOUT,
    };
    #[cfg(target_os = "macos")]
    use super::{receive_pcm_until_complete, SiriTts};
    #[cfg(target_os = "macos")]
    use crate::{TtsBackend, TtsOutcome, TtsSynthesisEvent};
    #[cfg(target_os = "macos")]
    use std::sync::atomic::{AtomicBool, Ordering};
    #[cfg(target_os = "macos")]
    use std::sync::mpsc;
    use std::time::Duration;
    #[cfg(target_os = "macos")]
    use std::time::Instant;

    #[test]
    fn catalog_decode_normalizes_identity_and_rejects_malformed_entries() {
        let catalog = parse_catalog_json(
            r#"[{"name":"Aaron","language":"en_US","sizeBytes":42,"installed":true}]"#,
        )
        .expect("valid catalog");
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "Aaron");
        assert_eq!(catalog[0].language, "en-US");
        assert_eq!(catalog[0].size_bytes, 42);
        assert!(catalog[0].installed);

        assert!(parse_catalog_json("not json").is_err());
        assert!(parse_catalog_json(
            r#"[{"name":"","language":"en-US","sizeBytes":42,"installed":true}]"#,
        )
        .is_err());
        assert!(parse_catalog_json(
            r#"[{"name":"Aaron","language":"en--US","sizeBytes":42,"installed":true}]"#,
        )
        .is_err());
    }

    #[test]
    fn identity_preserves_exact_name_and_normalizes_bcp47_language() {
        let identity = SiriVoiceIdentity::new("Aaron", "ZH_hans_cn").expect("identity");
        assert_eq!(identity.name, "Aaron");
        assert_eq!(identity.language, "zh-Hans-CN");
        assert_eq!(
            SiriVoiceIdentity::new("Aaron", "en_US_u_CA_gregory")
                .unwrap()
                .language,
            "en-US-u-ca-gregory"
        );

        let voices = parse_catalog_json(
            r#"[{"name":"Aaron","language":"zh-Hans-CN","sizeBytes":42,"installed":true}]"#,
        )
        .expect("catalog");
        assert!(voices[0].matches(&identity));
        assert!(!voices[0].matches(
            &SiriVoiceIdentity::new("aaron", "zh-Hans-CN").expect("case-sensitive identity")
        ));
    }

    #[test]
    fn catalog_decode_preserves_installed_status_for_exact_voices() {
        let voices = parse_catalog_json(
            r#"[
                {"name":"Aaron","language":"en-US","sizeBytes":42,"installed":true},
                {"name":"Quinn","language":"en_US","sizeBytes":84,"installed":false}
            ]"#,
        )
        .expect("catalog");
        assert!(voices[0].installed);
        assert!(!voices[1].installed);
        assert!(voices[0].matches(&SiriVoiceIdentity::new("Aaron", "en_US").unwrap()));
        assert!(voices[1].matches(&SiriVoiceIdentity::new("Quinn", "en-US").unwrap()));
    }

    #[test]
    fn languages_decode_uses_the_same_normalization_and_deduplicates() {
        assert_eq!(
            parse_languages_json(r#"["en_US","en-US","zh_hans_cn"]"#).expect("languages"),
            ["en-US", "zh-Hans-CN"]
        );
        assert!(parse_languages_json(r#"["en--US"]"#).is_err());
    }

    #[test]
    fn download_wait_timeout_is_explicitly_bounded() {
        assert!(validate_download_wait_timeout(MIN_SIRI_DOWNLOAD_WAIT_TIMEOUT).is_ok());
        assert!(validate_download_wait_timeout(MAX_SIRI_DOWNLOAD_WAIT_TIMEOUT).is_ok());
        assert!(validate_download_wait_timeout(Duration::ZERO).is_err());
        assert!(validate_download_wait_timeout(
            MAX_SIRI_DOWNLOAD_WAIT_TIMEOUT + Duration::from_secs(1)
        )
        .is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn pcm_receive_loop_resets_progress_deadline_and_cancels_a_stall() {
        let callback_cancelled = AtomicBool::new(false);
        let (sender, receiver) = mpsc::channel();
        let producer = std::thread::spawn(move || {
            for sample in [0.1, 0.2] {
                std::thread::sleep(Duration::from_millis(5));
                sender.send(vec![sample]).unwrap();
            }
        });
        let mut samples = Vec::new();
        let mut idle_polls = 0;
        receive_pcm_until_complete(
            receiver,
            &callback_cancelled,
            Duration::from_millis(2),
            Duration::from_secs(1),
            &mut |event| {
                match event {
                    TtsSynthesisEvent::Frames(frames) => samples.extend_from_slice(frames),
                    TtsSynthesisEvent::Poll => idle_polls += 1,
                }
                Ok(())
            },
        )
        .unwrap();
        producer.join().unwrap();
        assert_eq!(samples, [0.1, 0.2]);
        assert!(idle_polls > 0);
        assert!(!callback_cancelled.load(Ordering::SeqCst));

        let (_sender, receiver) = mpsc::channel();
        let error = receive_pcm_until_complete(
            receiver,
            &callback_cancelled,
            Duration::from_millis(1),
            Duration::from_millis(5),
            &mut |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(error, "Siri synthesis stopped making progress");
        assert!(callback_cancelled.load(Ordering::SeqCst));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn exact_uninstalled_voice_is_rejected_without_synthesis() {
        let error = SiriTts::new("en-US", "__berd_voice_does_not_exist__", 1.0).unwrap_err();
        assert!(error.contains("not installed") || error.contains("validating Siri voice"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "uses the private macOS Siri voice catalog"]
    fn native_catalog_returns_normalized_public_identities() {
        let catalog = super::load_voice_catalog(None).expect("load Siri catalog");
        assert!(!catalog.available_languages.is_empty());
        for voice in &catalog.voices {
            assert_eq!(
                SiriVoiceIdentity::new(voice.name.clone(), &voice.language).unwrap(),
                voice.identity()
            );
            if voice.installed {
                super::validate_installed_voice(&voice.identity())
                    .expect("catalog-installed voice validates exactly");
            }
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires BERD_SIRI_TEST_VOICE and invokes private sirittsd synthesis"]
    fn installed_voice_synthesizes_normalized_pcm_without_an_output_device() {
        let voice = std::env::var("BERD_SIRI_TEST_VOICE").unwrap();
        let language = std::env::var("BERD_SIRI_TEST_LANGUAGE").unwrap_or_else(|_| "en-US".into());
        let backend = SiriTts::new(&language, &voice, 1.0).unwrap();
        let mut frames = Vec::new();
        let outcome = backend
            .synthesize(
                "This is an in-memory Siri synthesis test.",
                &AtomicBool::new(true),
                &mut |chunk| {
                    frames.extend_from_slice(chunk);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(outcome, TtsOutcome::Completed);
        assert_eq!(backend.pcm_spec().sample_rate, 48_000);
        assert!(!frames.is_empty());
        assert!(frames.iter().all(|sample| sample.is_finite()));
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires BERD_SIRI_TEST_VOICE and invokes private sirittsd synthesis"]
    fn cancellation_during_pcm_delivery_returns_promptly() {
        let voice = std::env::var("BERD_SIRI_TEST_VOICE").unwrap();
        let language = std::env::var("BERD_SIRI_TEST_LANGUAGE").unwrap_or_else(|_| "en-US".into());
        let backend = SiriTts::new(&language, &voice, 1.0).unwrap();
        let active = AtomicBool::new(true);
        let started = Instant::now();
        let outcome = backend
            .synthesize(
                "This deliberately long sentence keeps Siri synthesis active long enough to test cancellation while decoded audio is crossing the native boundary and must return without leaving the worker or bounded channel stuck.",
                &active,
                &mut |chunk| {
                    assert!(!chunk.is_empty());
                    active.store(false, Ordering::SeqCst);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(outcome, TtsOutcome::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
