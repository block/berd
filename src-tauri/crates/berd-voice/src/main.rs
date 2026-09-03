use std::io::{self, BufWriter, Read, Write};
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, SyncSender},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

use berd_voice::benchmark::{
    benchmark_stt, benchmark_tts, benchmark_tts_manifest, load_bundled_stt_fixture_pack,
    load_bundled_tts_prompt_manifest, SttBenchmarkEnvironment, SttBenchmarkMode,
    SttBenchmarkTarget, TtsBenchmarkMode, TtsBenchmarkPromptManifest, TtsBenchmarkTarget,
};
use berd_voice::input::{
    AssistantActivityGuard, InputDuringTtsSlot, InputDuringTtsSnapshot, VoiceInputConfig,
    VoiceInputControls, VoiceInputEngineConfig, VoiceInputEvent, VoiceInputFrame,
    VoiceInputRuntime, INPUT_FRAME_SAMPLES,
};
use berd_voice::protocol::{
    CancelOutcome, InputDuringTtsOutcome, NotAdmittedReason, OutputReadyOutcome, SessionMessage,
    SessionRequest, TtsSettingsOutcome, VoiceSessionSnapshot,
};
use berd_voice::session::{PrepareOutcome, PrepareRequest, SessionCore};
use berd_voice::{
    estimated_spoken_through_utf8,
    local_assets::{
        LocalAssetLockError, LocalAssetRoots, LocalInstallError, LocalInstallErrorKind,
        LocalInstallPhase, LocalInstallProgress,
    },
    ConfiguredTtsSlot, DeliveryProgress, TtsBackend, TtsConfiguration, TtsConfigurationLease,
    TtsConfigurationRejection, TtsConfigurationRejectionKind, WavSynthesisErrorKind,
};
use serde::Serialize;

mod session_audio;

use session_audio::{
    AudioHostAck, AudioOutputControlRequest, AudioPipeTransport, RemotePcmAudioOutput,
    AUDIO_CANCELLED,
};

const WIRE_MARKER: u32 = 2;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const FRAME_MAGIC: [u8; 2] = *b"BV";
const JSON_FRAME_KIND: u8 = 1;
const PCM_FRAME_KIND: u8 = 2;
const FRAME_HEADER_BYTES: usize = 8;
const PCM_FRAME_BYTES: usize = INPUT_FRAME_SAMPLES * std::mem::size_of::<f32>();
const MAX_FINAL_TEXT_BYTES: usize = 64 * 1024;
const MAX_SPEAK_TEXT_BYTES: usize = 16 * 1024;
const INPUT_QUEUE_CAPACITY: usize = 32;
const INPUT_STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_PLAYBACK_TIMEOUT: Duration = Duration::from_secs(3);
const TTS_CONFIGURATION_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OPENAI_BENCHMARK_REQUESTS: usize = 20;
const MAX_OPENAI_BENCHMARK_TEXT_BYTES: usize = 64 * 1024;
const MAX_OPENAI_STT_BENCHMARK_SECONDS: f64 = 120.0;

enum Input {
    Request(SessionRequest),
    Pcm(Box<VoiceInputFrame>),
    Invalid(String),
    Eof,
}

struct OrderedControl {
    after_pcm: u64,
    input: Input,
}

#[derive(Debug)]
enum PlaybackEvent {
    #[cfg(test)]
    Started(u64),
    Completed(u64),
    Interrupted(u64, u64),
    Failed(u64, String, bool),
}

#[derive(Debug)]
struct PlaybackFailure {
    message: String,
    output_quiescent: bool,
}

struct TtsConfigurationEvent {
    attempt: u64,
    id: u64,
    result: Result<berd_voice::TtsConfigurationReplacement, TtsConfigurationRejection>,
}

#[derive(Clone, Copy, Debug)]
struct ActiveTtsConfigurationUpdate {
    attempt: u64,
    id: u64,
    deadline: Instant,
}

struct ActivePlayback {
    prepare_id: u64,
    speech_id: u64,
    text: String,
    output: Option<Arc<RemotePcmAudioOutput>>,
    active: Option<Arc<AtomicBool>>,
    ready_deadline: Instant,
    assistant_activity: Option<AssistantActivityGuard>,
    input_during_tts: InputDuringTtsSnapshot,
    tts: TtsConfigurationLease,
    suspension_requested: bool,
}

#[derive(Clone, Debug, PartialEq)]
enum TtsBackendConfig {
    OpenAi {
        rate: f32,
    },
    Siri {
        voice: String,
        language: String,
        rate: f32,
    },
    Pocket {
        model_dir: PathBuf,
        voice: String,
        rate: f32,
    },
}

#[derive(Clone, Debug, PartialEq)]
enum SttBackendConfig {
    Macos,
    Parakeet { model_dir: PathBuf },
    OpenAi,
}

#[derive(Clone, Debug, PartialEq)]
struct SessionConfig {
    tts: TtsBackendConfig,
    stt: SttBackendConfig,
}

#[derive(Clone, Debug, PartialEq)]
struct TtsBenchmarkConfig {
    tts: TtsBackendConfig,
    prompts: TtsBenchmarkPrompts,
    mode: TtsBenchmarkMode,
}

#[derive(Clone, Debug, PartialEq)]
enum TtsBenchmarkPrompts {
    ExactRepeat { text: String, runs: usize },
    Manifest(TtsBenchmarkPromptManifest),
}

#[derive(Clone, Debug, PartialEq)]
struct SttBenchmarkConfig {
    stt: SttBackendConfig,
    runs: usize,
    mode: SttBenchmarkMode,
    allow_paid_openai: bool,
}

#[derive(Clone, Debug, PartialEq)]
enum SynthesisTtsConfig {
    OpenAi {
        model: String,
        voice: String,
        rate: f32,
    },
    Local(TtsBackendConfig),
}

#[derive(Clone, Debug, PartialEq)]
struct SynthesisConfig {
    tts: SynthesisTtsConfig,
    text: String,
    output: PathBuf,
}

impl SynthesisConfig {
    fn backend(&self) -> &'static str {
        match &self.tts {
            SynthesisTtsConfig::OpenAi { .. } => "openai",
            SynthesisTtsConfig::Local(TtsBackendConfig::Siri { .. }) => "siri",
            SynthesisTtsConfig::Local(TtsBackendConfig::Pocket { .. }) => "pocket",
            SynthesisTtsConfig::Local(TtsBackendConfig::OpenAi { .. }) => {
                unreachable!("OpenAI synthesis carries explicit identity")
            }
        }
    }
}

const MANAGEMENT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
enum ManagementCommand {
    ListVoices {
        language: Option<String>,
    },
    DownloadVoice {
        identity: berd_voice::siri::SiriVoiceIdentity,
        availability_wait: berd_voice::siri::SiriDownloadAvailabilityWait,
    },
    MacosModelStatus,
    InstallMacosModel,
    PocketModelStatus {
        roots: LocalAssetRoots,
    },
    InstallPocketModel {
        roots: LocalAssetRoots,
    },
    ListPocketVoices,
    ParakeetModelStatus {
        roots: LocalAssetRoots,
    },
    InstallParakeetModel {
        roots: LocalAssetRoots,
    },
}

impl ManagementCommand {
    fn operation(&self) -> &'static str {
        match self {
            Self::ListVoices { .. } => "voices.list",
            Self::DownloadVoice { .. } => "voices.download",
            Self::MacosModelStatus => "models.macos.status",
            Self::InstallMacosModel => "models.macos.install",
            Self::PocketModelStatus { .. } => "models.pocket.status",
            Self::InstallPocketModel { .. } => "models.pocket.install",
            Self::ListPocketVoices => "models.pocket.voices",
            Self::ParakeetModelStatus { .. } => "models.parakeet.status",
            Self::InstallParakeetModel { .. } => "models.parakeet.install",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalModelKind {
    Pocket,
    Parakeet,
}

impl LocalModelKind {
    fn backend(self) -> &'static str {
        match self {
            Self::Pocket => "pocket",
            Self::Parakeet => "parakeet",
        }
    }

    fn model_id(self) -> &'static str {
        match self {
            Self::Pocket => berd_voice::pocket_assets::MODEL_ID,
            Self::Parakeet => berd_voice::parakeet_assets::MODEL_ID,
        }
    }

    fn total_download_bytes(self) -> u64 {
        match self {
            Self::Pocket => berd_voice::pocket_assets::download_bytes(),
            Self::Parakeet => berd_voice::parakeet_assets::download_bytes(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalModelState {
    Missing,
    Invalid,
    Ready { verified_bytes: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalModelStatusResult {
    backend: &'static str,
    model_id: &'static str,
    state: &'static str,
    ready: bool,
    verified_bytes: Option<u64>,
    total_download_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalModelInstallResult {
    backend: &'static str,
    model_id: &'static str,
    outcome: &'static str,
    ready: bool,
    verified_bytes: u64,
    cleanup_pending: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PocketVoicesResult {
    backend: &'static str,
    model_id: &'static str,
    voice_license_id: &'static str,
    voices: Vec<PocketVoiceResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct PocketVoiceResult {
    id: &'static str,
    name: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoicesListResult {
    backend: &'static str,
    supported: bool,
    language_filter: Option<String>,
    available_languages: Vec<String>,
    voices: Vec<berd_voice::siri::SiriVoice>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceDownloadResult {
    backend: &'static str,
    voice: berd_voice::siri::SiriVoiceIdentity,
    installed: bool,
    availability_wait_seconds: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MacosModelStatus {
    supported: bool,
    locale: Option<String>,
    locale_supported: bool,
    model_status: String,
    ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagementResultEnvelope<T> {
    schema_version: u32,
    operation: &'static str,
    event: &'static str,
    result: T,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagementProgressEnvelope {
    schema_version: u32,
    operation: &'static str,
    event: &'static str,
    fraction: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalModelProgressEnvelope {
    schema_version: u32,
    operation: &'static str,
    event: &'static str,
    phase: &'static str,
    downloaded_bytes: u64,
    total_download_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagementErrorEnvelope {
    schema_version: u32,
    operation: &'static str,
    event: &'static str,
    error: ManagementErrorBody,
}

#[derive(Serialize)]
struct ManagementErrorBody {
    code: &'static str,
    message: &'static str,
}

#[derive(Debug)]
struct ManagementFailure {
    code: &'static str,
    public_message: &'static str,
    detail: String,
}

#[derive(Debug)]
struct SynthesisFailure {
    code: &'static str,
    public_message: &'static str,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SynthesisResult {
    backend: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    voice: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    rate: f32,
    wav: SynthesisWavResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SynthesisWavResult {
    encoding: &'static str,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    frames: u64,
    duration_ms: f64,
    bytes: u64,
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("session") => {
            let pcm_output_fd =
                parse_pcm_output_fd(&args).unwrap_or_else(|error| usage_error(&error));
            let config = parse_args(&args).unwrap_or_else(|error| usage_error(&error));
            if let Err(error) = run_session(config, pcm_output_fd) {
                eprintln!("berd-voice session failed: {error}");
                std::process::exit(1);
            }
        }
        Some("benchmark") if args.get(2).map(String::as_str) == Some("tts") => {
            let config =
                parse_tts_benchmark_args(&args).unwrap_or_else(|error| usage_error(&error));
            if let Err(error) = run_tts_benchmark(config) {
                eprintln!("berd-voice benchmark tts failed: {error}");
                std::process::exit(1);
            }
        }
        Some("benchmark") if args.get(2).map(String::as_str) == Some("stt") => {
            let config =
                parse_stt_benchmark_args(&args).unwrap_or_else(|error| usage_error(&error));
            if let Err(error) = run_stt_benchmark(config) {
                eprintln!("berd-voice benchmark stt failed: {error}");
                std::process::exit(1);
            }
        }
        Some("synthesize") => {
            let config =
                parse_synthesis_args(&args).unwrap_or_else(|error| usage_error(&error));
            if let Err(failure) = run_synthesis_command(config) {
                if failure.code != "output_failed" {
                    let envelope = ManagementErrorEnvelope {
                        schema_version: MANAGEMENT_SCHEMA_VERSION,
                        operation: "synthesize",
                        event: "error",
                        error: ManagementErrorBody {
                            code: failure.code,
                            message: failure.public_message,
                        },
                    };
                    if let Err(error) = write_json_line(io::stdout().lock(), &envelope) {
                        eprintln!("berd-voice could not write synthesis error: {error}");
                    }
                }
                eprintln!("berd-voice synthesize failed: {}", failure.detail);
                std::process::exit(1);
            }
        }
        Some("voices" | "models") => {
            let command = parse_management_args(&args).unwrap_or_else(|error| usage_error(&error));
            let operation = command.operation();
            if let Err(failure) = run_management_command(command) {
                if failure.code == "output_failed" {
                    eprintln!("berd-voice {operation} failed: {}", failure.detail);
                    std::process::exit(1);
                }
                let envelope = management_error_envelope(operation, &failure);
                if let Err(error) = write_json_line(io::stdout().lock(), &envelope) {
                    eprintln!("berd-voice could not write management error: {error}");
                }
                eprintln!("berd-voice {operation} failed: {}", failure.detail);
                std::process::exit(1);
            }
        }
        _ => usage_error(
            "supported commands are session, synthesize, voices, models, benchmark tts, and benchmark stt",
        ),
    }
}

fn usage_error(error: &str) -> ! {
    eprintln!("{error}");
    eprintln!(
        "usage:\n  berd-voice session --pcm-output-fd FD [--tts-backend siri|openai|pocket] \
         [--model-dir PATH] [--voice ID] [--language BCP47] [--rate FLOAT] \
         [--stt-backend macos|parakeet|openai] [--stt-model-dir PATH]\n  \
         berd-voice synthesize --tts-backend siri|openai|pocket --voice ID \
         [--language BCP47] [--model MODEL] [--model-dir ABSOLUTE_PATH] [--rate FLOAT] \
         [--allow-paid-openai] --text TEXT --output PATH\n  \
         berd-voice benchmark tts --tts-backend openai|siri|pocket \
         [--model-dir PATH] [--voice ID] [--language BCP47] [--rate FLOAT] \
         (--text TEXT --runs COUNT | --prompt-manifest english-short-v1) \
         --mode fresh-backend|warm [--allow-paid-openai]\n  \
         berd-voice benchmark stt --stt-backend macos|parakeet|openai \
         [--stt-model-dir PATH] --runs COUNT --mode cold|warm \
         [--allow-paid-openai]\n  \
         berd-voice voices list [--language BCP47]\n  \
         berd-voice voices download --voice NAME --language BCP47 \
         [--availability-wait-seconds 1..1800]\n  \
         berd-voice models macos status\n  \
         berd-voice models macos install\n  \
         berd-voice models pocket status|install --store-root ABSOLUTE_PATH\n  \
         berd-voice models pocket voices\n  \
         berd-voice models parakeet status|install --store-root ABSOLUTE_PATH"
    );
    std::process::exit(2);
}

fn parse_management_args(args: &[String]) -> Result<ManagementCommand, String> {
    match (
        args.get(1).map(String::as_str),
        args.get(2).map(String::as_str),
        args.get(3).map(String::as_str),
    ) {
        (Some("voices"), Some("list"), _) => {
            let mut language = None;
            let mut index = 3;
            while index < args.len() {
                let flag = args[index].as_str();
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("{flag} requires a value"))?;
                match flag {
                    "--language" if language.is_none() => language = Some(value.clone()),
                    "--language" => return Err("--language may be provided only once".into()),
                    _ => return Err(format!("unknown voices list argument: {flag}")),
                }
                index += 2;
            }
            let language = language
                .as_deref()
                .map(berd_voice::siri::normalize_language)
                .transpose()?;
            Ok(ManagementCommand::ListVoices { language })
        }
        (Some("voices"), Some("download"), _) => {
            let mut voice = None;
            let mut language = None;
            let mut availability_wait = berd_voice::siri::SiriDownloadAvailabilityWait::default();
            let mut wait_seen = false;
            let mut index = 3;
            while index < args.len() {
                let flag = args[index].as_str();
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("{flag} requires a value"))?;
                match flag {
                    "--voice" if voice.is_none() => voice = Some(value.clone()),
                    "--language" if language.is_none() => language = Some(value.clone()),
                    "--availability-wait-seconds" if !wait_seen => {
                        let seconds = value.parse::<u64>().map_err(|_| {
                            "--availability-wait-seconds must be an integer from 1 to 1800"
                                .to_string()
                        })?;
                        availability_wait =
                            berd_voice::siri::SiriDownloadAvailabilityWait::from_seconds(seconds)?;
                        wait_seen = true;
                    }
                    "--voice" | "--language" | "--availability-wait-seconds" => {
                        return Err(format!("{flag} may be provided only once"))
                    }
                    _ => return Err(format!("unknown voices download argument: {flag}")),
                }
                index += 2;
            }
            let voice = voice.ok_or_else(|| "--voice is required".to_string())?;
            let language = language.ok_or_else(|| "--language is required".to_string())?;
            Ok(ManagementCommand::DownloadVoice {
                identity: berd_voice::siri::SiriVoiceIdentity::new(voice, &language)?,
                availability_wait,
            })
        }
        (Some("models"), Some("macos"), Some("status")) if args.len() == 4 => {
            Ok(ManagementCommand::MacosModelStatus)
        }
        (Some("models"), Some("macos"), Some("install")) if args.len() == 4 => {
            Ok(ManagementCommand::InstallMacosModel)
        }
        (Some("models"), Some("pocket"), Some("status")) => {
            Ok(ManagementCommand::PocketModelStatus {
                roots: parse_local_model_roots(args)?,
            })
        }
        (Some("models"), Some("pocket"), Some("install")) => {
            Ok(ManagementCommand::InstallPocketModel {
                roots: parse_local_model_roots(args)?,
            })
        }
        (Some("models"), Some("pocket"), Some("voices")) if args.len() == 4 => {
            Ok(ManagementCommand::ListPocketVoices)
        }
        (Some("models"), Some("parakeet"), Some("status")) => {
            Ok(ManagementCommand::ParakeetModelStatus {
                roots: parse_local_model_roots(args)?,
            })
        }
        (Some("models"), Some("parakeet"), Some("install")) => {
            Ok(ManagementCommand::InstallParakeetModel {
                roots: parse_local_model_roots(args)?,
            })
        }
        (Some("voices"), _, _) => Err("expected voices list or voices download".into()),
        (Some("models"), _, _) => Err("expected a supported models command".into()),
        _ => Err("expected a management command".into()),
    }
}

fn parse_local_model_roots(args: &[String]) -> Result<LocalAssetRoots, String> {
    if args.len() != 6 || args.get(4).map(String::as_str) != Some("--store-root") {
        return Err("local model status/install requires --store-root exactly once".into());
    }
    let value = &args[5];
    if value
        .split(['/', '\\'])
        .any(|component| matches!(component, "." | ".."))
    {
        return Err("--store-root must not contain . or .. components".into());
    }
    local_model_roots(std::path::Path::new(value))
}

fn local_model_roots(store_root: &std::path::Path) -> Result<LocalAssetRoots, String> {
    LocalAssetRoots::new(
        store_root,
        store_root.join(berd_voice::pocket_assets::MODEL_ID),
        store_root
            .join(berd_voice::pocket_assets::MODEL_ID)
            .join("stt"),
    )
    .map_err(|error| error.to_string())
}

fn voices_list_report(
    supported: bool,
    language_filter: Option<String>,
    catalog: berd_voice::siri::SiriVoiceCatalog,
) -> VoicesListResult {
    VoicesListResult {
        backend: "siri",
        supported,
        language_filter,
        available_languages: catalog.available_languages,
        voices: catalog.voices,
    }
}

fn voice_download_report(
    identity: &berd_voice::siri::SiriVoiceIdentity,
    availability_wait: berd_voice::siri::SiriDownloadAvailabilityWait,
) -> VoiceDownloadResult {
    VoiceDownloadResult {
        backend: "siri",
        voice: identity.clone(),
        installed: true,
        availability_wait_seconds: availability_wait.seconds(),
    }
}

fn pocket_voices_report() -> PocketVoicesResult {
    PocketVoicesResult {
        backend: "pocket",
        model_id: berd_voice::pocket_assets::MODEL_ID,
        voice_license_id: berd_voice::pocket_assets::VOICE_LICENSE_ID,
        voices: berd_voice::pocket_assets::voices()
            .iter()
            .map(|voice| PocketVoiceResult {
                id: voice.id,
                name: voice.name,
            })
            .collect(),
    }
}

fn local_model_status_report(
    model: LocalModelKind,
    state: LocalModelState,
) -> LocalModelStatusResult {
    let (state_name, verified_bytes) = match state {
        LocalModelState::Missing => ("missing", None),
        LocalModelState::Invalid => ("invalid", None),
        LocalModelState::Ready { verified_bytes } => ("ready", Some(verified_bytes)),
    };
    LocalModelStatusResult {
        backend: model.backend(),
        model_id: model.model_id(),
        state: state_name,
        ready: matches!(state, LocalModelState::Ready { .. }),
        verified_bytes,
        total_download_bytes: model.total_download_bytes(),
    }
}

fn read_local_model_status(
    model: LocalModelKind,
    roots: &LocalAssetRoots,
) -> Result<LocalModelStatusResult, ManagementFailure> {
    match std::fs::symlink_metadata(roots.coordination_root()) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(local_model_status_report(model, LocalModelState::Missing));
        }
        Err(error) => {
            return Err(management_failure(
                "io_failed",
                "Could not inspect the local model store",
                error.to_string(),
            ));
        }
        Ok(_) => {}
    }
    let _assets =
        berd_voice::local_assets::try_lock_for_read(roots).map_err(local_model_lock_failure)?;
    let state = match model {
        LocalModelKind::Pocket => match berd_voice::pocket_assets::inspect(
            roots.pocket_bundle_root(),
        )
        .map_err(|error| {
            management_failure(
                "integrity_failed",
                "Could not inspect the Pocket model",
                error,
            )
        })? {
            berd_voice::pocket_assets::PocketAssetStatus::Missing => LocalModelState::Missing,
            berd_voice::pocket_assets::PocketAssetStatus::Invalid => LocalModelState::Invalid,
            berd_voice::pocket_assets::PocketAssetStatus::Ready { verified_bytes } => {
                LocalModelState::Ready { verified_bytes }
            }
        },
        LocalModelKind::Parakeet => {
            match berd_voice::parakeet_assets::inspect(roots.parakeet_bundle_root()).map_err(
                |error| {
                    management_failure(
                        "integrity_failed",
                        "Could not inspect the Parakeet model",
                        error,
                    )
                },
            )? {
                berd_voice::parakeet_assets::ParakeetAssetStatus::Missing => {
                    LocalModelState::Missing
                }
                berd_voice::parakeet_assets::ParakeetAssetStatus::Invalid => {
                    LocalModelState::Invalid
                }
                berd_voice::parakeet_assets::ParakeetAssetStatus::Ready { verified_bytes } => {
                    LocalModelState::Ready { verified_bytes }
                }
            }
        }
    };
    Ok(local_model_status_report(model, state))
}

fn local_model_lock_failure(error: LocalAssetLockError) -> ManagementFailure {
    match error {
        LocalAssetLockError::Busy => management_failure(
            "busy",
            "The local model store is being updated",
            error.to_string(),
        ),
        LocalAssetLockError::InvalidRoot(_) => management_failure(
            "invalid_root",
            "The local model store root is invalid",
            error.to_string(),
        ),
        LocalAssetLockError::Io(_) => management_failure(
            "io_failed",
            "Could not access the local model store",
            error.to_string(),
        ),
    }
}

#[cfg(any(test, not(target_os = "macos")))]
fn unsupported_macos_model_status() -> MacosModelStatus {
    MacosModelStatus {
        supported: false,
        locale: None,
        locale_supported: false,
        model_status: "unsupported".into(),
        ready: false,
    }
}

#[cfg(target_os = "macos")]
fn current_macos_model_status() -> Result<MacosModelStatus, String> {
    let status = berd_voice::mac_speech::mac_speech_status()?;
    Ok(MacosModelStatus {
        supported: status.supported,
        locale: status.locale,
        locale_supported: status.locale_supported,
        model_status: status.model_status,
        ready: status.ready,
    })
}

#[cfg(not(target_os = "macos"))]
fn current_macos_model_status() -> Result<MacosModelStatus, String> {
    Ok(unsupported_macos_model_status())
}

fn macos_install_needs_mutation(status: &MacosModelStatus) -> Result<bool, ManagementFailure> {
    if !status.supported {
        return Err(management_failure(
            "unsupported",
            "macOS SpeechTranscriber is unavailable on this system",
            "macOS SpeechTranscriber is unavailable on this system",
        ));
    }
    if !status.locale_supported {
        return Err(management_failure(
            "unsupported_locale",
            "macOS SpeechTranscriber does not support the current locale",
            "macOS SpeechTranscriber does not support the current locale",
        ));
    }
    Ok(!status.ready)
}

#[cfg(target_os = "macos")]
fn install_macos_model_platform() -> Result<(), String> {
    berd_voice::mac_speech::install_mac_speech_model(write_management_progress)
}

#[cfg(not(target_os = "macos"))]
fn install_macos_model_platform() -> Result<(), String> {
    Err("macOS speech model installation is available only on macOS".into())
}

fn normalized_install_progress(value: f64) -> Option<f64> {
    value.is_finite().then(|| value.clamp(0.0, 1.0))
}

fn write_json_line(mut writer: impl Write, value: &impl Serialize) -> Result<(), String> {
    serde_json::to_writer(&mut writer, value).map_err(|error| error.to_string())?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

fn write_management_result<T: Serialize>(operation: &'static str, result: T) -> Result<(), String> {
    write_json_line(
        io::stdout().lock(),
        &ManagementResultEnvelope {
            schema_version: MANAGEMENT_SCHEMA_VERSION,
            operation,
            event: "result",
            result,
        },
    )
}

fn write_management_progress(progress: f64) {
    let Some(fraction) = normalized_install_progress(progress) else {
        eprintln!("berd-voice ignored invalid macOS model install progress: {progress}");
        return;
    };
    let envelope = ManagementProgressEnvelope {
        schema_version: MANAGEMENT_SCHEMA_VERSION,
        operation: "models.macos.install",
        event: "progress",
        fraction,
    };
    if let Err(error) = write_json_line(io::stdout().lock(), &envelope) {
        eprintln!("berd-voice could not write install progress: {error}");
    }
}

fn local_install_phase_name(phase: LocalInstallPhase) -> &'static str {
    match phase {
        LocalInstallPhase::Downloading => "downloading",
        LocalInstallPhase::Extracting => "extracting",
        LocalInstallPhase::Verifying => "verifying",
        LocalInstallPhase::Publishing => "publishing",
        LocalInstallPhase::Complete => "complete",
    }
}

fn write_local_model_progress(operation: &'static str, progress: LocalInstallProgress) {
    let envelope = LocalModelProgressEnvelope {
        schema_version: MANAGEMENT_SCHEMA_VERSION,
        operation,
        event: "progress",
        phase: local_install_phase_name(progress.phase),
        downloaded_bytes: progress.downloaded_bytes,
        total_download_bytes: progress.total_download_bytes,
    };
    if let Err(error) = write_json_line(io::stdout().lock(), &envelope) {
        eprintln!("berd-voice could not write local model install progress: {error}");
    }
}

fn local_install_failure(error: LocalInstallError) -> ManagementFailure {
    let (code, message) = match error.kind {
        LocalInstallErrorKind::Busy => ("busy", "The local model store is being updated"),
        LocalInstallErrorKind::InvalidRoot => {
            ("invalid_root", "The local model store root is invalid")
        }
        LocalInstallErrorKind::Download => ("download_failed", "Could not download the model"),
        LocalInstallErrorKind::Integrity => {
            ("integrity_failed", "The local model failed verification")
        }
        LocalInstallErrorKind::Extraction => {
            ("extraction_failed", "Could not extract the local model")
        }
        LocalInstallErrorKind::Io => ("io_failed", "Could not access the local model store"),
        LocalInstallErrorKind::Publish => ("publish_failed", "Could not publish the local model"),
        LocalInstallErrorKind::Rollback => (
            "rollback_failed",
            "Could not restore the prior local model store",
        ),
        LocalInstallErrorKind::Recovery => {
            ("recovery_failed", "The local model store needs recovery")
        }
        LocalInstallErrorKind::Cleanup => {
            ("cleanup_failed", "Could not clean the local model store")
        }
    };
    let mut detail = error.to_string();
    if !error.recovery_paths.is_empty() {
        detail.push_str("; recovery data remains at ");
        detail.push_str(
            &error
                .recovery_paths
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    management_failure(code, message, detail)
}

fn run_local_model_install(
    model: LocalModelKind,
    roots: LocalAssetRoots,
    operation: &'static str,
) -> Result<LocalModelInstallResult, ManagementFailure> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            management_failure(
                "operation_failed",
                "Could not start the local model installer",
                error.to_string(),
            )
        })?;
    let (outcome, verified_bytes, cleanup_pending) = match model {
        LocalModelKind::Pocket => {
            match runtime.block_on(berd_voice::pocket_assets::install(&roots, |progress| {
                write_local_model_progress(operation, progress);
            })) {
                Ok(berd_voice::pocket_assets::PocketInstallOutcome::AlreadyReady {
                    verified_bytes,
                }) => ("alreadyReady", verified_bytes, None),
                Ok(berd_voice::pocket_assets::PocketInstallOutcome::Installed {
                    verified_bytes,
                    cleanup_pending,
                }) => ("installed", verified_bytes, cleanup_pending),
                Err(error) => return Err(local_install_failure(error)),
            }
        }
        LocalModelKind::Parakeet => {
            match runtime.block_on(berd_voice::parakeet_assets::install(&roots, |progress| {
                write_local_model_progress(operation, progress);
            })) {
                Ok(berd_voice::parakeet_assets::ParakeetInstallOutcome::AlreadyReady {
                    verified_bytes,
                }) => ("alreadyReady", verified_bytes, None),
                Ok(berd_voice::parakeet_assets::ParakeetInstallOutcome::Installed {
                    verified_bytes,
                    cleanup_pending,
                }) => ("installed", verified_bytes, cleanup_pending),
                Err(error) => return Err(local_install_failure(error)),
            }
        }
    };
    if let Some(path) = cleanup_pending.as_ref() {
        eprintln!(
            "berd-voice installed the {} model; prior backup cleanup remains at {}",
            model.backend(),
            path.display()
        );
    }
    Ok(LocalModelInstallResult {
        backend: model.backend(),
        model_id: model.model_id(),
        outcome,
        ready: true,
        verified_bytes,
        cleanup_pending: cleanup_pending.is_some(),
    })
}

fn management_failure(
    code: &'static str,
    public_message: &'static str,
    detail: impl Into<String>,
) -> ManagementFailure {
    ManagementFailure {
        code,
        public_message,
        detail: detail.into(),
    }
}

fn management_error_envelope(
    operation: &'static str,
    failure: &ManagementFailure,
) -> ManagementErrorEnvelope {
    ManagementErrorEnvelope {
        schema_version: MANAGEMENT_SCHEMA_VERSION,
        operation,
        event: "error",
        error: ManagementErrorBody {
            code: failure.code,
            message: failure.public_message,
        },
    }
}

#[cfg(any(test, target_os = "macos"))]
fn voice_download_failure(error: berd_voice::siri::SiriVoiceDownloadError) -> ManagementFailure {
    match error {
        berd_voice::siri::SiriVoiceDownloadError::NotFound(_) => management_failure(
            "voice_not_found",
            "The requested Siri voice was not found",
            error.to_string(),
        ),
        berd_voice::siri::SiriVoiceDownloadError::Operation(_) => management_failure(
            "operation_failed",
            "Could not make the requested Siri voice available",
            error.to_string(),
        ),
    }
}

fn run_management_command(command: ManagementCommand) -> Result<(), ManagementFailure> {
    let operation = command.operation();
    match command {
        ManagementCommand::ListVoices { language } => {
            let catalog =
                berd_voice::siri::load_voice_catalog(language.as_deref()).map_err(|error| {
                    management_failure("operation_failed", "Could not list Siri voices", error)
                })?;
            write_management_result(
                operation,
                voices_list_report(cfg!(target_os = "macos"), language, catalog),
            )
            .map_err(|error| {
                management_failure("output_failed", "Could not write command result", error)
            })
        }
        ManagementCommand::DownloadVoice {
            identity,
            availability_wait,
        } => {
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (identity, availability_wait);
                return Err(management_failure(
                    "unsupported",
                    "Siri voice download is available only on macOS",
                    "Siri voice download is available only on macOS",
                ));
            }
            #[cfg(target_os = "macos")]
            {
                let identity = berd_voice::siri::download_voice(&identity, availability_wait)
                    .map_err(voice_download_failure)?;
                let result = voice_download_report(&identity, availability_wait);
                write_management_result(operation, result).map_err(|error| {
                    management_failure("output_failed", "Could not write command result", error)
                })
            }
        }
        ManagementCommand::MacosModelStatus => {
            let status = current_macos_model_status().map_err(|error| {
                management_failure(
                    "operation_failed",
                    "Could not read macOS speech model status",
                    error,
                )
            })?;
            write_management_result(operation, status).map_err(|error| {
                management_failure("output_failed", "Could not write command result", error)
            })
        }
        ManagementCommand::InstallMacosModel => {
            let initial_status = current_macos_model_status().map_err(|error| {
                management_failure(
                    "operation_failed",
                    "Could not read macOS speech model status",
                    error,
                )
            })?;
            let needs_mutation = macos_install_needs_mutation(&initial_status)?;
            let status = if needs_mutation {
                install_macos_model_platform().map_err(|error| {
                    management_failure(
                        "operation_failed",
                        "Could not install the macOS speech model",
                        error,
                    )
                })?;
                current_macos_model_status().map_err(|error| {
                    management_failure(
                        "operation_failed",
                        "The model installed but its status could not be read",
                        error,
                    )
                })?
            } else {
                initial_status
            };
            write_management_result(operation, status).map_err(|error| {
                management_failure("output_failed", "Could not write command result", error)
            })
        }
        ManagementCommand::PocketModelStatus { roots } => {
            let status = read_local_model_status(LocalModelKind::Pocket, &roots)?;
            write_management_result(operation, status).map_err(|error| {
                management_failure("output_failed", "Could not write command result", error)
            })
        }
        ManagementCommand::InstallPocketModel { roots } => {
            let result = run_local_model_install(LocalModelKind::Pocket, roots, operation)?;
            write_management_result(operation, result).map_err(|error| {
                management_failure("output_failed", "Could not write command result", error)
            })
        }
        ManagementCommand::ListPocketVoices => {
            write_management_result(operation, pocket_voices_report()).map_err(|error| {
                management_failure("output_failed", "Could not write command result", error)
            })
        }
        ManagementCommand::ParakeetModelStatus { roots } => {
            let status = read_local_model_status(LocalModelKind::Parakeet, &roots)?;
            write_management_result(operation, status).map_err(|error| {
                management_failure("output_failed", "Could not write command result", error)
            })
        }
        ManagementCommand::InstallParakeetModel { roots } => {
            let result = run_local_model_install(LocalModelKind::Parakeet, roots, operation)?;
            write_management_result(operation, result).map_err(|error| {
                management_failure("output_failed", "Could not write command result", error)
            })
        }
    }
}

fn run_session(config: SessionConfig, pcm_output_fd: RawFd) -> Result<(), String> {
    let (control_tx, control_rx) = mpsc::channel();
    let (pcm_tx, pcm_rx) = mpsc::sync_channel(INPUT_QUEUE_CAPACITY);
    thread::spawn(move || read_framed_requests(io::stdin().lock(), control_tx, pcm_tx));
    let audio_transport = Arc::new(unsafe { AudioPipeTransport::from_raw_fd(pcm_output_fd)? });
    let (playback_tx, playback_rx) = mpsc::channel();
    let (audio_control_tx, audio_control_rx) = mpsc::channel();
    let (tts_configuration_tx, tts_configuration_rx) = mpsc::channel::<TtsConfigurationEvent>();
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    let mut core = SessionCore::default();
    let mut initialized = false;
    let mut tts_slot: Option<Arc<ConfiguredTtsSlot>> = None;
    let mut input_during_tts_slot: Option<InputDuringTtsSlot> = None;
    let mut tts_update: Option<ActiveTtsConfigurationUpdate> = None;
    let mut next_tts_update_attempt = 1_u64;
    let mut input_runtime: Option<VoiceInputRuntime> = None;
    let mut input_events: Option<tokio::sync::mpsc::Receiver<VoiceInputEvent>> = None;
    let mut input_controls: Option<VoiceInputControls> = None;
    let mut next_input_token = 1_u64;
    let mut pending_control = None;
    let mut processed_pcm = 0_u64;
    let mut held: Option<PrepareRequest> = None;
    let mut active: Option<ActivePlayback> = None;

    loop {
        if let Some(events) = input_events.as_mut() {
            while let Ok(event) = events.try_recv() {
                handle_voice_input_event(
                    event,
                    &mut core,
                    &mut active,
                    &mut next_input_token,
                    &mut writer,
                )?;
            }
        }
        while let Ok(request) = audio_control_rx.try_recv() {
            write_audio_control_request(request, active.as_ref(), &mut writer)?;
        }
        while let Ok(event) = playback_rx.try_recv() {
            handle_playback_event(event, &mut core, &mut active, &mut writer)?;
        }
        if let Some(output) = active.as_ref().and_then(|current| current.output.as_ref()) {
            if let Err(message) = output.check_suspension_deadline(Instant::now()) {
                if let Some(flag) = active.as_ref().and_then(|current| current.active.as_ref()) {
                    flag.store(false, Ordering::SeqCst);
                    output.notify_cancel_requested();
                }
                let current = active
                    .take()
                    .expect("audio control requires active playback");
                core.finish(current.speech_id);
                write_message(
                    &mut writer,
                    &SessionMessage::SpeechFailed {
                        id: current.prepare_id,
                        speech_id: current.speech_id,
                        message: message.clone(),
                    },
                )?;
                return Err(message);
            }
        }
        poll_tts_configuration_update(
            Instant::now(),
            &tts_configuration_rx,
            tts_slot.as_deref(),
            &mut tts_update,
            &mut writer,
        )?;
        reevaluate_held(
            &mut held,
            &mut core,
            tts_slot.as_deref(),
            input_during_tts_slot.as_ref(),
            &mut active,
            &mut writer,
        )?;
        if active.as_ref().is_some_and(|current| {
            current.active.is_none() && current.ready_deadline <= Instant::now()
        }) {
            let current = active.take().expect("waiting output exists");
            core.finish(current.speech_id);
            write_message(
                &mut writer,
                &SessionMessage::SpeechFailed {
                    id: current.prepare_id,
                    speech_id: current.speech_id,
                    message: "output readiness timed out".into(),
                },
            )?;
        }

        let Some(input) = receive_session_input(
            &control_rx,
            &pcm_rx,
            &mut pending_control,
            &mut processed_pcm,
        ) else {
            continue;
        };
        match input {
            Input::Invalid(message) => {
                write_protocol_fatal(&mut writer, "invalid session input", &message)?;
                abort_active(&active);
                if let Some(runtime) = input_runtime.as_ref() {
                    runtime.cancel();
                }
                return Ok(());
            }
            Input::Eof => {
                if let Some(current) = active.as_mut() {
                    if let Some(flag) = &current.active {
                        flag.store(false, Ordering::SeqCst);
                    }
                }
                if let Some(runtime) = input_runtime.as_ref() {
                    runtime.cancel();
                }
                return Ok(());
            }
            Input::Pcm(frame) if !initialized => {
                let _ = frame;
                write_message(
                    &mut writer,
                    &SessionMessage::Fatal {
                        message: "PCM input requires an initialized session".into(),
                    },
                )?;
                if let Some(runtime) = input_runtime.as_ref() {
                    runtime.cancel();
                }
                return Ok(());
            }
            Input::Pcm(frame) => {
                if let Err(message) = input_runtime
                    .as_ref()
                    .expect("hello initializes input before PCM")
                    .try_push_frame(*frame)
                {
                    write_protocol_fatal(&mut writer, "voice input frame was rejected", &message)?;
                    input_runtime
                        .as_ref()
                        .expect("hello initialized input runtime")
                        .cancel();
                    return Ok(());
                }
            }
            Input::Request(SessionRequest::Shutdown) => {
                reject_tts_configuration_update(
                    &mut tts_update,
                    tts_slot.as_deref(),
                    "session is shutting down",
                    &mut writer,
                )?;
                if let Some(held) = held.take() {
                    write_message(
                        &mut writer,
                        &SessionMessage::NotAdmitted {
                            id: held.id,
                            reason: NotAdmittedReason::Cancelled,
                        },
                    )?;
                }
                interrupt_active(&mut core, &mut active, &mut writer)?;
                finish_shutdown_playback(
                    &playback_rx,
                    &mut core,
                    &mut active,
                    &mut writer,
                    SHUTDOWN_PLAYBACK_TIMEOUT,
                )?;
                if let (Some(runtime), Some(events)) = (input_runtime.take(), input_events.as_mut())
                {
                    finish_input_runtime(
                        runtime,
                        events,
                        &mut core,
                        &mut active,
                        &mut next_input_token,
                        &mut writer,
                    )?;
                }
                return Ok(());
            }
            Input::Request(SessionRequest::Hello {
                id,
                input_during_tts,
            }) => {
                if initialized {
                    write_message(
                        &mut writer,
                        &SessionMessage::Fatal {
                            message: "hello may only be sent once".into(),
                        },
                    )?;
                    abort_active(&active);
                    return Ok(());
                }
                let slot = match create_tts_slot(&config.tts) {
                    Ok(slot) => Arc::new(slot),
                    Err(message) => {
                        write_protocol_fatal(
                            &mut writer,
                            &public_tts_startup_error(&config.tts),
                            &format!("TTS startup failed: {message}"),
                        )?;
                        return Ok(());
                    }
                };
                let (runtime, mut events) = match create_input_runtime(&config.stt) {
                    Ok(runtime) => runtime,
                    Err(message) => {
                        write_protocol_fatal(
                            &mut writer,
                            &public_stt_startup_error(&config.stt),
                            &format!("STT startup failed: {message}"),
                        )?;
                        return Ok(());
                    }
                };
                let readiness = wait_for_input_ready(&mut events, INPUT_STARTUP_TIMEOUT);
                if let Err(message) = readiness {
                    runtime.cancel();
                    let write_result = write_protocol_fatal(
                        &mut writer,
                        &public_stt_startup_error(&config.stt),
                        &format!("STT readiness failed: {message}"),
                    );
                    let finish_result = finish_unready_input_runtime(runtime);
                    write_result?;
                    finish_result?;
                    return Ok(());
                }
                input_controls = Some(runtime.controls());
                input_runtime = Some(runtime);
                input_events = Some(events);
                initialized = true;
                let input_policy = InputDuringTtsSlot::new(input_during_tts);
                let session = VoiceSessionSnapshot {
                    tts: slot.snapshot()?,
                    input_during_tts: input_policy.snapshot()?,
                };
                tts_slot = Some(slot);
                input_during_tts_slot = Some(input_policy);
                write_message(
                    &mut writer,
                    &SessionMessage::Ready {
                        id,
                        protocol: WIRE_MARKER,
                        session,
                    },
                )?;
            }
            Input::Request(request) if !initialized => {
                let _ = request;
                write_message(
                    &mut writer,
                    &SessionMessage::Fatal {
                        message: "hello must be the first request".into(),
                    },
                )?;
                return Ok(());
            }
            Input::Request(SessionRequest::SetInputMuted { id, active: muted }) => {
                handle_input_muted(
                    id,
                    muted,
                    input_controls
                        .as_ref()
                        .expect("hello initialized input controls"),
                    &mut core,
                    &mut active,
                    &mut writer,
                )?;
            }
            Input::Request(SessionRequest::SetTtsSettings {
                id,
                expected_revision,
                settings,
            }) => {
                let slot = Arc::clone(tts_slot.as_ref().expect("hello initialized TTS"));
                if tts_update.is_some() {
                    write_message(
                        &mut writer,
                        &SessionMessage::TtsSettingsResult {
                            id,
                            outcome: TtsSettingsOutcome::Rejected,
                            snapshot: slot.snapshot()?,
                            message: Some("another TTS configuration update is in progress".into()),
                        },
                    )?;
                } else {
                    let attempt = next_tts_update_attempt;
                    next_tts_update_attempt =
                        next_tts_update_attempt.checked_add(1).ok_or_else(|| {
                            "TTS configuration attempt space is exhausted".to_string()
                        })?;
                    tts_update = Some(ActiveTtsConfigurationUpdate {
                        attempt,
                        id,
                        deadline: Instant::now() + TTS_CONFIGURATION_TIMEOUT,
                    });
                    let sender = tts_configuration_tx.clone();
                    thread::spawn(move || {
                        let result = slot.prepare_replacement(expected_revision, settings);
                        let _ = sender.send(TtsConfigurationEvent {
                            attempt,
                            id,
                            result,
                        });
                    });
                }
            }
            Input::Request(SessionRequest::SetInputDuringTts {
                id,
                expected_revision,
                policy,
            }) => {
                let slot = input_during_tts_slot
                    .as_ref()
                    .expect("hello initialized input-during-TTS policy");
                let (outcome, snapshot) = match slot.update(expected_revision, policy) {
                    Ok(snapshot) => (InputDuringTtsOutcome::Applied, snapshot),
                    Err(snapshot) => (InputDuringTtsOutcome::Rejected, snapshot),
                };
                write_message(
                    &mut writer,
                    &SessionMessage::InputDuringTtsResult {
                        id,
                        outcome,
                        snapshot,
                    },
                )?;
            }
            Input::Request(SessionRequest::ResetInput { id }) => {
                handle_reset_input(
                    id,
                    input_controls
                        .as_ref()
                        .expect("hello initialized input controls"),
                    &mut core,
                    &mut active,
                    &mut writer,
                )?;
            }
            Input::Request(SessionRequest::SetPaused { active: paused }) => {
                if core.set_paused(paused) {
                    interrupt_active(&mut core, &mut active, &mut writer)?;
                }
            }
            Input::Request(SessionRequest::PrepareSpeak {
                id,
                acknowledgement,
                text,
            }) => {
                let request = PrepareRequest {
                    id,
                    acknowledgement,
                    text,
                };
                if held.is_some() {
                    write_message(
                        &mut writer,
                        &SessionMessage::NotAdmitted {
                            id,
                            reason: NotAdmittedReason::InProgress,
                        },
                    )?;
                } else {
                    process_prepare(
                        request,
                        &mut core,
                        tts_slot.as_deref().expect("hello initialized TTS"),
                        input_during_tts_slot
                            .as_ref()
                            .expect("hello initialized input-during-TTS policy"),
                        &mut active,
                        &mut held,
                        &mut writer,
                    )?;
                }
            }
            Input::Request(SessionRequest::OutputReady { id, speech_id }) => {
                if let Some(current) = active.as_mut().filter(|current| {
                    current.prepare_id == id
                        && current.speech_id == speech_id
                        && current.active.is_none()
                }) {
                    acknowledge_output_ready(current, input_controls.as_ref(), &mut writer)?;
                    let playback_active = Arc::new(AtomicBool::new(true));
                    let output = Arc::new(RemotePcmAudioOutput::new(
                        speech_id,
                        current.tts.backend().pcm_spec(),
                        Arc::clone(&audio_transport),
                        Arc::clone(&playback_active),
                        audio_control_tx.clone(),
                    )?);
                    if current.suspension_requested {
                        output.request_suspend()?;
                    }
                    current.output = Some(Arc::clone(&output));
                    current.active = Some(Arc::clone(&playback_active));
                    spawn_playback(
                        speech_id,
                        current.text.clone(),
                        Arc::clone(current.tts.backend()),
                        output,
                        playback_active,
                        playback_tx.clone(),
                    );
                } else {
                    write_message(
                        &mut writer,
                        &SessionMessage::OutputReadyResult {
                            id,
                            speech_id,
                            outcome: OutputReadyOutcome::Stale,
                        },
                    )?;
                }
            }
            Input::Request(SessionRequest::AudioBeginAccepted { speech_id }) => {
                if let Err(message) =
                    handle_audio_ack(speech_id, AudioHostAck::BeginAccepted, active.as_ref())
                {
                    write_protocol_fatal(
                        &mut writer,
                        "invalid host audio acknowledgement",
                        &message,
                    )?;
                    abort_active(&active);
                    return Ok(());
                }
            }
            Input::Request(SessionRequest::AudioBeginFailed {
                speech_id,
                played_frames,
                message,
            }) => {
                eprintln!("host audio begin failed: {message}");
                if let Err(message) = handle_audio_ack(
                    speech_id,
                    AudioHostAck::BeginFailed {
                        played_frames,
                        message,
                    },
                    active.as_ref(),
                ) {
                    write_protocol_fatal(
                        &mut writer,
                        "invalid host audio acknowledgement",
                        &message,
                    )?;
                    abort_active(&active);
                    return Ok(());
                }
            }
            Input::Request(SessionRequest::AudioChunkAccepted {
                speech_id,
                sequence,
            }) => {
                match handle_audio_ack(
                    speech_id,
                    AudioHostAck::ChunkAccepted { sequence },
                    active.as_ref(),
                ) {
                    Ok(true) => {
                        publish_speech_started(speech_id, &mut core, active.as_ref(), &mut writer)?
                    }
                    Ok(false) => {}
                    Err(message) => {
                        write_protocol_fatal(
                            &mut writer,
                            "invalid host audio acknowledgement",
                            &message,
                        )?;
                        abort_active(&active);
                        return Ok(());
                    }
                }
            }
            Input::Request(SessionRequest::AudioPlayed {
                speech_id,
                played_frames,
            }) => {
                if let Err(message) = handle_audio_ack(
                    speech_id,
                    AudioHostAck::Played { played_frames },
                    active.as_ref(),
                ) {
                    write_protocol_fatal(
                        &mut writer,
                        "invalid host audio acknowledgement",
                        &message,
                    )?;
                    abort_active(&active);
                    return Ok(());
                }
            }
            Input::Request(SessionRequest::AudioSuspended {
                speech_id,
                played_frames,
            }) => {
                if let Err(message) = handle_audio_ack(
                    speech_id,
                    AudioHostAck::Suspended { played_frames },
                    active.as_ref(),
                ) {
                    write_protocol_fatal(
                        &mut writer,
                        "invalid host audio acknowledgement",
                        &message,
                    )?;
                    abort_active(&active);
                    return Ok(());
                }
            }
            Input::Request(SessionRequest::AudioResumed {
                speech_id,
                played_frames,
            }) => {
                if let Err(message) = handle_audio_ack(
                    speech_id,
                    AudioHostAck::Resumed { played_frames },
                    active.as_ref(),
                ) {
                    write_protocol_fatal(
                        &mut writer,
                        "invalid host audio acknowledgement",
                        &message,
                    )?;
                    abort_active(&active);
                    return Ok(());
                }
            }
            Input::Request(SessionRequest::AudioDrained {
                speech_id,
                sequence,
                played_frames,
            }) => {
                if let Err(message) = handle_audio_ack(
                    speech_id,
                    AudioHostAck::Drained {
                        sequence,
                        played_frames,
                    },
                    active.as_ref(),
                ) {
                    write_protocol_fatal(
                        &mut writer,
                        "invalid host audio acknowledgement",
                        &message,
                    )?;
                    abort_active(&active);
                    return Ok(());
                }
            }
            Input::Request(SessionRequest::AudioFailed {
                speech_id,
                played_frames,
                message,
            }) => {
                eprintln!("host audio output failed: {message}");
                if let Err(message) = handle_audio_ack(
                    speech_id,
                    AudioHostAck::Failed {
                        played_frames,
                        message,
                    },
                    active.as_ref(),
                ) {
                    write_protocol_fatal(
                        &mut writer,
                        "invalid host audio acknowledgement",
                        &message,
                    )?;
                    abort_active(&active);
                    return Ok(());
                }
            }
            Input::Request(SessionRequest::AudioCancelled {
                speech_id,
                played_frames,
            }) => {
                if let Err(message) = handle_audio_ack(
                    speech_id,
                    AudioHostAck::Cancelled { played_frames },
                    active.as_ref(),
                ) {
                    write_protocol_fatal(
                        &mut writer,
                        "invalid host audio acknowledgement",
                        &message,
                    )?;
                    abort_active(&active);
                    return Ok(());
                }
            }
            Input::Request(SessionRequest::QueryState { id, after }) => {
                write_state(&mut writer, id, after, &core)?
            }
            Input::Request(SessionRequest::Cancel { id }) => {
                handle_cancel(id, &mut held, &mut core, &mut active, &mut writer)?;
            }
        }
    }
}

fn acknowledge_output_ready(
    current: &mut ActivePlayback,
    input_controls: Option<&VoiceInputControls>,
    writer: &mut impl Write,
) -> Result<(), String> {
    current.assistant_activity = input_controls.map(|controls| {
        controls
            .begin_assistant_activity(0.65, current.input_during_tts.policy)
            .expect("balanced assistant threshold is valid")
    });
    write_message(
        writer,
        &SessionMessage::OutputReadyResult {
            id: current.prepare_id,
            speech_id: current.speech_id,
            outcome: OutputReadyOutcome::Accepted,
        },
    )
}

fn handle_audio_ack(
    speech_id: u64,
    ack: AudioHostAck,
    active: Option<&ActivePlayback>,
) -> Result<bool, String> {
    let current = active
        .filter(|current| current.speech_id == speech_id)
        .ok_or_else(|| "audio acknowledgement does not target the active speech".to_string())?;
    current
        .output
        .as_ref()
        .ok_or_else(|| "audio acknowledgement arrived before remote output began".to_string())?
        .handle_ack(ack)
}

fn write_audio_control_request(
    request: AudioOutputControlRequest,
    active: Option<&ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    let (speech_id, message) = match request {
        AudioOutputControlRequest::Suspend { speech_id } => {
            (speech_id, SessionMessage::AudioSuspend { speech_id })
        }
        AudioOutputControlRequest::Resume { speech_id } => {
            (speech_id, SessionMessage::AudioResume { speech_id })
        }
    };
    if active.is_none_or(|current| current.speech_id != speech_id) {
        return Err("audio control request does not target the active speech".into());
    }
    if !active
        .and_then(|current| current.output.as_ref())
        .is_some_and(|output| output.control_request_is_outstanding(request))
    {
        return Ok(());
    }
    write_message(writer, &message)
}

fn wait_for_input_ready(
    events: &mut tokio::sync::mpsc::Receiver<VoiceInputEvent>,
    timeout: Duration,
) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|error| format!("initialize voice input readiness wait: {error}"))?;
    match runtime.block_on(async { tokio::time::timeout(timeout, events.recv()).await }) {
        Ok(Some(VoiceInputEvent::Ready)) => Ok(()),
        Ok(Some(VoiceInputEvent::Failed(message))) => Err(message),
        Ok(Some(_)) => Err("voice input emitted data before readiness".into()),
        Ok(None) => Err("voice input stopped before readiness".into()),
        Err(_) => Err("voice input readiness timed out".into()),
    }
}

fn finish_unready_input_runtime(runtime: VoiceInputRuntime) -> Result<(), String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|error| format!("initialize voice input startup cleanup: {error}"))?
        .block_on(runtime.finish())
        .map_err(|error| format!("finish unready voice input runtime: {error}"))
}

fn parse_args(args: &[String]) -> Result<SessionConfig, String> {
    if args.get(1).map(String::as_str) != Some("session") {
        return Err("the only supported command is session".into());
    }
    let mut backend = "siri";
    let mut voice = None;
    let mut language = None;
    let mut model_dir = None;
    let mut rate = None;
    let mut stt_backend = "macos";
    let mut stt_model_dir = None;
    let mut index = 2;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("{flag} requires a value"))?;
        match flag {
            "--tts-backend" => backend = value,
            "--voice" => voice = Some(value.clone()),
            "--language" => language = Some(value.clone()),
            "--model-dir" => model_dir = Some(PathBuf::from(value)),
            "--rate" => {
                rate = Some(
                    value
                        .parse::<f32>()
                        .map_err(|_| "--rate must be a number".to_string())?,
                )
            }
            "--stt-backend" => stt_backend = value,
            "--stt-model-dir" => stt_model_dir = Some(PathBuf::from(value)),
            "--pcm-output-fd" => {}
            _ => return Err(format!("unknown argument: {flag}")),
        }
        index += 2;
    }
    let tts = build_tts_backend_config(backend, voice, language, model_dir, rate)?;
    let stt = build_stt_backend_config(stt_backend, stt_model_dir)?;
    Ok(SessionConfig { tts, stt })
}

fn parse_pcm_output_fd(args: &[String]) -> Result<RawFd, String> {
    let mut value = None;
    let mut index = 2;
    while index < args.len() {
        if args[index] == "--pcm-output-fd" {
            if value.is_some() {
                return Err("--pcm-output-fd may be provided only once".into());
            }
            value = args.get(index + 1).cloned();
        }
        index += 2;
    }
    let fd = value
        .ok_or("--pcm-output-fd is required")?
        .parse::<RawFd>()
        .map_err(|_| "--pcm-output-fd must be an integer file descriptor".to_string())?;
    if fd < 3 {
        return Err("--pcm-output-fd must be at least 3".into());
    }
    Ok(fd)
}

fn parse_synthesis_args(args: &[String]) -> Result<SynthesisConfig, String> {
    if args.get(1).map(String::as_str) != Some("synthesize") {
        return Err("expected synthesize".into());
    }
    let mut backend = None;
    let mut model = None;
    let mut voice = None;
    let mut language = None;
    let mut model_dir = None;
    let mut rate = None;
    let mut text = None;
    let mut output = None;
    let mut allow_paid_openai = false;
    let mut index = 2;
    while index < args.len() {
        let flag = args[index].as_str();
        if flag == "--allow-paid-openai" {
            if allow_paid_openai {
                return Err("--allow-paid-openai may be provided only once".into());
            }
            allow_paid_openai = true;
            index += 1;
            continue;
        }
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("{flag} requires a value"))?;
        let destination = match flag {
            "--tts-backend" => &mut backend,
            "--model" => &mut model,
            "--voice" => &mut voice,
            "--language" => &mut language,
            "--model-dir" => &mut model_dir,
            "--text" => &mut text,
            "--output" => &mut output,
            "--rate" => {
                if rate.is_some() {
                    return Err("--rate may be provided only once".into());
                }
                rate = Some(
                    value
                        .parse::<f32>()
                        .map_err(|_| "--rate must be a number".to_string())?,
                );
                index += 2;
                continue;
            }
            _ => return Err(format!("unknown synthesize argument: {flag}")),
        };
        if destination.is_some() {
            return Err(format!("{flag} may be provided only once"));
        }
        *destination = Some(value.clone());
        index += 2;
    }

    let backend = backend.ok_or_else(|| "--tts-backend is required".to_string())?;
    let text = text.ok_or_else(|| "--text is required".to_string())?;
    if text.trim().is_empty() {
        return Err("--text must be nonempty".into());
    }
    if text.len() > MAX_SPEAK_TEXT_BYTES {
        return Err(format!("--text exceeds {MAX_SPEAK_TEXT_BYTES} UTF-8 bytes"));
    }
    let output = PathBuf::from(output.ok_or_else(|| "--output is required".to_string())?);
    if output.as_os_str().is_empty() || output == Path::new("-") {
        return Err("--output must name a WAV file; stdout is not supported".into());
    }

    let tts = match backend.as_str() {
        "openai" => {
            if language.is_some() || model_dir.is_some() {
                return Err("--language and --model-dir are not valid with OpenAI".into());
            }
            if !allow_paid_openai {
                return Err(
                    "OpenAI synthesis requires explicit --allow-paid-openai consent".into(),
                );
            }
            let model = model
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "--model is required with OpenAI".to_string())?;
            let voice = voice
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "--voice is required with OpenAI".to_string())?;
            let rate = rate.unwrap_or(1.0);
            if !rate.is_finite() || !(0.75..=2.0).contains(&rate) {
                return Err("--rate must be between 0.75 and 2.0 for OpenAI".into());
            }
            SynthesisTtsConfig::OpenAi { model, voice, rate }
        }
        "siri" | "pocket" => {
            if model.is_some() {
                return Err("--model is only valid with OpenAI".into());
            }
            if allow_paid_openai {
                return Err("--allow-paid-openai is only valid with OpenAI".into());
            }
            let mut local = build_tts_backend_config(
                &backend,
                voice,
                language,
                model_dir.map(PathBuf::from),
                rate,
            )?;
            if let TtsBackendConfig::Siri {
                voice, language, ..
            } = &mut local
            {
                let identity = berd_voice::siri::SiriVoiceIdentity::new(voice.clone(), language)?;
                *voice = identity.name().to_string();
                *language = identity.language().to_string();
            }
            if matches!(local, TtsBackendConfig::Pocket { rate, .. } if rate != 1.0) {
                return Err("Pocket WAV synthesis supports only --rate 1.0".into());
            }
            SynthesisTtsConfig::Local(local)
        }
        value => return Err(format!("unsupported TTS backend: {value}")),
    };
    Ok(SynthesisConfig { tts, text, output })
}

fn build_stt_backend_config(
    stt_backend: &str,
    stt_model_dir: Option<PathBuf>,
) -> Result<SttBackendConfig, String> {
    match stt_backend {
        "macos" => {
            if stt_model_dir.is_some() {
                return Err("--stt-model-dir is only valid with Parakeet STT".into());
            }
            Ok(SttBackendConfig::Macos)
        }
        "parakeet" => {
            let model_dir = stt_model_dir
                .filter(|path| !path.as_os_str().is_empty())
                .ok_or_else(|| "--stt-model-dir is required with Parakeet STT".to_string())?;
            if !model_dir.is_absolute() {
                return Err("--stt-model-dir must be an absolute path".into());
            }
            Ok(SttBackendConfig::Parakeet { model_dir })
        }
        "openai" => {
            if stt_model_dir.is_some() {
                return Err("--stt-model-dir is only valid with Parakeet STT".into());
            }
            Ok(SttBackendConfig::OpenAi)
        }
        value => Err(format!("unsupported STT backend: {value}")),
    }
}

fn build_tts_backend_config(
    backend: &str,
    voice: Option<String>,
    language: Option<String>,
    model_dir: Option<PathBuf>,
    rate: Option<f32>,
) -> Result<TtsBackendConfig, String> {
    match backend {
        "openai" => {
            if voice.is_some() || language.is_some() || model_dir.is_some() {
                return Err(
                    "--voice, --language, and --model-dir require a non-OpenAI backend".into(),
                );
            }
            let rate = rate.unwrap_or(1.0);
            if !rate.is_finite() || !(0.75..=2.0).contains(&rate) {
                return Err("--rate must be between 0.75 and 2.0 for OpenAI".into());
            }
            Ok(TtsBackendConfig::OpenAi { rate })
        }
        "siri" => {
            if model_dir.is_some() {
                return Err("--model-dir is only valid with Pocket".into());
            }
            let voice = voice
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "Siri TTS is the default; select an installed voice with --voice NAME and --language BCP47"
                        .to_string()
                })?;
            let language = language
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "Siri TTS is the default; select an installed voice with --voice NAME and --language BCP47"
                        .to_string()
                })?;
            let rate = rate.unwrap_or(1.0);
            if !rate.is_finite() || !(0.5..=2.0).contains(&rate) {
                return Err("--rate must be between 0.5 and 2.0".into());
            }
            Ok(TtsBackendConfig::Siri {
                voice,
                language,
                rate,
            })
        }
        "pocket" => {
            if language.is_some() {
                return Err("--language is only valid with Siri".into());
            }
            let model_dir = model_dir
                .filter(|value| !value.as_os_str().is_empty())
                .ok_or_else(|| "--model-dir is required with Pocket".to_string())?;
            if !model_dir.is_absolute() {
                return Err("--model-dir must be an absolute path".into());
            }
            let voice = voice
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "--voice is required with Pocket".to_string())?;
            let rate = rate.unwrap_or(1.0);
            if !rate.is_finite() || !(0.75..=2.0).contains(&rate) {
                return Err("--rate must be between 0.75 and 2.0 for Pocket".into());
            }
            Ok(TtsBackendConfig::Pocket {
                model_dir,
                voice,
                rate,
            })
        }
        value => Err(format!("unsupported TTS backend: {value}")),
    }
}

fn parse_tts_benchmark_args(args: &[String]) -> Result<TtsBenchmarkConfig, String> {
    if args.get(1).map(String::as_str) != Some("benchmark")
        || args.get(2).map(String::as_str) != Some("tts")
    {
        return Err("expected benchmark tts".into());
    }
    let mut backend = None;
    let mut voice = None;
    let mut language = None;
    let mut model_dir = None;
    let mut rate = None;
    let mut text = None;
    let mut prompt_manifest = None;
    let mut runs = None;
    let mut mode = None;
    let mut allow_paid_openai = false;
    let mut index = 3;
    while index < args.len() {
        let flag = args[index].as_str();
        if flag == "--allow-paid-openai" {
            allow_paid_openai = true;
            index += 1;
            continue;
        }
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("{flag} requires a value"))?;
        match flag {
            "--tts-backend" => backend = Some(value.as_str()),
            "--voice" => voice = Some(value.clone()),
            "--language" => language = Some(value.clone()),
            "--model-dir" => model_dir = Some(PathBuf::from(value)),
            "--rate" => {
                rate = Some(
                    value
                        .parse::<f32>()
                        .map_err(|_| "--rate must be a number".to_string())?,
                )
            }
            "--text" => text = Some(value.clone()),
            "--prompt-manifest" => prompt_manifest = Some(value.clone()),
            "--runs" => {
                let parsed = value
                    .parse::<usize>()
                    .map_err(|_| "--runs must be a positive integer".to_string())?;
                if !(1..=100).contains(&parsed) {
                    return Err("--runs must be between 1 and 100".into());
                }
                runs = Some(parsed);
            }
            "--mode" => {
                mode = Some(match value.as_str() {
                    "fresh-backend" => TtsBenchmarkMode::FreshBackend,
                    "warm" => TtsBenchmarkMode::Warm,
                    _ => return Err("--mode must be fresh-backend or warm".into()),
                })
            }
            _ => return Err(format!("unknown argument: {flag}")),
        }
        index += 2;
    }
    let mode = mode.ok_or_else(|| "--mode is required".to_string())?;
    let prompts = match (text, prompt_manifest, runs) {
        (Some(text), None, Some(runs)) => {
            if text.trim().is_empty() {
                return Err("--text must be nonempty".into());
            }
            if text.len() > MAX_SPEAK_TEXT_BYTES {
                return Err(format!("--text exceeds {MAX_SPEAK_TEXT_BYTES} UTF-8 bytes"));
            }
            TtsBenchmarkPrompts::ExactRepeat { text, runs }
        }
        (None, Some(id), None) => {
            TtsBenchmarkPrompts::Manifest(load_bundled_tts_prompt_manifest(&id)?)
        }
        (Some(_), Some(_), _) => {
            return Err("--text and --prompt-manifest are mutually exclusive".into())
        }
        (None, Some(_), Some(_)) => {
            return Err("--runs is fixed by --prompt-manifest and must be omitted".into())
        }
        (Some(_), None, None) => return Err("--runs is required with --text".into()),
        (None, None, _) => return Err("either --text or --prompt-manifest is required".into()),
    };
    let tts = build_tts_backend_config(
        backend.ok_or_else(|| "--tts-backend is required".to_string())?,
        voice,
        language,
        model_dir,
        rate,
    )?;
    if let (TtsBackendConfig::Siri { language, .. }, TtsBenchmarkPrompts::Manifest(manifest)) =
        (&tts, &prompts)
    {
        if language != &manifest.language {
            return Err(format!(
                "TTS prompt manifest {} requires Siri language {}",
                manifest.id, manifest.language
            ));
        }
    }
    let (request_count, total_text_bytes) = match &prompts {
        TtsBenchmarkPrompts::ExactRepeat { text, runs } => {
            let requests = runs.saturating_add(usize::from(mode == TtsBenchmarkMode::Warm));
            let bytes = text
                .len()
                .checked_mul(requests)
                .ok_or_else(|| "TTS benchmark workload is too large".to_string())?;
            (requests, bytes)
        }
        TtsBenchmarkPrompts::Manifest(manifest) => {
            let requests = manifest.prompts.len() + usize::from(mode == TtsBenchmarkMode::Warm);
            let measured_bytes = manifest.prompts.iter().try_fold(0_usize, |total, prompt| {
                total.checked_add(prompt.text.len())
            });
            let bytes = measured_bytes
                .and_then(|total| {
                    total.checked_add(if mode == TtsBenchmarkMode::Warm {
                        manifest.warmup.text.len()
                    } else {
                        0
                    })
                })
                .ok_or_else(|| "TTS benchmark workload is too large".to_string())?;
            (requests, bytes)
        }
    };
    if matches!(tts, TtsBackendConfig::OpenAi { .. }) {
        if !allow_paid_openai {
            return Err("OpenAI benchmarks require explicit --allow-paid-openai consent".into());
        }
        if request_count > MAX_OPENAI_BENCHMARK_REQUESTS {
            return Err(format!(
                "OpenAI benchmark would make {request_count} requests; maximum is {MAX_OPENAI_BENCHMARK_REQUESTS}"
            ));
        }
        if total_text_bytes > MAX_OPENAI_BENCHMARK_TEXT_BYTES {
            return Err(format!(
                "OpenAI benchmark would submit {total_text_bytes} total UTF-8 text bytes; maximum is {MAX_OPENAI_BENCHMARK_TEXT_BYTES}"
            ));
        }
    } else if allow_paid_openai {
        return Err("--allow-paid-openai is only valid with OpenAI".into());
    }
    Ok(TtsBenchmarkConfig { tts, prompts, mode })
}

fn run_tts_benchmark(config: TtsBenchmarkConfig) -> Result<(), String> {
    let target = tts_benchmark_target(&config.tts, std::env::var_os("OPENAI_BASE_URL").is_some());
    let report = match &config.prompts {
        TtsBenchmarkPrompts::ExactRepeat { text, runs } => {
            benchmark_tts(target, text, *runs, config.mode, || {
                create_tts_backend(&config.tts)
            })
        }
        TtsBenchmarkPrompts::Manifest(manifest) => {
            benchmark_tts_manifest(target, manifest, config.mode, || {
                create_tts_backend(&config.tts)
            })
        }
    };
    let succeeded = report.succeeded();
    serde_json::to_writer(io::stdout().lock(), &report).map_err(|error| error.to_string())?;
    println!();
    if succeeded {
        Ok(())
    } else {
        Err("one or more benchmark runs failed; see JSON output".into())
    }
}

fn tts_benchmark_target(
    config: &TtsBackendConfig,
    openai_endpoint_from_environment: bool,
) -> TtsBenchmarkTarget {
    match config {
        TtsBackendConfig::OpenAi { rate, .. } => TtsBenchmarkTarget {
            backend: "openai".into(),
            model: Some(
                std::env::var("OPENAI_TTS_MODEL").unwrap_or_else(|_| "gpt-4o-mini-tts".into()),
            ),
            voice: Some(std::env::var("OPENAI_TTS_VOICE").unwrap_or_else(|_| "marin".into())),
            language: None,
            rate: Some(*rate),
            endpoint_source: Some(
                if openai_endpoint_from_environment {
                    "OPENAI_BASE_URL_environment"
                } else {
                    "built_in_default"
                }
                .into(),
            ),
        },
        TtsBackendConfig::Siri {
            voice,
            language,
            rate,
        } => TtsBenchmarkTarget {
            backend: "siri".into(),
            model: None,
            voice: Some(voice.clone()),
            language: Some(language.clone()),
            rate: Some(*rate),
            endpoint_source: None,
        },
        TtsBackendConfig::Pocket {
            model_dir,
            voice,
            rate,
        } => TtsBenchmarkTarget {
            backend: "pocket".into(),
            model: model_dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            voice: Some(voice.clone()),
            language: None,
            rate: Some(*rate),
            endpoint_source: None,
        },
    }
}

fn parse_stt_benchmark_args(args: &[String]) -> Result<SttBenchmarkConfig, String> {
    if args.get(1).map(String::as_str) != Some("benchmark")
        || args.get(2).map(String::as_str) != Some("stt")
    {
        return Err("expected benchmark stt".into());
    }
    let mut backend = None;
    let mut model_dir = None;
    let mut runs = None;
    let mut mode = None;
    let mut allow_paid_openai = false;
    let mut index = 3;
    while index < args.len() {
        let flag = args[index].as_str();
        if flag == "--allow-paid-openai" {
            allow_paid_openai = true;
            index += 1;
            continue;
        }
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("{flag} requires a value"))?;
        match flag {
            "--stt-backend" => backend = Some(value.as_str()),
            "--stt-model-dir" => model_dir = Some(PathBuf::from(value)),
            "--runs" => {
                let parsed = value
                    .parse::<usize>()
                    .map_err(|_| "--runs must be a positive integer".to_string())?;
                if !(1..=100).contains(&parsed) {
                    return Err("--runs must be between 1 and 100".into());
                }
                runs = Some(parsed);
            }
            "--mode" => {
                mode = Some(match value.as_str() {
                    "cold" => SttBenchmarkMode::Cold,
                    "warm" => SttBenchmarkMode::Warm,
                    _ => return Err("--mode must be cold or warm".into()),
                })
            }
            _ => return Err(format!("unknown argument: {flag}")),
        }
        index += 2;
    }
    let stt = build_stt_backend_config(
        backend.ok_or_else(|| "--stt-backend is required".to_string())?,
        model_dir,
    )?;
    let runs = runs.ok_or_else(|| "--runs is required".to_string())?;
    let mode = mode.ok_or_else(|| "--mode is required".to_string())?;
    if matches!(stt, SttBackendConfig::OpenAi) && !allow_paid_openai {
        return Err("OpenAI benchmarks require explicit --allow-paid-openai consent".into());
    }
    if !matches!(stt, SttBackendConfig::OpenAi) && allow_paid_openai {
        return Err("--allow-paid-openai is only valid with OpenAI".into());
    }
    Ok(SttBenchmarkConfig {
        stt,
        runs,
        mode,
        allow_paid_openai,
    })
}

fn validate_stt_benchmark_workload(
    config: &SttBenchmarkConfig,
    workload: &berd_voice::benchmark::SttBenchmarkWorkload,
) -> Result<(), String> {
    if !matches!(config.stt, SttBackendConfig::OpenAi) {
        return Ok(());
    }
    debug_assert!(config.allow_paid_openai);
    if workload.recognition_commits > MAX_OPENAI_BENCHMARK_REQUESTS {
        return Err(format!(
            "OpenAI benchmark would make {} recognition commits; maximum is {MAX_OPENAI_BENCHMARK_REQUESTS}",
            workload.recognition_commits
        ));
    }
    if workload.streamed_audio_seconds > MAX_OPENAI_STT_BENCHMARK_SECONDS {
        return Err(format!(
            "OpenAI benchmark would stream {:.2} seconds of audio; maximum is {MAX_OPENAI_STT_BENCHMARK_SECONDS:.0}",
            workload.streamed_audio_seconds
        ));
    }
    Ok(())
}

fn run_stt_benchmark(config: SttBenchmarkConfig) -> Result<(), String> {
    let report = create_stt_benchmark_report(&config)?;
    let succeeded = report.succeeded();
    serde_json::to_writer(io::stdout().lock(), &report).map_err(|error| error.to_string())?;
    println!();
    if succeeded {
        Ok(())
    } else {
        Err("one or more benchmark runs failed; see JSON output".into())
    }
}

fn create_stt_benchmark_report(
    config: &SttBenchmarkConfig,
) -> Result<berd_voice::benchmark::SttBenchmarkReport, String> {
    let pack = load_bundled_stt_fixture_pack()?;
    let workload = pack.workload(config.runs, config.mode);
    validate_stt_benchmark_workload(config, &workload)?;
    let target = stt_benchmark_target(&config.stt)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("initialize STT benchmark runtime: {error}"))?;
    Ok(runtime.block_on(benchmark_stt(
        target,
        SttBenchmarkEnvironment::default(),
        &pack,
        config.runs,
        config.mode,
        || create_input_runtime(&config.stt),
    )))
}

fn stt_benchmark_target(config: &SttBackendConfig) -> Result<SttBenchmarkTarget, String> {
    match config {
        SttBackendConfig::Parakeet { model_dir } => Ok(SttBenchmarkTarget {
            backend: "parakeet".into(),
            model: model_dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            locale: None,
            vad_threshold: 0.5,
            endpoint_source: None,
            model_source: Some("explicit --stt-model-dir".into()),
            credential_source: None,
        }),
        SttBackendConfig::Macos => {
            #[cfg(target_os = "macos")]
            {
                let status = berd_voice::mac_speech::mac_speech_status()?;
                Ok(SttBenchmarkTarget {
                    backend: "macos".into(),
                    model: Some(status.model_status),
                    locale: status.locale,
                    vad_threshold: 0.5,
                    endpoint_source: None,
                    model_source: Some("installed current-locale model".into()),
                    credential_source: None,
                })
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("macOS speech recognition is only available on macOS".into())
            }
        }
        SttBackendConfig::OpenAi => {
            let (model, model_source) = if let Some(model) =
                std::env::var("OPENAI_TRANSCRIPTION_MODEL")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            {
                (model, "OPENAI_TRANSCRIPTION_MODEL environment variable")
            } else if let Some(model) = std::env::var("OPENAI_STT_MODEL")
                .ok()
                .filter(|value| !value.trim().is_empty())
            {
                (model, "OPENAI_STT_MODEL environment variable")
            } else {
                ("gpt-live-transcribe".into(), "built-in default")
            };
            let endpoint_source = std::env::var("OPENAI_REALTIME_ENDPOINT")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|_| "OPENAI_REALTIME_ENDPOINT environment variable")
                .unwrap_or("built-in default");
            Ok(SttBenchmarkTarget {
                backend: "openai".into(),
                model: Some(model),
                locale: None,
                vad_threshold: 0.5,
                endpoint_source: Some(endpoint_source.into()),
                model_source: Some(model_source.into()),
                credential_source: Some("OPENAI_API_KEY environment variable".into()),
            })
        }
    }
}

fn create_tts_configuration(config: &TtsBackendConfig) -> Result<TtsConfiguration, String> {
    match config {
        TtsBackendConfig::OpenAi { rate } => create_openai_tts_configuration(
            *rate,
            std::env::var("OPENAI_TTS_MODEL").unwrap_or_else(|_| "gpt-4o-mini-tts".into()),
            std::env::var("OPENAI_TTS_VOICE").unwrap_or_else(|_| "marin".into()),
        ),
        TtsBackendConfig::Siri {
            voice,
            language,
            rate,
        } => Ok(TtsConfiguration::siri(
            voice.clone(),
            language.clone(),
            *rate,
        )),
        TtsBackendConfig::Pocket {
            model_dir,
            voice,
            rate,
        } => Ok(TtsConfiguration::pocket(
            model_dir.clone(),
            berd_voice::pocket_assets::MODEL_ID.into(),
            voice.clone(),
            *rate,
        )),
    }
}

fn create_openai_tts_configuration(
    rate: f32,
    model: String,
    voice: String,
) -> Result<TtsConfiguration, String> {
    let api_key = std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "OPENAI_API_KEY is required".to_string())?;
    let base =
        std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into());
    Ok(TtsConfiguration::openai(
        format!("{}/audio/speech", base.trim_end_matches('/')),
        api_key,
        model,
        voice,
        rate,
    ))
}

fn create_tts_slot(config: &TtsBackendConfig) -> Result<ConfiguredTtsSlot, String> {
    #[cfg(not(target_os = "macos"))]
    if matches!(config, TtsBackendConfig::Siri { .. }) {
        return Err(
            "Siri TTS is the default but is only available on macOS; explicitly select --tts-backend openai or --tts-backend pocket on this platform"
                .into(),
        );
    }
    ConfiguredTtsSlot::new(create_tts_configuration(config)?).map_err(|error| match config {
        TtsBackendConfig::Siri {
            voice, language, ..
        } => format!(
            "Siri TTS voice {voice:?} ({language}) is unavailable: {error}. Download it in Berd Voice settings or select another installed voice with --voice and --language"
        ),
        _ => error,
    })
}

fn create_tts_backend(config: &TtsBackendConfig) -> Result<Arc<dyn TtsBackend>, String> {
    let slot = create_tts_slot(config)?;
    Ok(Arc::clone(slot.lease()?.backend()))
}

fn create_synthesis_backend(config: &SynthesisTtsConfig) -> Result<Arc<dyn TtsBackend>, String> {
    match config {
        SynthesisTtsConfig::OpenAi { model, voice, rate } => {
            let slot = ConfiguredTtsSlot::new(create_openai_tts_configuration(
                *rate,
                model.clone(),
                voice.clone(),
            )?)?;
            Ok(Arc::clone(slot.lease()?.backend()))
        }
        SynthesisTtsConfig::Local(config) => create_tts_backend(config),
    }
}

fn synthesis_failure(
    code: &'static str,
    public_message: &'static str,
    detail: impl Into<String>,
) -> SynthesisFailure {
    SynthesisFailure {
        code,
        public_message,
        detail: detail.into(),
    }
}

fn prepare_synthesis_output(path: &Path) -> Result<tempfile::NamedTempFile, SynthesisFailure> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            return Err(synthesis_failure(
                "output_unavailable",
                "The output file already exists",
                format!("output already exists: {}", path.display()),
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(synthesis_failure(
                "output_unavailable",
                "The output path could not be inspected",
                error.to_string(),
            ))
        }
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    tempfile::Builder::new()
        .prefix(".berd-voice-synthesize-")
        .suffix(".wav.tmp")
        .tempfile_in(parent)
        .map_err(|error| {
            synthesis_failure(
                "output_unavailable",
                "A temporary output file could not be created",
                error.to_string(),
            )
        })
}

fn synthesis_identity(config: &SynthesisConfig) -> (Option<String>, String, Option<String>, f32) {
    match &config.tts {
        SynthesisTtsConfig::OpenAi { model, voice, rate } => {
            (Some(model.clone()), voice.clone(), None, *rate)
        }
        SynthesisTtsConfig::Local(TtsBackendConfig::Siri {
            voice,
            language,
            rate,
        }) => (None, voice.clone(), Some(language.clone()), *rate),
        SynthesisTtsConfig::Local(TtsBackendConfig::Pocket { voice, rate, .. }) => (
            Some(berd_voice::pocket_assets::MODEL_ID.into()),
            voice.clone(),
            None,
            *rate,
        ),
        SynthesisTtsConfig::Local(TtsBackendConfig::OpenAi { .. }) => {
            unreachable!("OpenAI synthesis carries explicit identity")
        }
    }
}

fn run_synthesis_with_factory(
    config: &SynthesisConfig,
    factory: impl FnOnce(&SynthesisTtsConfig) -> Result<Arc<dyn TtsBackend>, String>,
) -> Result<SynthesisResult, SynthesisFailure> {
    // Establish that a no-clobber output is possible before constructing a backend. For OpenAI,
    // this keeps ordinary path failures at zero paid requests.
    let mut temporary = prepare_synthesis_output(&config.output)?;
    let backend = factory(&config.tts).map_err(|error| {
        synthesis_failure(
            "backend_unavailable",
            "The selected TTS backend is unavailable",
            error,
        )
    })?;
    let wav =
        berd_voice::synthesize_pcm16_wav(backend.as_ref(), &config.text, temporary.as_file_mut())
            .map_err(|error| {
            let (code, message) = match error.kind {
                WavSynthesisErrorKind::Backend => (
                    "synthesis_failed",
                    "The TTS backend could not synthesize the text",
                ),
                WavSynthesisErrorKind::Cancelled => {
                    ("synthesis_cancelled", "TTS synthesis was cancelled")
                }
                WavSynthesisErrorKind::Empty => {
                    ("invalid_audio", "TTS synthesis produced no audio")
                }
                WavSynthesisErrorKind::InvalidPcm => {
                    ("invalid_audio", "TTS synthesis produced invalid audio")
                }
                WavSynthesisErrorKind::TooLong => {
                    ("audio_too_long", "TTS synthesis exceeded ten minutes")
                }
                WavSynthesisErrorKind::Output => {
                    ("output_unavailable", "The WAV output could not be written")
                }
            };
            synthesis_failure(code, message, error.detail)
        })?;
    temporary.as_file().sync_all().map_err(|error| {
        synthesis_failure(
            "output_unavailable",
            "The WAV output could not be synchronized",
            error.to_string(),
        )
    })?;
    let bytes = temporary
        .as_file()
        .metadata()
        .map_err(|error| {
            synthesis_failure(
                "output_unavailable",
                "The WAV output could not be inspected",
                error.to_string(),
            )
        })?
        .len();
    temporary
        .persist_noclobber(&config.output)
        .map_err(|error| {
            synthesis_failure(
                "output_unavailable",
                "The output file appeared before synthesis completed",
                error.error.to_string(),
            )
        })?;
    let (model, voice, language, rate) = synthesis_identity(config);
    Ok(SynthesisResult {
        backend: config.backend(),
        model,
        voice,
        language,
        rate,
        wav: SynthesisWavResult {
            encoding: "pcm_s16le",
            sample_rate: wav.sample_rate,
            channels: 1,
            bits_per_sample: 16,
            frames: wav.frames,
            duration_ms: wav.frames as f64 * 1_000.0 / f64::from(wav.sample_rate),
            bytes,
        },
    })
}

fn run_synthesis_command(config: SynthesisConfig) -> Result<(), SynthesisFailure> {
    let result = run_synthesis_with_factory(&config, create_synthesis_backend)?;
    write_json_line(
        io::stdout().lock(),
        &ManagementResultEnvelope {
            schema_version: MANAGEMENT_SCHEMA_VERSION,
            operation: "synthesize",
            event: "result",
            result,
        },
    )
    .map_err(|error| synthesis_failure("output_failed", "Could not write command result", error))
}

fn create_input_runtime(
    config: &SttBackendConfig,
) -> Result<
    (
        VoiceInputRuntime,
        tokio::sync::mpsc::Receiver<VoiceInputEvent>,
    ),
    String,
> {
    let engine = match config {
        SttBackendConfig::Parakeet { model_dir } => VoiceInputEngineConfig::Parakeet {
            model_dir: model_dir.clone(),
        },
        SttBackendConfig::Macos => {
            #[cfg(target_os = "macos")]
            {
                let status = berd_voice::mac_speech::mac_speech_status().map_err(|error| {
                    format!(
                        "Could not check the default macOS speech recognition engine: {error}. Open Berd Voice settings to verify or install the current-locale model"
                    )
                })?;
                validate_macos_stt_status(&status)?;
                VoiceInputEngineConfig::MacSpeech
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Err(
                    "macOS speech recognition is the default but is only available on macOS; explicitly select --stt-backend parakeet or --stt-backend openai on this platform"
                        .into(),
                );
            }
        }
        SttBackendConfig::OpenAi => {
            let api_key = std::env::var("OPENAI_API_KEY")
                .ok()
                .filter(|key| !key.trim().is_empty())
                .ok_or_else(|| "OPENAI_API_KEY is required for OpenAI STT".to_string())?;
            let endpoint = std::env::var("OPENAI_REALTIME_ENDPOINT")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    "wss://api.openai.com/v1/realtime?intent=transcription".to_string()
                });
            let model = std::env::var("OPENAI_TRANSCRIPTION_MODEL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    std::env::var("OPENAI_STT_MODEL")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                })
                .unwrap_or_else(|| "gpt-live-transcribe".to_string());
            VoiceInputEngineConfig::OpenAi {
                endpoint,
                api_key,
                model,
            }
        }
    };
    VoiceInputRuntime::start(VoiceInputConfig {
        engine,
        speech_vad_threshold: 0.5,
        controls: VoiceInputControls::default(),
    })
    .map_err(|error| match config {
        SttBackendConfig::Macos => format!(
            "Could not start the default macOS speech recognition engine: {error}. Open Berd Voice settings to verify or install the current-locale model"
        ),
        _ => error,
    })
}

#[cfg(target_os = "macos")]
fn validate_macos_stt_status(
    status: &berd_voice::mac_speech::MacSpeechEngineStatus,
) -> Result<(), String> {
    if status.ready {
        return Ok(());
    }
    if !status.supported {
        return Err(
            "The default macOS speech engine requires macOS 26 or later with SpeechTranscriber available. Upgrade macOS or verify SpeechTranscriber availability, or explicitly select --stt-backend parakeet or --stt-backend openai"
                .into(),
        );
    }
    if !status.locale_supported {
        return Err(
            "The default macOS SpeechTranscriber engine does not support the current system locale. Select a supported macOS language and locale, or explicitly select --stt-backend parakeet or --stt-backend openai"
                .into(),
        );
    }
    let action = match status.model_status.as_str() {
        "downloading" => "Wait for the download to finish in Berd Voice settings",
        "available" => "Download the current-locale model in Berd Voice settings",
        _ => "Open Berd Voice settings to verify or install the current-locale model",
    };
    Err(format!(
        "The default macOS SpeechTranscriber model is not ready (model status: {}). {action}, or explicitly select --stt-backend parakeet or --stt-backend openai",
        status.model_status
    ))
}

fn poll_tts_configuration_update(
    now: Instant,
    receiver: &Receiver<TtsConfigurationEvent>,
    tts_slot: Option<&ConfiguredTtsSlot>,
    active: &mut Option<ActiveTtsConfigurationUpdate>,
    writer: &mut impl Write,
) -> Result<(), String> {
    if active.is_some_and(|update| update.deadline <= now) {
        reject_tts_configuration_update(
            active,
            tts_slot,
            "TTS configuration update timed out",
            writer,
        )?;
    }
    while let Ok(event) = receiver.try_recv() {
        if active.is_none_or(|update| update.attempt != event.attempt || update.id != event.id) {
            continue;
        }
        active.take();
        let slot = tts_slot.expect("TTS update requires initialized slot");
        let result = event
            .result
            .and_then(|replacement| slot.commit_replacement(replacement));
        let (outcome, snapshot, message) = match result {
            Ok(snapshot) => (TtsSettingsOutcome::Applied, snapshot, None),
            Err(rejection) => {
                eprintln!("TTS configuration update failed: {}", rejection.message);
                let message = public_tts_rejection_message(rejection.kind);
                (
                    TtsSettingsOutcome::Rejected,
                    rejection.snapshot,
                    Some(message.into()),
                )
            }
        };
        write_message(
            writer,
            &SessionMessage::TtsSettingsResult {
                id: event.id,
                outcome,
                snapshot,
                message,
            },
        )?;
    }
    Ok(())
}

fn public_tts_rejection_message(kind: TtsConfigurationRejectionKind) -> &'static str {
    match kind {
        TtsConfigurationRejectionKind::StaleRevision => {
            "TTS settings revision is stale; retry with the authoritative snapshot"
        }
        TtsConfigurationRejectionKind::BackendMismatch => {
            "TTS backend cannot be changed in a live session"
        }
        TtsConfigurationRejectionKind::InvalidSettings => {
            "TTS settings are invalid; the previous configuration remains active"
        }
        TtsConfigurationRejectionKind::Initialization => {
            "TTS settings could not be initialized; the previous configuration remains active"
        }
        TtsConfigurationRejectionKind::Internal => {
            "TTS settings could not be applied; the previous configuration remains active"
        }
    }
}

fn public_tts_startup_error(config: &TtsBackendConfig) -> String {
    match config {
        TtsBackendConfig::OpenAi { .. } => {
            "OpenAI TTS could not initialize; verify OPENAI_API_KEY and the selected model and voice"
                .into()
        }
        TtsBackendConfig::Siri { .. } =>
            "Siri TTS could not initialize; download the selected voice in Berd Voice settings or select another installed voice"
                .into(),
        TtsBackendConfig::Pocket { .. } =>
            "Pocket TTS could not initialize; verify the selected Pocket bundle and voice".into(),
    }
}

fn public_stt_startup_error(config: &SttBackendConfig) -> String {
    match config {
        SttBackendConfig::Macos => {
            "macOS speech recognition could not initialize; verify SpeechTranscriber availability, locale support, and the installed model in Berd Voice settings"
                .into()
        }
        SttBackendConfig::Parakeet { .. } => {
            "Parakeet speech recognition could not initialize; verify the selected model bundle"
                .into()
        }
        SttBackendConfig::OpenAi => {
            "OpenAI speech recognition could not initialize; verify OPENAI_API_KEY and the selected transcription model"
                .into()
        }
    }
}

fn write_protocol_fatal(
    writer: &mut impl Write,
    public_message: &str,
    diagnostic: &str,
) -> Result<(), String> {
    eprintln!("{diagnostic}");
    write_message(
        writer,
        &SessionMessage::Fatal {
            message: public_message.into(),
        },
    )
}

fn reject_tts_configuration_update(
    active: &mut Option<ActiveTtsConfigurationUpdate>,
    tts_slot: Option<&ConfiguredTtsSlot>,
    message: &str,
    writer: &mut impl Write,
) -> Result<(), String> {
    let Some(update) = active.take() else {
        return Ok(());
    };
    write_message(
        writer,
        &SessionMessage::TtsSettingsResult {
            id: update.id,
            outcome: TtsSettingsOutcome::Rejected,
            snapshot: tts_slot
                .expect("TTS update requires initialized slot")
                .snapshot()?,
            message: Some(message.into()),
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn process_prepare(
    request: PrepareRequest,
    core: &mut SessionCore,
    tts_slot: &ConfiguredTtsSlot,
    input_during_tts_slot: &InputDuringTtsSlot,
    active: &mut Option<ActivePlayback>,
    held: &mut Option<PrepareRequest>,
    writer: &mut impl Write,
) -> Result<(), String> {
    let id = request.id;
    match core.prepare(request.clone()) {
        PrepareOutcome::Hold => {
            *held = Some(request);
        }
        PrepareOutcome::Pending(utterances) => {
            write_message(writer, &SessionMessage::Pending { id, utterances })?;
        }
        PrepareOutcome::NotAdmitted(reason) => {
            write_message(writer, &SessionMessage::NotAdmitted { id, reason })?;
        }
        PrepareOutcome::Admitted {
            speech_id,
            confirmed_token,
            text,
        } => {
            let tts = tts_slot.lease()?;
            let input_during_tts = input_during_tts_slot.snapshot()?;
            *active = Some(ActivePlayback {
                prepare_id: id,
                speech_id,
                text,
                output: None,
                active: None,
                ready_deadline: Instant::now() + Duration::from_secs(2),
                assistant_activity: None,
                input_during_tts,
                tts,
                suspension_requested: false,
            });
            write_message(
                writer,
                &SessionMessage::Admitted {
                    id,
                    speech_id,
                    confirmed_token,
                },
            )?;
        }
    }
    Ok(())
}

fn reevaluate_held(
    held: &mut Option<PrepareRequest>,
    core: &mut SessionCore,
    tts_slot: Option<&ConfiguredTtsSlot>,
    input_during_tts_slot: Option<&InputDuringTtsSlot>,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    if !core.user_speaking() && !core.recognition_pending() && active.is_none() {
        if let Some(pending_prepare) = held.take() {
            process_prepare(
                pending_prepare,
                core,
                tts_slot.expect("held prepare requires initialized TTS"),
                input_during_tts_slot
                    .expect("held prepare requires initialized input-during-TTS policy"),
                active,
                held,
                writer,
            )?;
        }
    }
    Ok(())
}

fn handle_voice_input_event(
    event: VoiceInputEvent,
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    next_token: &mut u64,
    writer: &mut impl Write,
) -> Result<(), String> {
    match event {
        VoiceInputEvent::Ready => {
            return Err("voice input emitted a duplicate readiness event".into())
        }
        VoiceInputEvent::SpeakingChanged(speaking) => {
            core.set_user_speaking(speaking);
            write_message(writer, &SessionMessage::InputSpeaking { active: speaking })?;
            update_provisional_suspension(core, active)?;
        }
        VoiceInputEvent::RecognitionPendingChanged(pending) => {
            core.set_recognition_pending(pending);
            write_message(
                writer,
                &SessionMessage::RecognitionPending { active: pending },
            )?;
            update_provisional_suspension(core, active)?;
        }
        VoiceInputEvent::FinalTranscript {
            text,
            storage_receipt,
        } => store_and_publish_voice_final(
            text,
            || storage_receipt.stored(),
            core,
            active,
            next_token,
            writer,
        )?,
        VoiceInputEvent::Failed(message) => {
            write_protocol_fatal(writer, "voice input runtime failed", &message)?;
            abort_active(active);
            return Err(message);
        }
    }
    Ok(())
}

fn update_provisional_suspension(
    core: &SessionCore,
    active: &mut Option<ActivePlayback>,
) -> Result<(), String> {
    let Some(current) = active.as_mut() else {
        return Ok(());
    };
    if current
        .active
        .as_ref()
        .is_some_and(|authority| !authority.load(Ordering::SeqCst))
    {
        return Ok(());
    }
    let requested = core.user_speaking() || core.recognition_pending();
    if current.suspension_requested == requested {
        return Ok(());
    }
    current.suspension_requested = requested;
    if let Some(output) = &current.output {
        if requested {
            output.request_suspend()?;
        } else {
            output.request_resume()?;
        }
    }
    Ok(())
}

fn store_and_publish_voice_final(
    text: String,
    mark_stored: impl FnOnce(),
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    next_token: &mut u64,
    writer: &mut impl Write,
) -> Result<(), String> {
    if text.len() > MAX_FINAL_TEXT_BYTES {
        let message = "final text exceeds 64 KiB".to_string();
        write_message(
            writer,
            &SessionMessage::Fatal {
                message: message.clone(),
            },
        )?;
        return Err(message);
    }
    let token = *next_token;
    let Some(next) = token.checked_add(1) else {
        let message = "voice input token space is exhausted".to_string();
        write_message(
            writer,
            &SessionMessage::Fatal {
                message: message.clone(),
            },
        )?;
        return Err(message);
    };
    *next_token = next;
    core.add_final(token, text.clone())?;
    mark_stored();
    write_message(writer, &SessionMessage::UserFinal { token, text })?;
    interrupt_active(core, active, writer)
}

fn finish_input_runtime(
    runtime: VoiceInputRuntime,
    events: &mut tokio::sync::mpsc::Receiver<VoiceInputEvent>,
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    next_token: &mut u64,
    writer: &mut impl Write,
) -> Result<(), String> {
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .map_err(|error| format!("initialize voice input shutdown: {error}"))
            .and_then(|runtime_handle| {
                runtime_handle
                    .block_on(runtime.finish())
                    .map_err(|error| error.to_string())
            });
        let _ = done_tx.send(result);
    });
    loop {
        while let Ok(event) = events.try_recv() {
            handle_voice_input_event(event, core, active, next_token, writer)?;
        }
        match done_rx.try_recv() {
            Ok(result) => {
                while let Ok(event) = events.try_recv() {
                    handle_voice_input_event(event, core, active, next_token, writer)?;
                }
                return result;
            }
            Err(mpsc::TryRecvError::Empty) => thread::sleep(Duration::from_millis(10)),
            Err(mpsc::TryRecvError::Disconnected) => {
                return Err("voice input shutdown worker disconnected".into())
            }
        }
    }
}

fn handle_playback_event(
    event: PlaybackEvent,
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    match event {
        #[cfg(test)]
        PlaybackEvent::Started(speech_id) => {
            publish_speech_started(speech_id, core, active.as_ref(), writer)?
        }
        PlaybackEvent::Completed(speech_id) => {
            let id = active.as_ref().map_or(0, |current| current.prepare_id);
            finish_playback(
                core,
                active,
                speech_id,
                SessionMessage::SpeechCompleted { id, speech_id },
                writer,
            )?
        }
        PlaybackEvent::Interrupted(speech_id, spoken_through_utf8) => {
            let id = active.as_ref().map_or(0, |current| current.prepare_id);
            finish_playback(
                core,
                active,
                speech_id,
                SessionMessage::SpeechInterrupted {
                    id,
                    speech_id,
                    spoken_through_utf8,
                },
                writer,
            )?
        }
        PlaybackEvent::Failed(speech_id, message, output_quiescent) => {
            let id = active.as_ref().map_or(0, |current| current.prepare_id);
            finish_playback(
                core,
                active,
                speech_id,
                SessionMessage::SpeechFailed {
                    id,
                    speech_id,
                    message,
                },
                writer,
            )?;
            if !output_quiescent {
                return Err("remote PCM output did not reach a quiescent terminal".into());
            }
        }
    }
    Ok(())
}

fn publish_speech_started(
    speech_id: u64,
    core: &mut SessionCore,
    active: Option<&ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    if core.mark_started(speech_id) {
        let id = active.map_or(0, |current| current.prepare_id);
        write_message(writer, &SessionMessage::SpeechStarted { id, speech_id })?;
    }
    Ok(())
}

fn finish_playback(
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    speech_id: u64,
    message: SessionMessage,
    writer: &mut impl Write,
) -> Result<(), String> {
    if core.finish(speech_id) {
        if active
            .as_ref()
            .is_some_and(|current| current.speech_id == speech_id)
        {
            *active = None;
        }
        write_message(writer, &message)?;
    }
    Ok(())
}

fn interrupt_active(
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    let Some(current) = active.as_mut() else {
        return Ok(());
    };
    if let Some(flag) = &current.active {
        flag.store(false, Ordering::SeqCst);
        if let Some(output) = &current.output {
            output.notify_cancel_requested();
        }
    } else {
        let id = current.prepare_id;
        let speech_id = current.speech_id;
        core.finish(speech_id);
        *active = None;
        write_message(
            writer,
            &SessionMessage::SpeechInterrupted {
                id,
                speech_id,
                spoken_through_utf8: 0,
            },
        )?;
    }
    Ok(())
}

fn discard_provisional_active(
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    if active
        .as_ref()
        .is_some_and(|current| current.suspension_requested)
    {
        interrupt_active(core, active, writer)?;
    }
    Ok(())
}

fn handle_input_muted(
    id: u64,
    muted: bool,
    controls: &VoiceInputControls,
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    controls.set_host_muted(muted);
    write_message(
        writer,
        &SessionMessage::InputMuteApplied { id, active: muted },
    )?;
    if muted {
        discard_provisional_active(core, active, writer)?;
    }
    Ok(())
}

fn handle_reset_input(
    id: u64,
    controls: &VoiceInputControls,
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    controls.reset();
    write_message(writer, &SessionMessage::InputResetApplied { id })?;
    discard_provisional_active(core, active, writer)
}

fn handle_cancel(
    id: u64,
    held: &mut Option<PrepareRequest>,
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    if held.as_ref().is_some_and(|held| held.id == id) {
        held.take();
        write_message(
            writer,
            &SessionMessage::CancelResult {
                id,
                outcome: CancelOutcome::Cancelled,
                speech_id: None,
            },
        )?;
        write_message(
            writer,
            &SessionMessage::NotAdmitted {
                id,
                reason: NotAdmittedReason::Cancelled,
            },
        )?;
    } else if active
        .as_ref()
        .is_some_and(|current| current.prepare_id == id)
    {
        let speech_id = active.as_ref().map(|current| current.speech_id);
        write_message(
            writer,
            &SessionMessage::CancelResult {
                id,
                outcome: CancelOutcome::Cancelled,
                speech_id,
            },
        )?;
        interrupt_active(core, active, writer)?;
    } else {
        write_message(
            writer,
            &SessionMessage::CancelResult {
                id,
                outcome: CancelOutcome::Stale,
                speech_id: None,
            },
        )?;
    }
    Ok(())
}

fn abort_active(active: &Option<ActivePlayback>) {
    if let Some(flag) = active.as_ref().and_then(|current| current.active.as_ref()) {
        flag.store(false, Ordering::SeqCst);
    }
}

fn finish_shutdown_playback(
    playback_rx: &Receiver<PlaybackEvent>,
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while active.is_some() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let event = if remaining.is_zero() {
            Err(mpsc::RecvTimeoutError::Timeout)
        } else {
            playback_rx.recv_timeout(remaining)
        };
        match event {
            Ok(event) => handle_playback_event(event, core, active, writer)?,
            Err(error) => {
                let current = active.take().expect("active playback exists");
                core.finish(current.speech_id);
                let message = match error {
                    mpsc::RecvTimeoutError::Timeout => {
                        "playback cancellation timed out during shutdown"
                    }
                    mpsc::RecvTimeoutError::Disconnected => {
                        "playback worker disconnected during shutdown"
                    }
                };
                write_message(
                    writer,
                    &SessionMessage::SpeechFailed {
                        id: current.prepare_id,
                        speech_id: current.speech_id,
                        message: message.into(),
                    },
                )?;
            }
        }
    }
    Ok(())
}

fn write_state(
    writer: &mut impl Write,
    id: u64,
    after: u64,
    core: &SessionCore,
) -> Result<(), String> {
    write_message(
        writer,
        &SessionMessage::State {
            id,
            confirmed_token: core.confirmed_token(),
            utterances_after: core.utterances_after(after),
        },
    )
}

fn write_message(writer: &mut impl Write, message: &SessionMessage) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, message).map_err(|error| error.to_string())?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

fn receive_session_input(
    control_rx: &Receiver<OrderedControl>,
    pcm_rx: &Receiver<Box<VoiceInputFrame>>,
    pending_control: &mut Option<OrderedControl>,
    processed_pcm: &mut u64,
) -> Option<Input> {
    if pending_control.is_none() {
        *pending_control = control_rx.try_recv().ok();
    }
    if pending_control
        .as_ref()
        .is_some_and(|control| control.after_pcm <= *processed_pcm)
    {
        return pending_control.take().map(|control| control.input);
    }
    match pcm_rx.recv_timeout(Duration::from_millis(10)) {
        Ok(frame) => {
            *processed_pcm = processed_pcm.saturating_add(1);
            Some(Input::Pcm(frame))
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if pending_control.is_none() {
                *pending_control = control_rx.try_recv().ok();
            }
            if pending_control
                .as_ref()
                .is_some_and(|control| control.after_pcm <= *processed_pcm)
            {
                pending_control.take().map(|control| control.input)
            } else {
                None
            }
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            if pending_control.is_none() {
                *pending_control = control_rx.try_recv().ok();
            }
            pending_control
                .take()
                .map(|control| control.input)
                .or(Some(Input::Eof))
        }
    }
}

fn read_framed_requests(
    mut reader: impl Read,
    control_sender: mpsc::Sender<OrderedControl>,
    pcm_sender: SyncSender<Box<VoiceInputFrame>>,
) {
    let mut sent_pcm = 0_u64;
    loop {
        let mut header = [0_u8; FRAME_HEADER_BYTES];
        let input = match reader.read(&mut header[..1]) {
            Ok(0) => break,
            Ok(1) => match reader.read_exact(&mut header[1..]) {
                Ok(()) => decode_framed_input(&mut reader, header),
                Err(error) => Input::Invalid(format!("truncated session frame header: {error}")),
            },
            Ok(_) => unreachable!("one-byte read"),
            Err(error) => Input::Invalid(format!("could not read stdin: {error}")),
        };
        match input {
            Input::Pcm(frame) => match pcm_sender.try_send(frame) {
                Ok(()) => sent_pcm = sent_pcm.saturating_add(1),
                Err(mpsc::TrySendError::Full(_)) => {
                    let _ = control_sender.send(OrderedControl {
                        after_pcm: sent_pcm,
                        input: Input::Invalid("session PCM input queue is full".into()),
                    });
                    return;
                }
                Err(mpsc::TrySendError::Disconnected(_)) => return,
            },
            input => {
                let terminal = matches!(input, Input::Invalid(_));
                if control_sender
                    .send(OrderedControl {
                        after_pcm: sent_pcm,
                        input,
                    })
                    .is_err()
                    || terminal
                {
                    return;
                }
            }
        }
    }
    let _ = control_sender.send(OrderedControl {
        after_pcm: sent_pcm,
        input: Input::Eof,
    });
}

fn decode_framed_input(reader: &mut impl Read, header: [u8; FRAME_HEADER_BYTES]) -> Input {
    if header[..2] != FRAME_MAGIC {
        return Input::Invalid("invalid session frame magic".into());
    }
    if header[2] != WIRE_MARKER as u8 {
        return Input::Invalid(format!("invalid session frame marker: {}", header[2]));
    }
    let kind = header[3];
    let length = u32::from_le_bytes(header[4..8].try_into().expect("four-byte length")) as usize;
    match kind {
        JSON_FRAME_KIND if length > MAX_LINE_BYTES => {
            return Input::Invalid("request exceeds 1 MiB".into())
        }
        PCM_FRAME_KIND if length != PCM_FRAME_BYTES => {
            return Input::Invalid(format!(
                "PCM frame has {length} bytes; expected {PCM_FRAME_BYTES}"
            ))
        }
        JSON_FRAME_KIND | PCM_FRAME_KIND => {}
        _ => return Input::Invalid(format!("unknown session frame kind: {kind}")),
    }
    let mut payload = vec![0_u8; length];
    if let Err(error) = reader.read_exact(&mut payload) {
        return Input::Invalid(format!("truncated session frame payload: {error}"));
    }
    if kind == JSON_FRAME_KIND {
        String::from_utf8(payload)
            .map_err(|error| format!("invalid request UTF-8: {error}"))
            .and_then(|json| {
                serde_json::from_str(&json).map_err(|error| format!("invalid request: {error}"))
            })
            .and_then(validate_request)
            .map(Input::Request)
            .unwrap_or_else(Input::Invalid)
    } else {
        let samples = payload
            .chunks_exact(std::mem::size_of::<f32>())
            .map(|sample| f32::from_le_bytes(sample.try_into().expect("four-byte sample")))
            .collect::<Vec<_>>();
        VoiceInputFrame::try_from_samples(&samples)
            .map(|frame| Input::Pcm(Box::new(frame)))
            .unwrap_or_else(Input::Invalid)
    }
}

fn validate_request(request: SessionRequest) -> Result<SessionRequest, String> {
    let id = match &request {
        SessionRequest::Hello { id, .. }
        | SessionRequest::SetInputMuted { id, .. }
        | SessionRequest::SetTtsSettings { id, .. }
        | SessionRequest::SetInputDuringTts { id, .. }
        | SessionRequest::ResetInput { id }
        | SessionRequest::PrepareSpeak { id, .. }
        | SessionRequest::OutputReady { id, .. }
        | SessionRequest::QueryState { id, .. }
        | SessionRequest::Cancel { id } => Some(*id),
        SessionRequest::SetPaused { .. }
        | SessionRequest::AudioBeginAccepted { .. }
        | SessionRequest::AudioBeginFailed { .. }
        | SessionRequest::AudioChunkAccepted { .. }
        | SessionRequest::AudioPlayed { .. }
        | SessionRequest::AudioSuspended { .. }
        | SessionRequest::AudioResumed { .. }
        | SessionRequest::AudioDrained { .. }
        | SessionRequest::AudioFailed { .. }
        | SessionRequest::AudioCancelled { .. }
        | SessionRequest::Shutdown => None,
    };
    if id == Some(0) {
        return Err("request id must be positive".into());
    }
    match &request {
        SessionRequest::PrepareSpeak { text, .. } if text.len() > MAX_SPEAK_TEXT_BYTES => {
            return Err("speak text exceeds 16 KiB".into())
        }
        SessionRequest::OutputReady { speech_id: 0, .. } => {
            return Err("speech id must be positive".into())
        }
        SessionRequest::SetTtsSettings {
            expected_revision: 0,
            ..
        } => return Err("expected TTS revision must be positive".into()),
        SessionRequest::SetInputDuringTts {
            expected_revision: 0,
            ..
        } => return Err("expected input-during-TTS revision must be positive".into()),
        SessionRequest::AudioBeginAccepted { speech_id: 0 }
        | SessionRequest::AudioBeginFailed { speech_id: 0, .. }
        | SessionRequest::AudioChunkAccepted { speech_id: 0, .. }
        | SessionRequest::AudioPlayed { speech_id: 0, .. }
        | SessionRequest::AudioSuspended { speech_id: 0, .. }
        | SessionRequest::AudioResumed { speech_id: 0, .. }
        | SessionRequest::AudioDrained { speech_id: 0, .. }
        | SessionRequest::AudioFailed { speech_id: 0, .. }
        | SessionRequest::AudioCancelled { speech_id: 0, .. } => {
            return Err("audio speech id must be positive".into())
        }
        SessionRequest::AudioChunkAccepted { sequence: 0, .. }
        | SessionRequest::AudioDrained { sequence: 0, .. } => {
            return Err("audio sequence must be positive".into())
        }
        SessionRequest::AudioBeginFailed { message, .. }
        | SessionRequest::AudioFailed { message, .. }
            if message.len() > 4096 =>
        {
            return Err("audio failure message exceeds 4 KiB".into())
        }
        _ => {}
    }
    Ok(request)
}

fn spawn_playback(
    speech_id: u64,
    text: String,
    backend: Arc<dyn TtsBackend>,
    output: Arc<RemotePcmAudioOutput>,
    active: Arc<AtomicBool>,
    sender: mpsc::Sender<PlaybackEvent>,
) {
    thread::spawn(move || {
        let terminal = match play_tts(&text, backend.as_ref(), &output, &active) {
            Ok((true, _)) => PlaybackEvent::Completed(speech_id),
            Ok((false, delivery)) => PlaybackEvent::Interrupted(
                speech_id,
                u64::try_from(estimated_spoken_through_utf8(&text, &delivery))
                    .expect("speech text is bounded well below u64"),
            ),
            Err(failure) => {
                PlaybackEvent::Failed(speech_id, failure.message, failure.output_quiescent)
            }
        };
        let _ = sender.send(terminal);
    });
}

fn play_tts(
    text: &str,
    backend: &dyn TtsBackend,
    output: &RemotePcmAudioOutput,
    active: &AtomicBool,
) -> Result<(bool, DeliveryProgress), PlaybackFailure> {
    if let Err(message) = output.start() {
        if message == AUDIO_CANCELLED {
            return Ok((
                false,
                DeliveryProgress {
                    sample_rate: backend.pcm_spec().sample_rate,
                    segments: Vec::new(),
                },
            ));
        }
        return Err(PlaybackFailure {
            message,
            output_quiescent: output.failure_is_quiescent(),
        });
    }
    synthesize_to_output_with_finish(
        text,
        backend,
        output,
        active,
        &mut || output.finish_writes(),
        &mut || Ok(()),
    )
}

#[cfg(test)]
fn synthesize_to_output(
    speech_id: u64,
    text: &str,
    backend: &dyn TtsBackend,
    output: &dyn berd_voice::PcmAudioOutput,
    active: &AtomicBool,
    sender: &mpsc::Sender<PlaybackEvent>,
) -> Result<bool, PlaybackFailure> {
    synthesize_to_output_with_finish(text, backend, output, active, &mut || Ok(()), &mut || {
        let _ = sender.send(PlaybackEvent::Started(speech_id));
        Ok(())
    })
    .map(|(completed, _)| completed)
}

fn synthesize_to_output_with_finish(
    text: &str,
    backend: &dyn TtsBackend,
    output: &dyn berd_voice::PcmAudioOutput,
    active: &AtomicBool,
    finish_writes: &mut dyn FnMut() -> Result<(), String>,
    on_started: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(bool, DeliveryProgress), PlaybackFailure> {
    use berd_voice::{DrainPolicy, DrainTimeoutOutcome, OutboundOutcome, OutboundPlayback};

    let spec = backend.pcm_spec();
    let initial_frames = usize::try_from(spec.sample_rate / 5).map_err(|_| PlaybackFailure {
        message: "TTS sample rate is too large".into(),
        output_quiescent: false,
    })?;
    let mut playback = OutboundPlayback::new(output, active, spec.sample_rate, initial_frames)
        .map_err(|message| PlaybackFailure {
            message,
            output_quiescent: false,
        })?;
    if playback
        .synthesize_segment(backend, text, &mut |_| Ok(()), on_started, &mut |_| Ok(()))
        .map_err(|failure| PlaybackFailure {
            message: failure.message,
            output_quiescent: failure.output_quiescent,
        })?
        == OutboundOutcome::Interrupted
    {
        return Ok((false, playback.snapshot()));
    }
    if let Err(message) = finish_writes() {
        let output_quiescent = output.cancel_and_snapshot().is_ok();
        return Err(PlaybackFailure {
            message,
            output_quiescent,
        });
    }
    let outcome = playback
        .finish(
            DrainPolicy {
                timeout: Some(Duration::from_secs(2)),
                timeout_outcome: DrainTimeoutOutcome::Fail,
                ..DrainPolicy::default()
            },
            &mut |_| Ok(()),
        )
        .map_err(|failure| PlaybackFailure {
            message: failure.message,
            output_quiescent: failure.output_quiescent,
        })?;
    Ok((outcome == OutboundOutcome::Completed, playback.snapshot()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use berd_voice::input::InputDuringTtsPolicy;
    use berd_voice::{PcmAudioOutput, TtsOutcome, TtsPcmSpec};
    use serde_json::{json, Value};
    use std::io::{Cursor, Read, Write};
    use std::os::fd::IntoRawFd;
    use std::os::unix::net::UnixStream;
    use std::sync::Mutex;

    fn synthesis_config(tts: SynthesisTtsConfig, output: PathBuf) -> SynthesisConfig {
        SynthesisConfig {
            tts,
            text: "A bounded test sentence.".into(),
            output,
        }
    }

    #[test]
    fn parses_closed_synthesis_surface_for_each_backend() {
        let siri = parse_synthesis_args(&args(&[
            "berd-voice",
            "synthesize",
            "--tts-backend",
            "siri",
            "--voice",
            "Aaron",
            "--language",
            "en_US",
            "--rate",
            "2",
            "--text",
            "hello",
            "--output",
            "voice.wav",
        ]))
        .unwrap();
        assert!(matches!(
            siri.tts,
            SynthesisTtsConfig::Local(TtsBackendConfig::Siri {
                language,
                rate: 2.0,
                ..
            }) if language == "en-US"
        ));

        let pocket = parse_synthesis_args(&args(&[
            "berd-voice",
            "synthesize",
            "--tts-backend",
            "pocket",
            "--model-dir",
            "/models/pocket",
            "--voice",
            "mary",
            "--rate",
            "1",
            "--text",
            "hello",
            "--output",
            "voice.wav",
        ]))
        .unwrap();
        assert!(matches!(
            pocket.tts,
            SynthesisTtsConfig::Local(TtsBackendConfig::Pocket { rate: 1.0, .. })
        ));

        let openai = parse_synthesis_args(&args(&[
            "berd-voice",
            "synthesize",
            "--tts-backend",
            "openai",
            "--model",
            "gpt-test",
            "--voice",
            "marin",
            "--rate",
            "1.5",
            "--allow-paid-openai",
            "--text",
            "hello",
            "--output",
            "voice.wav",
        ]))
        .unwrap();
        assert!(matches!(
            openai.tts,
            SynthesisTtsConfig::OpenAi { rate: 1.5, .. }
        ));
    }

    #[test]
    fn synthesis_parser_rejects_unsafe_or_untruthful_combinations() {
        let cases = [
            vec![
                "--tts-backend",
                "openai",
                "--model",
                "gpt-test",
                "--voice",
                "marin",
            ],
            vec![
                "--tts-backend",
                "openai",
                "--model",
                "gpt-test",
                "--voice",
                "marin",
                "--allow-paid-openai",
                "--language",
                "en-US",
            ],
            vec![
                "--tts-backend",
                "pocket",
                "--model-dir",
                "/models/pocket",
                "--voice",
                "mary",
                "--rate",
                "2",
            ],
            vec![
                "--tts-backend",
                "siri",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
                "--allow-paid-openai",
            ],
        ];
        for mut flags in cases {
            let mut values = vec!["berd-voice", "synthesize"];
            values.append(&mut flags);
            values.extend(["--text", "hello", "--output", "voice.wav"]);
            assert!(parse_synthesis_args(&args(&values)).is_err(), "{values:?}");
        }
        assert!(parse_synthesis_args(&args(&[
            "berd-voice",
            "synthesize",
            "--tts-backend",
            "siri",
            "--voice",
            "Aaron",
            "--language",
            "en-US",
            "--text",
            "hello",
            "--output",
            "-",
        ]))
        .is_err());
    }

    #[test]
    fn output_preflight_precedes_backend_construction_and_never_clobbers() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("voice.wav");
        std::fs::write(&output, b"owned").unwrap();
        let config = synthesis_config(
            SynthesisTtsConfig::OpenAi {
                model: "gpt-test".into(),
                voice: "marin".into(),
                rate: 1.0,
            },
            output.clone(),
        );
        let constructed = AtomicBool::new(false);
        let error = run_synthesis_with_factory(&config, |_| {
            constructed.store(true, Ordering::SeqCst);
            Ok(Arc::new(FakeTts { frames: vec![0.1] }))
        })
        .unwrap_err();
        assert_eq!(error.code, "output_unavailable");
        assert!(!constructed.load(Ordering::SeqCst));
        assert_eq!(std::fs::read(output).unwrap(), b"owned");
    }

    #[test]
    fn synthesis_publishes_valid_wav_and_reports_only_public_identity() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("voice.wav");
        let config = synthesis_config(
            SynthesisTtsConfig::Local(TtsBackendConfig::Pocket {
                model_dir: PathBuf::from("/private/model/path"),
                voice: "mary".into(),
                rate: 1.0,
            }),
            output.clone(),
        );
        let result = run_synthesis_with_factory(&config, |_| {
            Ok(Arc::new(FakeTts {
                frames: vec![0.25, -0.25],
            }))
        })
        .unwrap();
        assert_eq!(&std::fs::read(&output).unwrap()[..4], b"RIFF");
        let value = serde_json::to_value(ManagementResultEnvelope {
            schema_version: MANAGEMENT_SCHEMA_VERSION,
            operation: "synthesize",
            event: "result",
            result,
        })
        .unwrap();
        assert_eq!(value["result"]["backend"], "pocket");
        assert_eq!(
            value["result"]["model"],
            berd_voice::pocket_assets::MODEL_ID
        );
        assert_eq!(value["result"]["voice"], "mary");
        let serialized = value.to_string();
        assert!(!serialized.contains("/private"));
        assert!(!serialized.contains("bounded test"));
    }

    #[test]
    fn synthesis_publish_race_preserves_the_competing_target() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("voice.wav");
        let config = synthesis_config(
            SynthesisTtsConfig::Local(TtsBackendConfig::Siri {
                voice: "Aaron".into(),
                language: "en-US".into(),
                rate: 1.0,
            }),
            output.clone(),
        );
        let error = run_synthesis_with_factory(&config, |_| {
            std::fs::write(&output, b"race winner").unwrap();
            Ok(Arc::new(FakeTts { frames: vec![0.1] }))
        })
        .unwrap_err();
        assert_eq!(error.code, "output_unavailable");
        assert_eq!(std::fs::read(&output).unwrap(), b"race winner");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn synthesis_failure_after_partial_pcm_leaves_no_artifact() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("voice.wav");
        let config = synthesis_config(
            SynthesisTtsConfig::Local(TtsBackendConfig::Siri {
                voice: "Aaron".into(),
                language: "en-US".into(),
                rate: 1.0,
            }),
            output.clone(),
        );
        let error =
            run_synthesis_with_factory(&config, |_| Ok(Arc::new(PartialFailureTts))).unwrap_err();
        assert_eq!(error.code, "synthesis_failed");
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    struct FakeTts {
        frames: Vec<f32>,
    }

    struct PartialFailureTts;

    struct LongRemoteTts;

    impl TtsBackend for LongRemoteTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            }
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            on_frames(&vec![0.25; session_audio::MAX_AUDIO_CHUNK_FRAMES * 8])?;
            Ok(TtsOutcome::Completed)
        }
    }

    impl TtsBackend for PartialFailureTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            }
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            on_frames(&[0.25, -0.25])?;
            Err("provider stopped".into())
        }
    }

    impl TtsBackend for FakeTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            TtsPcmSpec {
                sample_rate: 10,
                playback_rate: 1.0,
            }
        }

        fn synthesize(
            &self,
            _text: &str,
            active: &AtomicBool,
            on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            if !active.load(Ordering::SeqCst) {
                return Ok(TtsOutcome::Cancelled);
            }
            on_frames(&self.frames)?;
            Ok(TtsOutcome::Completed)
        }
    }

    #[derive(Default)]
    struct FakeOutput {
        frames: Mutex<Vec<f32>>,
        cancelled: AtomicBool,
    }

    struct BlockingOutput {
        cancelled: AtomicBool,
    }

    struct InputStateWriter<'a> {
        controls: &'a VoiceInputControls,
        expected_muted: bool,
        bytes: Vec<u8>,
    }

    impl Write for InputStateWriter<'_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            assert_eq!(self.controls.is_muted(), self.expected_muted);
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            assert_eq!(self.controls.is_muted(), self.expected_muted);
            Ok(())
        }
    }

    impl PcmAudioOutput for BlockingOutput {
        fn write(&self, _samples: &[f32]) -> Result<(), String> {
            Ok(())
        }
        fn cancel(&self) {
            self.cancelled.store(true, Ordering::SeqCst);
        }
        fn is_drained(&self) -> bool {
            self.cancelled.load(Ordering::SeqCst)
        }
        fn check_health(&self) -> Result<(), String> {
            Ok(())
        }
        fn played_frames(&self) -> u64 {
            0
        }
    }

    impl PcmAudioOutput for FakeOutput {
        fn write(&self, samples: &[f32]) -> Result<(), String> {
            self.frames.lock().unwrap().extend_from_slice(samples);
            Ok(())
        }
        fn cancel(&self) {
            self.cancelled.store(true, Ordering::SeqCst);
        }
        fn is_drained(&self) -> bool {
            true
        }
        fn check_health(&self) -> Result<(), String> {
            Ok(())
        }
        fn played_frames(&self) -> u64 {
            self.frames.lock().unwrap().len() as u64
        }
    }

    fn test_tts_slot() -> ConfiguredTtsSlot {
        ConfiguredTtsSlot::new(TtsConfiguration::openai(
            "https://example.invalid/audio/speech".into(),
            "test-key".into(),
            "test-model".into(),
            "test-voice".into(),
            1.0,
        ))
        .unwrap()
    }

    fn test_tts_lease() -> TtsConfigurationLease {
        test_tts_slot().lease().unwrap()
    }

    fn test_input_policy_slot() -> InputDuringTtsSlot {
        InputDuringTtsSlot::new(InputDuringTtsPolicy::AllowBargeIn)
    }

    fn test_input_policy() -> InputDuringTtsSnapshot {
        test_input_policy_slot().snapshot().unwrap()
    }

    fn active_playback(core: &mut SessionCore) -> ActivePlayback {
        let PrepareOutcome::Admitted {
            speech_id, text, ..
        } = core.prepare(PrepareRequest {
            id: 7,
            acknowledgement: None,
            text: "reply".into(),
        })
        else {
            panic!("test speech must be admitted")
        };
        ActivePlayback {
            prepare_id: 7,
            speech_id,
            text,
            output: None,
            active: Some(Arc::new(AtomicBool::new(true))),
            ready_deadline: Instant::now() + Duration::from_secs(2),
            assistant_activity: None,
            input_during_tts: test_input_policy(),
            tts: test_tts_lease(),
            suspension_requested: false,
        }
    }

    fn read_audio_record(reader: &mut impl Read) -> (u8, Vec<u8>) {
        let mut header = [0; session_audio::AUDIO_FRAME_HEADER_BYTES];
        reader.read_exact(&mut header).unwrap();
        assert_eq!(header[..2], session_audio::AUDIO_FRAME_MAGIC);
        assert_eq!(header[2], session_audio::AUDIO_FRAME_MARKER);
        let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        let mut payload = vec![0; length];
        reader.read_exact(&mut payload).unwrap();
        (header[3], payload)
    }

    #[test]
    fn false_barge_quiesces_and_resumes_one_remote_speech_without_a_terminal() {
        let mut core = SessionCore::default();
        let mut current = active_playback(&mut core);
        let speech_id = current.speech_id;
        let (child, mut host) = UnixStream::pair().unwrap();
        let transport = unsafe { AudioPipeTransport::from_raw_fd(child.into_raw_fd()) }.unwrap();
        let authority = current.active.as_ref().unwrap().clone();
        let (control_sender, control_receiver) = mpsc::channel();
        let output = Arc::new(
            RemotePcmAudioOutput::new(
                speech_id,
                LongRemoteTts.pcm_spec(),
                Arc::new(transport),
                Arc::clone(&authority),
                control_sender,
            )
            .unwrap(),
        );
        current.output = Some(Arc::clone(&output));
        let mut active = Some(current);
        let (playback_sender, playback_receiver) = mpsc::channel();
        spawn_playback(
            speech_id,
            "a long remote reply".into(),
            Arc::new(LongRemoteTts),
            Arc::clone(&output),
            authority,
            playback_sender,
        );

        let (kind, _) = read_audio_record(&mut host);
        assert_eq!(kind, session_audio::AUDIO_BEGIN_KIND);
        assert!(
            !handle_audio_ack(speech_id, AudioHostAck::BeginAccepted, active.as_ref()).unwrap()
        );
        let (kind, first_chunk) = read_audio_record(&mut host);
        assert_eq!(kind, session_audio::AUDIO_CHUNK_KIND);
        let first_frames = u64::try_from((first_chunk.len() - 16) / 4).unwrap();
        let mut output_messages = Vec::new();
        let mut next_token = 1;

        handle_voice_input_event(
            VoiceInputEvent::SpeakingChanged(true),
            &mut core,
            &mut active,
            &mut next_token,
            &mut output_messages,
        )
        .unwrap();
        let suspend = control_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        write_audio_control_request(suspend, active.as_ref(), &mut output_messages).unwrap();
        assert!(handle_audio_ack(
            speech_id,
            AudioHostAck::ChunkAccepted { sequence: 1 },
            active.as_ref(),
        )
        .unwrap());
        publish_speech_started(speech_id, &mut core, active.as_ref(), &mut output_messages)
            .unwrap();
        handle_audio_ack(
            speech_id,
            AudioHostAck::Played {
                played_frames: first_frames,
            },
            active.as_ref(),
        )
        .unwrap();
        handle_audio_ack(
            speech_id,
            AudioHostAck::Suspended {
                played_frames: first_frames,
            },
            active.as_ref(),
        )
        .unwrap();
        host.set_read_timeout(Some(Duration::from_millis(30)))
            .unwrap();
        let mut byte = [0];
        assert!(host.read(&mut byte).is_err());

        for event in [
            VoiceInputEvent::RecognitionPendingChanged(true),
            VoiceInputEvent::SpeakingChanged(false),
        ] {
            handle_voice_input_event(
                event,
                &mut core,
                &mut active,
                &mut next_token,
                &mut output_messages,
            )
            .unwrap();
        }
        assert!(control_receiver.try_recv().is_err());
        handle_voice_input_event(
            VoiceInputEvent::RecognitionPendingChanged(false),
            &mut core,
            &mut active,
            &mut next_token,
            &mut output_messages,
        )
        .unwrap();
        let resume = control_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        write_audio_control_request(resume, active.as_ref(), &mut output_messages).unwrap();
        handle_audio_ack(
            speech_id,
            AudioHostAck::Resumed {
                played_frames: first_frames,
            },
            active.as_ref(),
        )
        .unwrap();

        host.set_read_timeout(None).unwrap();
        let mut played_frames = first_frames;
        let mut last_sequence = 1;
        loop {
            let (kind, payload) = read_audio_record(&mut host);
            match kind {
                session_audio::AUDIO_CHUNK_KIND => {
                    let sequence = u64::from_le_bytes(payload[8..16].try_into().unwrap());
                    let frames = u64::try_from((payload.len() - 16) / 4).unwrap();
                    assert_eq!(sequence, last_sequence + 1);
                    last_sequence = sequence;
                    handle_audio_ack(
                        speech_id,
                        AudioHostAck::ChunkAccepted { sequence },
                        active.as_ref(),
                    )
                    .unwrap();
                    played_frames += frames;
                    handle_audio_ack(
                        speech_id,
                        AudioHostAck::Played { played_frames },
                        active.as_ref(),
                    )
                    .unwrap();
                }
                session_audio::AUDIO_END_KIND => {
                    let sequence = u64::from_le_bytes(payload[8..16].try_into().unwrap());
                    let total_frames = u64::from_le_bytes(payload[16..24].try_into().unwrap());
                    assert_eq!(sequence, last_sequence);
                    assert_eq!(total_frames, played_frames);
                    handle_audio_ack(
                        speech_id,
                        AudioHostAck::Drained {
                            sequence,
                            played_frames,
                        },
                        active.as_ref(),
                    )
                    .unwrap();
                    break;
                }
                other => panic!("unexpected audio record kind {other}"),
            }
        }
        let terminal = playback_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        handle_playback_event(terminal, &mut core, &mut active, &mut output_messages).unwrap();

        let emitted = messages(&output_messages);
        assert!(!emitted
            .iter()
            .any(|message| message["type"] == "speech_interrupted"));
        assert_eq!(
            emitted
                .iter()
                .filter(|message| message["type"] == "speech_completed")
                .count(),
            1
        );
        assert!(active.is_none());
    }

    fn messages(output: &[u8]) -> Vec<Value> {
        std::str::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn public_tts_protocol_messages_never_expose_private_paths() {
        let private_path = "/Users/alice/private/native-voice-v2";
        let snapshot = berd_voice::TtsConfigurationSnapshot {
            revision: 1,
            settings: berd_voice::TtsSettings::Pocket {
                model: berd_voice::pocket_assets::MODEL_ID.into(),
                voice: "mary".into(),
                rate: 1.0,
            },
        };
        let ready = serde_json::to_string(&SessionMessage::Ready {
            id: 1,
            protocol: WIRE_MARKER,
            session: VoiceSessionSnapshot {
                tts: snapshot.clone(),
                input_during_tts: test_input_policy(),
            },
        })
        .unwrap();
        let rejection = TtsConfigurationRejection {
            kind: TtsConfigurationRejectionKind::Initialization,
            message: format!("could not load {private_path}/model.onnx"),
            snapshot: snapshot.clone(),
        };
        let result = serde_json::to_string(&SessionMessage::TtsSettingsResult {
            id: 2,
            outcome: TtsSettingsOutcome::Rejected,
            snapshot: rejection.snapshot,
            message: Some(public_tts_rejection_message(rejection.kind).into()),
        })
        .unwrap();
        let fatal = serde_json::to_string(&SessionMessage::Fatal {
            message: public_tts_startup_error(&TtsBackendConfig::Pocket {
                model_dir: PathBuf::from(private_path),
                voice: private_path.into(),
                rate: 1.0,
            }),
        })
        .unwrap();

        for message in [ready, result, fatal] {
            assert!(!message.contains(private_path));
            assert!(!message.contains("/Users/alice"));
        }
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn management_cli_parses_only_the_closed_command_shapes() {
        assert_eq!(
            parse_management_args(&args(&["berd-voice", "voices", "list"])).unwrap(),
            ManagementCommand::ListVoices { language: None }
        );
        assert_eq!(
            parse_management_args(&args(&[
                "berd-voice",
                "voices",
                "list",
                "--language",
                "en_US"
            ]))
            .unwrap(),
            ManagementCommand::ListVoices {
                language: Some("en-US".into())
            }
        );
        assert_eq!(
            parse_management_args(&args(&[
                "berd-voice",
                "voices",
                "download",
                "--voice",
                "Aaron",
                "--language",
                "en_US"
            ]))
            .unwrap(),
            ManagementCommand::DownloadVoice {
                identity: berd_voice::siri::SiriVoiceIdentity::new("Aaron", "en-US").unwrap(),
                availability_wait: berd_voice::siri::SiriDownloadAvailabilityWait::default(),
            }
        );
        assert_eq!(
            parse_management_args(&args(&[
                "berd-voice",
                "voices",
                "download",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
                "--availability-wait-seconds",
                "12"
            ]))
            .unwrap(),
            ManagementCommand::DownloadVoice {
                identity: berd_voice::siri::SiriVoiceIdentity::new("Aaron", "en-US").unwrap(),
                availability_wait: berd_voice::siri::SiriDownloadAvailabilityWait::from_seconds(12)
                    .unwrap(),
            }
        );
        assert_eq!(
            parse_management_args(&args(&["berd-voice", "models", "macos", "status"])).unwrap(),
            ManagementCommand::MacosModelStatus
        );
        assert_eq!(
            parse_management_args(&args(&["berd-voice", "models", "macos", "install"])).unwrap(),
            ManagementCommand::InstallMacosModel
        );
        let store = std::env::temp_dir().join("berd-voice-management-parser");
        let roots = local_model_roots(&store).unwrap();
        assert_eq!(
            parse_management_args(&args(&[
                "berd-voice",
                "models",
                "pocket",
                "status",
                "--store-root",
                store.to_str().unwrap(),
            ]))
            .unwrap(),
            ManagementCommand::PocketModelStatus {
                roots: roots.clone()
            }
        );
        assert_eq!(
            parse_management_args(&args(&[
                "berd-voice",
                "models",
                "pocket",
                "install",
                "--store-root",
                store.to_str().unwrap(),
            ]))
            .unwrap(),
            ManagementCommand::InstallPocketModel {
                roots: roots.clone()
            }
        );
        assert_eq!(
            parse_management_args(&args(&[
                "berd-voice",
                "models",
                "parakeet",
                "status",
                "--store-root",
                store.to_str().unwrap(),
            ]))
            .unwrap(),
            ManagementCommand::ParakeetModelStatus {
                roots: roots.clone()
            }
        );
        assert_eq!(
            parse_management_args(&args(&[
                "berd-voice",
                "models",
                "parakeet",
                "install",
                "--store-root",
                store.to_str().unwrap(),
            ]))
            .unwrap(),
            ManagementCommand::InstallParakeetModel { roots }
        );
        assert_eq!(
            parse_management_args(&args(&["berd-voice", "models", "pocket", "voices"])).unwrap(),
            ManagementCommand::ListPocketVoices
        );

        for invalid in [
            vec!["berd-voice", "voices", "list", "--language"],
            vec!["berd-voice", "voices", "list", "--unknown", "en-US"],
            vec!["berd-voice", "voices", "download", "--voice", "Aaron"],
            vec![
                "berd-voice",
                "voices",
                "download",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
                "--availability-wait-seconds",
                "0",
            ],
            vec![
                "berd-voice",
                "voices",
                "download",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
                "--availability-wait-seconds",
                "1801",
            ],
            vec![
                "berd-voice",
                "voices",
                "download",
                "--voice",
                "aaron ",
                "--language",
                "en-US",
            ],
            vec!["berd-voice", "models", "macos", "status", "extra"],
            vec!["berd-voice", "models", "pocket", "status"],
            vec![
                "berd-voice",
                "models",
                "pocket",
                "status",
                "--store-root",
                "relative",
            ],
            vec![
                "berd-voice",
                "models",
                "parakeet",
                "install",
                "--store-root",
                "/tmp/../outside",
            ],
            vec![
                "berd-voice",
                "models",
                "pocket",
                "status",
                "--store-root",
                "/tmp/./store",
            ],
            vec!["berd-voice", "models", "pocket", "voices", "extra"],
        ] {
            assert!(
                parse_management_args(&args(&invalid)).is_err(),
                "{invalid:?}"
            );
        }
        assert_eq!(
            parse_management_args(&args(&["berd-voice", "models", "pocket", "typo"])).unwrap_err(),
            "expected a supported models command"
        );
    }

    #[test]
    fn management_json_schemas_are_stable_and_sanitized() {
        let list = voices_list_report(
            true,
            Some("en-US".into()),
            berd_voice::siri::SiriVoiceCatalog {
                available_languages: vec!["en-US".into()],
                voices: vec![berd_voice::siri::SiriVoice {
                    name: "Aaron".into(),
                    language: "en-US".into(),
                    size_bytes: 42,
                    installed: true,
                }],
            },
        );
        assert_eq!(
            serde_json::to_value(ManagementResultEnvelope {
                schema_version: MANAGEMENT_SCHEMA_VERSION,
                operation: "voices.list",
                event: "result",
                result: list,
            })
            .unwrap(),
            json!({
                "schemaVersion": 1,
                "operation": "voices.list",
                "event": "result",
                "result": {
                    "supported": true,
                    "backend": "siri",
                    "languageFilter": "en-US",
                    "availableLanguages": ["en-US"],
                    "voices": [{
                        "name": "Aaron",
                        "language": "en-US",
                        "sizeBytes": 42,
                        "installed": true
                    }]
                }
            })
        );

        assert_eq!(
            serde_json::to_value(ManagementResultEnvelope {
                schema_version: MANAGEMENT_SCHEMA_VERSION,
                operation: "models.pocket.status",
                event: "result",
                result: local_model_status_report(LocalModelKind::Pocket, LocalModelState::Missing),
            })
            .unwrap(),
            json!({
                "schemaVersion": 1,
                "operation": "models.pocket.status",
                "event": "result",
                "result": {
                    "backend": "pocket",
                    "modelId": "native-voice-v2",
                    "state": "missing",
                    "ready": false,
                    "verifiedBytes": null,
                    "totalDownloadBytes": berd_voice::pocket_assets::download_bytes()
                }
            })
        );
        assert_eq!(
            serde_json::to_value(ManagementResultEnvelope {
                schema_version: MANAGEMENT_SCHEMA_VERSION,
                operation: "models.pocket.voices",
                event: "result",
                result: pocket_voices_report(),
            })
            .unwrap()["result"]["voices"][0],
            json!({"id": "anna", "name": "Anna"})
        );
        let voices = serde_json::to_value(ManagementResultEnvelope {
            schema_version: MANAGEMENT_SCHEMA_VERSION,
            operation: "models.pocket.voices",
            event: "result",
            result: pocket_voices_report(),
        })
        .unwrap();
        assert_eq!(voices["result"]["backend"], "pocket");
        assert_eq!(voices["result"]["modelId"], "native-voice-v2");
        assert_eq!(voices["result"]["voiceLicenseId"], "CC-BY-4.0");
        assert_eq!(voices["result"]["voices"].as_array().unwrap().len(), 12);
        let voices = voices.to_string();
        for private_field in [
            "relativePath",
            "sizeBytes",
            "sha256",
            "sourceUrl",
            "https://",
        ] {
            assert!(!voices.contains(private_field));
        }

        assert_eq!(
            serde_json::to_value(ManagementResultEnvelope {
                schema_version: MANAGEMENT_SCHEMA_VERSION,
                operation: "models.parakeet.install",
                event: "result",
                result: LocalModelInstallResult {
                    backend: "parakeet",
                    model_id: berd_voice::parakeet_assets::MODEL_ID,
                    outcome: "installed",
                    ready: true,
                    verified_bytes: 123,
                    cleanup_pending: true,
                },
            })
            .unwrap(),
            json!({
                "schemaVersion": 1,
                "operation": "models.parakeet.install",
                "event": "result",
                "result": {
                    "backend": "parakeet",
                    "modelId": "parakeet-tdt-ctc-110m-en-int8",
                    "outcome": "installed",
                    "ready": true,
                    "verifiedBytes": 123,
                    "cleanupPending": true
                }
            })
        );

        let identity = berd_voice::siri::SiriVoiceIdentity::new("Aaron", "en_US").unwrap();
        assert_eq!(
            serde_json::to_value(ManagementResultEnvelope {
                schema_version: MANAGEMENT_SCHEMA_VERSION,
                operation: "voices.download",
                event: "result",
                result: voice_download_report(
                    &identity,
                    berd_voice::siri::SiriDownloadAvailabilityWait::default(),
                ),
            })
            .unwrap(),
            json!({
                "schemaVersion": 1,
                "operation": "voices.download",
                "event": "result",
                "result": {
                    "backend": "siri",
                    "voice": {"name": "Aaron", "language": "en-US"},
                    "installed": true,
                    "availabilityWaitSeconds": 300
                }
            })
        );

        let status = MacosModelStatus {
            supported: true,
            locale: Some("en-US".into()),
            locale_supported: true,
            model_status: "installed".into(),
            ready: true,
        };
        assert_eq!(
            serde_json::to_value(ManagementResultEnvelope {
                schema_version: MANAGEMENT_SCHEMA_VERSION,
                operation: "models.macos.status",
                event: "result",
                result: status,
            })
            .unwrap(),
            json!({
                "schemaVersion": 1,
                "operation": "models.macos.status",
                "event": "result",
                "result": {
                    "supported": true,
                    "locale": "en-US",
                    "localeSupported": true,
                    "modelStatus": "installed",
                    "ready": true
                }
            })
        );
    }

    #[test]
    fn macos_model_install_progress_is_honest_and_bounded() {
        assert_eq!(normalized_install_progress(0.0), Some(0.0));
        assert_eq!(normalized_install_progress(0.427), Some(0.427));
        assert_eq!(normalized_install_progress(1.0), Some(1.0));
        assert_eq!(normalized_install_progress(-0.1), Some(0.0));
        assert_eq!(normalized_install_progress(1.1), Some(1.0));
        assert_eq!(normalized_install_progress(f64::NAN), None);
        assert_eq!(
            serde_json::to_value(ManagementProgressEnvelope {
                schema_version: MANAGEMENT_SCHEMA_VERSION,
                operation: "models.macos.install",
                event: "progress",
                fraction: 0.427,
            })
            .unwrap(),
            json!({
                "schemaVersion": 1,
                "operation": "models.macos.install",
                "event": "progress",
                "fraction": 0.427
            })
        );
        assert_eq!(
            serde_json::to_value(LocalModelProgressEnvelope {
                schema_version: MANAGEMENT_SCHEMA_VERSION,
                operation: "models.pocket.install",
                event: "progress",
                phase: local_install_phase_name(LocalInstallPhase::Verifying),
                downloaded_bytes: 42,
                total_download_bytes: 100,
            })
            .unwrap(),
            json!({
                "schemaVersion": 1,
                "operation": "models.pocket.install",
                "event": "progress",
                "phase": "verifying",
                "downloadedBytes": 42,
                "totalDownloadBytes": 100
            })
        );
    }

    #[test]
    fn management_operation_errors_are_structured_without_details() {
        let failure = management_failure(
            "operation_failed",
            "Could not make the requested Siri voice available",
            "private native detail at /Users/alice/private",
        );
        let envelope = management_error_envelope("voices.download", &failure);
        let json = serde_json::to_string(&envelope).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&json).unwrap(),
            json!({
                "schemaVersion": 1,
                "operation": "voices.download",
                "event": "error",
                "error": {
                    "code": "operation_failed",
                    "message": "Could not make the requested Siri voice available"
                }
            })
        );
        assert!(!json.contains("/Users/alice/private"));

        let missing = voice_download_failure(berd_voice::siri::SiriVoiceDownloadError::NotFound(
            berd_voice::siri::SiriVoiceIdentity::new("Missing", "en-US").unwrap(),
        ));
        assert_eq!(missing.code, "voice_not_found");

        let local = local_install_failure(LocalInstallError {
            kind: LocalInstallErrorKind::Rollback,
            message: "private rollback detail".into(),
            recovery_paths: vec![PathBuf::from("/Users/alice/private-backup")],
        });
        assert_eq!(local.code, "rollback_failed");
        assert!(local.detail.contains("/Users/alice/private-backup"));
        let envelope =
            serde_json::to_string(&management_error_envelope("models.pocket.install", &local))
                .unwrap();
        assert!(!envelope.contains("/Users/alice"));
        assert!(!envelope.contains("private rollback detail"));
    }

    #[test]
    fn unsupported_platform_status_has_the_same_schema() {
        assert_eq!(
            unsupported_macos_model_status(),
            MacosModelStatus {
                supported: false,
                locale: None,
                locale_supported: false,
                model_status: "unsupported".into(),
                ready: false,
            }
        );
    }

    #[test]
    fn macos_model_install_is_idempotent_and_rejects_unsupported_states_before_mutation() {
        let status = |supported: bool, locale_supported: bool, ready: bool| MacosModelStatus {
            supported,
            locale: locale_supported.then(|| "en-US".into()),
            locale_supported,
            model_status: if ready { "installed" } else { "available" }.into(),
            ready,
        };

        assert!(!macos_install_needs_mutation(&status(true, true, true)).unwrap());
        assert!(macos_install_needs_mutation(&status(true, true, false)).unwrap());
        assert_eq!(
            macos_install_needs_mutation(&status(false, false, false))
                .unwrap_err()
                .code,
            "unsupported"
        );
        assert_eq!(
            macos_install_needs_mutation(&status(true, false, false))
                .unwrap_err()
                .code,
            "unsupported_locale"
        );
    }

    #[test]
    fn cli_defaults_to_exact_siri_and_macos_without_cloud_fallback() {
        let missing_voice = parse_args(&args(&["berd-voice", "session"])).unwrap_err();
        assert!(missing_voice.contains("Siri TTS is the default"));
        assert!(missing_voice.contains("--voice NAME and --language BCP47"));

        assert_eq!(
            parse_args(&args(&[
                "berd-voice",
                "session",
                "--voice",
                "Aaron",
                "--language",
                "en-US"
            ]))
            .unwrap(),
            SessionConfig {
                tts: TtsBackendConfig::Siri {
                    voice: "Aaron".into(),
                    language: "en-US".into(),
                    rate: 1.0,
                },
                stt: SttBackendConfig::Macos,
            }
        );

        assert_eq!(
            parse_args(&args(&["berd-voice", "session", "--tts-backend", "openai"])).unwrap(),
            SessionConfig {
                tts: TtsBackendConfig::OpenAi { rate: 1.0 },
                stt: SttBackendConfig::Macos,
            }
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_default_availability_errors_are_actionable() {
        let unavailable_siri = create_tts_backend(&TtsBackendConfig::Siri {
            voice: "__berd_voice_does_not_exist__".into(),
            language: "en-US".into(),
            rate: 1.0,
        })
        .err()
        .unwrap();
        assert!(unavailable_siri.contains("is unavailable"));
        assert!(unavailable_siri.contains("Download it in Berd Voice settings"));

        let status = |supported: bool, locale_supported: bool, model_status: &str, ready: bool| {
            berd_voice::mac_speech::MacSpeechEngineStatus {
                supported,
                locale: locale_supported.then(|| "en-US".into()),
                locale_supported,
                model_status: model_status.into(),
                ready,
            }
        };
        for (status, expected) in [
            (
                status(false, false, "unsupported", false),
                "requires macOS 26 or later with SpeechTranscriber available",
            ),
            (
                status(true, false, "unsupported", false),
                "does not support the current system locale",
            ),
            (
                status(true, true, "downloading", false),
                "Wait for the download to finish",
            ),
            (
                status(true, true, "available", false),
                "Download the current-locale model",
            ),
        ] {
            let error = validate_macos_stt_status(&status).unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert!(error.contains("explicitly select --stt-backend"));
        }

        let ready = status(true, true, "installed", true);
        assert_eq!(validate_macos_stt_status(&ready), Ok(()));
    }

    #[test]
    fn cli_requires_exact_siri_selection_and_bounds_rate() {
        assert_eq!(
            parse_args(&args(&[
                "berd-voice",
                "session",
                "--tts-backend",
                "siri",
                "--voice",
                "Aaron",
                "--language",
                "en-US"
            ]))
            .unwrap(),
            SessionConfig {
                tts: TtsBackendConfig::Siri {
                    voice: "Aaron".into(),
                    language: "en-US".into(),
                    rate: 1.0,
                },
                stt: SttBackendConfig::Macos,
            }
        );
        assert!(parse_args(&args(&[
            "berd-voice",
            "session",
            "--tts-backend",
            "siri",
            "--voice",
            "Aaron",
            "--language",
            "en-US",
            "--rate",
            "2.1"
        ]))
        .is_err());
    }

    #[test]
    fn cli_accepts_openai_rate_two_and_rejects_out_of_range_rates() {
        assert_eq!(
            parse_args(&args(&[
                "berd-voice",
                "session",
                "--tts-backend",
                "openai",
                "--rate",
                "2.0"
            ]))
            .unwrap()
            .tts,
            TtsBackendConfig::OpenAi { rate: 2.0 }
        );
        assert!(parse_args(&args(&[
            "berd-voice",
            "session",
            "--tts-backend",
            "openai",
            "--rate",
            "2.1"
        ]))
        .unwrap_err()
        .contains("0.75 and 2.0"));
    }

    #[test]
    fn cli_requires_explicit_pocket_bundle_and_voice() {
        assert_eq!(
            parse_args(&args(&[
                "berd-voice",
                "session",
                "--tts-backend",
                "pocket",
                "--model-dir",
                "/models/native-voice-v2",
                "--voice",
                "george"
            ]))
            .unwrap(),
            SessionConfig {
                tts: TtsBackendConfig::Pocket {
                    model_dir: PathBuf::from("/models/native-voice-v2"),
                    voice: "george".into(),
                    rate: 1.0,
                },
                stt: SttBackendConfig::Macos,
            }
        );
        assert!(parse_args(&args(&[
            "berd-voice",
            "session",
            "--tts-backend",
            "pocket",
            "--voice",
            "george"
        ]))
        .unwrap_err()
        .contains("--model-dir is required"));
        assert!(parse_args(&args(&[
            "berd-voice",
            "session",
            "--tts-backend",
            "pocket",
            "--model-dir",
            "/models",
            "--voice",
            "george",
            "--rate",
            "0.5"
        ]))
        .unwrap_err()
        .contains("0.75 and 2.0"));
        assert!(parse_args(&args(&[
            "berd-voice",
            "session",
            "--tts-backend",
            "pocket",
            "--model-dir",
            "relative/model",
            "--voice",
            "george"
        ]))
        .unwrap_err()
        .contains("absolute path"));
    }

    #[test]
    fn cli_stt_selection_is_closed_and_parakeet_owns_only_an_explicit_bundle() {
        assert_eq!(
            parse_args(&args(&[
                "berd-voice",
                "session",
                "--tts-backend",
                "openai",
                "--stt-backend",
                "parakeet",
                "--stt-model-dir",
                "/models/parakeet"
            ]))
            .unwrap(),
            SessionConfig {
                tts: TtsBackendConfig::OpenAi { rate: 1.0 },
                stt: SttBackendConfig::Parakeet {
                    model_dir: PathBuf::from("/models/parakeet")
                }
            }
        );
        assert!(parse_args(&args(&[
            "berd-voice",
            "session",
            "--tts-backend",
            "openai",
            "--stt-backend",
            "parakeet"
        ]))
        .unwrap_err()
        .contains("--stt-model-dir is required"));
        assert!(parse_args(&args(&[
            "berd-voice",
            "session",
            "--tts-backend",
            "openai",
            "--stt-backend",
            "macos",
            "--stt-model-dir",
            "/models/parakeet"
        ]))
        .unwrap_err()
        .contains("only valid with Parakeet"));
        assert!(parse_args(&args(&[
            "berd-voice",
            "session",
            "--tts-backend",
            "openai",
            "--stt-backend",
            "parakeet",
            "--stt-model-dir",
            "relative"
        ]))
        .unwrap_err()
        .contains("absolute path"));
    }

    #[test]
    fn benchmark_cli_requires_explicit_comparable_inputs() {
        assert_eq!(
            parse_tts_benchmark_args(&args(&[
                "berd-voice",
                "benchmark",
                "tts",
                "--tts-backend",
                "siri",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
                "--text",
                "A fixed benchmark sentence.",
                "--runs",
                "3",
                "--mode",
                "warm"
            ]))
            .unwrap(),
            TtsBenchmarkConfig {
                tts: TtsBackendConfig::Siri {
                    voice: "Aaron".into(),
                    language: "en-US".into(),
                    rate: 1.0,
                },
                prompts: TtsBenchmarkPrompts::ExactRepeat {
                    text: "A fixed benchmark sentence.".into(),
                    runs: 3,
                },
                mode: TtsBenchmarkMode::Warm,
            }
        );
        assert!(parse_tts_benchmark_args(&args(&[
            "berd-voice",
            "benchmark",
            "tts",
            "--tts-backend",
            "openai",
            "--text",
            "hello",
            "--mode",
            "fresh-backend"
        ]))
        .unwrap_err()
        .contains("--runs is required"));
        assert!(parse_tts_benchmark_args(&args(&[
            "berd-voice",
            "benchmark",
            "tts",
            "--tts-backend",
            "openai",
            "--text",
            "hello",
            "--runs",
            "0",
            "--mode",
            "fresh-backend"
        ]))
        .unwrap_err()
        .contains("between 1 and 100"));
    }

    #[test]
    fn benchmark_cli_reuses_backend_specific_validation() {
        assert!(parse_tts_benchmark_args(&args(&[
            "berd-voice",
            "benchmark",
            "tts",
            "--tts-backend",
            "pocket",
            "--model-dir",
            "relative",
            "--voice",
            "mary",
            "--text",
            "hello",
            "--runs",
            "1",
            "--mode",
            "fresh-backend"
        ]))
        .unwrap_err()
        .contains("absolute path"));
        assert!(parse_tts_benchmark_args(&args(&[
            "berd-voice",
            "benchmark",
            "tts",
            "--tts-backend",
            "openai",
            "--text",
            "hello",
            "--runs",
            "1",
            "--mode",
            "fresh-backend",
            "--stt-backend",
            "macos"
        ]))
        .unwrap_err()
        .contains("unknown argument"));
    }

    #[test]
    fn benchmark_cli_selects_fixed_distinct_prompt_manifest() {
        let config = parse_tts_benchmark_args(&args(&[
            "berd-voice",
            "benchmark",
            "tts",
            "--tts-backend",
            "siri",
            "--voice",
            "Aaron",
            "--language",
            "en-US",
            "--prompt-manifest",
            "english-short-v1",
            "--mode",
            "warm",
        ]))
        .unwrap();
        let TtsBenchmarkPrompts::Manifest(manifest) = config.prompts else {
            panic!("expected prompt manifest")
        };
        assert_eq!(manifest.id, "english-short-v1");
        assert_eq!(manifest.prompts.len(), 5);

        assert!(parse_tts_benchmark_args(&args(&[
            "berd-voice",
            "benchmark",
            "tts",
            "--tts-backend",
            "siri",
            "--voice",
            "Aaron",
            "--language",
            "en-CA",
            "--prompt-manifest",
            "english-short-v1",
            "--mode",
            "warm",
        ]))
        .unwrap_err()
        .contains("requires Siri language en-US"));
        assert!(parse_tts_benchmark_args(&args(&[
            "berd-voice",
            "benchmark",
            "tts",
            "--tts-backend",
            "siri",
            "--voice",
            "Aaron",
            "--language",
            "en-US",
            "--prompt-manifest",
            "english-short-v1",
            "--runs",
            "5",
            "--mode",
            "warm",
        ]))
        .unwrap_err()
        .contains("fixed by --prompt-manifest"));
    }

    #[test]
    fn openai_tts_target_reports_rate_and_endpoint_source() {
        let target = tts_benchmark_target(&TtsBackendConfig::OpenAi { rate: 1.75 }, false);
        assert_eq!(target.rate, Some(1.75));
        assert_eq!(target.endpoint_source.as_deref(), Some("built_in_default"));
        assert_eq!(
            tts_benchmark_target(&TtsBackendConfig::OpenAi { rate: 1.0 }, true)
                .endpoint_source
                .as_deref(),
            Some("OPENAI_BASE_URL_environment")
        );
    }

    #[test]
    fn benchmark_cli_requires_and_bounds_paid_openai_consent() {
        let base = [
            "berd-voice",
            "benchmark",
            "tts",
            "--tts-backend",
            "openai",
            "--text",
            "hello",
            "--runs",
            "1",
            "--mode",
            "fresh-backend",
        ];
        assert!(parse_tts_benchmark_args(&args(&base))
            .unwrap_err()
            .contains("--allow-paid-openai"));

        let mut consented = args(&base);
        consented.push("--allow-paid-openai".into());
        assert!(parse_tts_benchmark_args(&consented).is_ok());

        let warm_limit = args(&[
            "berd-voice",
            "benchmark",
            "tts",
            "--tts-backend",
            "openai",
            "--text",
            "hello",
            "--runs",
            "20",
            "--mode",
            "warm",
            "--allow-paid-openai",
        ]);
        assert!(parse_tts_benchmark_args(&warm_limit)
            .unwrap_err()
            .contains("21 requests"));

        let oversized_text = "a".repeat(4_000);
        let oversized_workload = vec![
            "berd-voice".into(),
            "benchmark".into(),
            "tts".into(),
            "--tts-backend".into(),
            "openai".into(),
            "--text".into(),
            oversized_text,
            "--runs".into(),
            "20".into(),
            "--mode".into(),
            "fresh-backend".into(),
            "--allow-paid-openai".into(),
        ];
        assert!(parse_tts_benchmark_args(&oversized_workload)
            .unwrap_err()
            .contains("80000 total UTF-8 text bytes"));
    }

    #[test]
    fn stt_benchmark_cli_is_explicit_and_reuses_engine_validation() {
        assert_eq!(
            parse_stt_benchmark_args(&args(&[
                "berd-voice",
                "benchmark",
                "stt",
                "--stt-backend",
                "macos",
                "--runs",
                "2",
                "--mode",
                "cold",
            ]))
            .unwrap(),
            SttBenchmarkConfig {
                stt: SttBackendConfig::Macos,
                runs: 2,
                mode: SttBenchmarkMode::Cold,
                allow_paid_openai: false,
            }
        );
        assert!(parse_stt_benchmark_args(&args(&[
            "berd-voice",
            "benchmark",
            "stt",
            "--stt-backend",
            "parakeet",
            "--runs",
            "1",
            "--mode",
            "warm",
        ]))
        .unwrap_err()
        .contains("--stt-model-dir is required"));
        assert!(parse_stt_benchmark_args(&args(&[
            "berd-voice",
            "benchmark",
            "stt",
            "--stt-backend",
            "parakeet",
            "--stt-model-dir",
            "relative",
            "--runs",
            "1",
            "--mode",
            "warm",
        ]))
        .unwrap_err()
        .contains("absolute path"));
    }

    #[test]
    fn stt_benchmark_paid_openai_consent_bounds_full_streamed_workload() {
        let base = [
            "berd-voice",
            "benchmark",
            "stt",
            "--stt-backend",
            "openai",
            "--runs",
            "1",
            "--mode",
            "cold",
        ];
        assert!(parse_stt_benchmark_args(&args(&base))
            .unwrap_err()
            .contains("--allow-paid-openai"));

        let pack = load_bundled_stt_fixture_pack().unwrap();
        let allowed = parse_stt_benchmark_args(&args(&[
            "berd-voice",
            "benchmark",
            "stt",
            "--stt-backend",
            "openai",
            "--runs",
            "2",
            "--mode",
            "warm",
            "--allow-paid-openai",
        ]))
        .unwrap();
        validate_stt_benchmark_workload(&allowed, &pack.workload(2, SttBenchmarkMode::Warm))
            .unwrap();

        let too_many_seconds = SttBenchmarkConfig {
            runs: 6,
            mode: SttBenchmarkMode::Cold,
            ..allowed.clone()
        };
        assert!(validate_stt_benchmark_workload(
            &too_many_seconds,
            &pack.workload(6, SttBenchmarkMode::Cold)
        )
        .unwrap_err()
        .contains("232.92 seconds"));

        let too_many_commits = SttBenchmarkConfig {
            runs: 7,
            mode: SttBenchmarkMode::Cold,
            ..allowed
        };
        assert!(validate_stt_benchmark_workload(
            &too_many_commits,
            &pack.workload(7, SttBenchmarkMode::Cold)
        )
        .unwrap_err()
        .contains("21 recognition commits"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires the installed current-locale macOS SpeechTranscriber model"]
    fn local_macos_stt_benchmark_uses_the_production_runtime() {
        let report = create_stt_benchmark_report(&SttBenchmarkConfig {
            stt: SttBackendConfig::Macos,
            runs: 1,
            mode: SttBenchmarkMode::Cold,
            allow_paid_openai: false,
        })
        .unwrap();
        assert!(report.succeeded());
        assert_eq!(report.runs[0].utterances.len(), 3);
    }

    #[test]
    #[ignore = "requires BERD_PARAKEET_TEST_MODEL_DIR with a complete Parakeet bundle"]
    fn local_parakeet_stt_benchmark_uses_the_production_runtime() {
        let model_dir = PathBuf::from(std::env::var("BERD_PARAKEET_TEST_MODEL_DIR").unwrap());
        let report = create_stt_benchmark_report(&SttBenchmarkConfig {
            stt: SttBackendConfig::Parakeet { model_dir },
            runs: 1,
            mode: SttBenchmarkMode::Cold,
            allow_paid_openai: false,
        })
        .unwrap();
        assert!(report.succeeded());
        assert_eq!(report.runs[0].utterances.len(), 3);
    }

    #[test]
    fn siri_tts_and_openai_stt_selection_are_orthogonal() {
        assert_eq!(
            parse_args(&args(&[
                "berd-voice",
                "session",
                "--tts-backend",
                "siri",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
                "--stt-backend",
                "openai"
            ]))
            .unwrap(),
            SessionConfig {
                tts: TtsBackendConfig::Siri {
                    voice: "Aaron".into(),
                    language: "en-US".into(),
                    rate: 1.0
                },
                stt: SttBackendConfig::OpenAi
            }
        );
    }

    #[test]
    fn session_requires_one_inherited_pcm_output_descriptor() {
        assert_eq!(
            parse_pcm_output_fd(&args(&["berd-voice", "session", "--pcm-output-fd", "9"])).unwrap(),
            9
        );
        assert_eq!(
            parse_pcm_output_fd(&args(&["berd-voice", "session"])).unwrap_err(),
            "--pcm-output-fd is required"
        );
        assert!(
            parse_pcm_output_fd(&args(&["berd-voice", "session", "--pcm-output-fd", "2"])).is_err()
        );
        assert!(parse_pcm_output_fd(&args(&[
            "berd-voice",
            "session",
            "--pcm-output-fd",
            "7",
            "--pcm-output-fd",
            "8"
        ]))
        .is_err());
    }

    fn framed(kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::from([b'B', b'V', WIRE_MARKER as u8, kind]);
        frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        frame.extend_from_slice(payload);
        frame
    }

    #[test]
    fn framing_decodes_json_and_exact_pcm_without_line_ambiguity() {
        let json = br#"{"type":"hello","id":1,"input_during_tts":"allow_barge_in"}"#;
        let pcm = [0_u8; PCM_FRAME_BYTES];
        let mut bytes = framed(JSON_FRAME_KIND, json);
        bytes.extend_from_slice(&framed(PCM_FRAME_KIND, &pcm));
        let (control_sender, control_receiver) = mpsc::channel();
        let (pcm_sender, pcm_receiver) = mpsc::sync_channel(3);

        read_framed_requests(Cursor::new(bytes), control_sender, pcm_sender);

        assert!(matches!(
            control_receiver.recv().unwrap().input,
            Input::Request(SessionRequest::Hello { id: 1, .. })
        ));
        assert!(pcm_receiver.recv().is_ok());
        assert!(matches!(control_receiver.recv().unwrap().input, Input::Eof));
    }

    #[test]
    fn disconnected_pcm_channel_does_not_overtake_queued_control() {
        let (control_sender, control_receiver) = mpsc::channel();
        let (pcm_sender, pcm_receiver) = mpsc::sync_channel(1);
        control_sender
            .send(OrderedControl {
                after_pcm: 0,
                input: Input::Request(SessionRequest::Shutdown),
            })
            .unwrap();
        drop(control_sender);
        drop(pcm_sender);

        let mut pending = None;
        let mut processed = 0;
        assert!(matches!(
            receive_session_input(
                &control_receiver,
                &pcm_receiver,
                &mut pending,
                &mut processed
            ),
            Some(Input::Request(SessionRequest::Shutdown))
        ));
    }

    #[test]
    fn framing_rejects_oversized_json_and_wrong_pcm_before_payload_allocation() {
        for (kind, length, expected) in [
            (JSON_FRAME_KIND, MAX_LINE_BYTES + 1, "request exceeds 1 MiB"),
            (PCM_FRAME_KIND, PCM_FRAME_BYTES - 1, "PCM frame has"),
        ] {
            let mut header = Vec::from([b'B', b'V', WIRE_MARKER as u8, kind]);
            header.extend_from_slice(&(length as u32).to_le_bytes());
            let (control_sender, control_receiver) = mpsc::channel();
            let (pcm_sender, _pcm_receiver) = mpsc::sync_channel(1);
            read_framed_requests(Cursor::new(header), control_sender, pcm_sender);
            let Input::Invalid(message) = control_receiver.recv().unwrap().input else {
                panic!("invalid frame must be terminal")
            };
            assert!(message.contains(expected));
            assert!(control_receiver.try_recv().is_err());
        }
    }

    #[test]
    fn first_pcm_queue_overflow_is_terminal_without_blocking_the_reader() {
        let pcm = [0_u8; PCM_FRAME_BYTES];
        let mut bytes = framed(PCM_FRAME_KIND, &pcm);
        bytes.extend_from_slice(&framed(PCM_FRAME_KIND, &pcm));
        let (control_sender, control_receiver) = mpsc::channel();
        let (pcm_sender, pcm_receiver) = mpsc::sync_channel(1);

        read_framed_requests(Cursor::new(bytes), control_sender, pcm_sender);

        assert!(pcm_receiver.recv().is_ok());
        let control = control_receiver.recv().unwrap();
        assert_eq!(control.after_pcm, 1);
        let Input::Invalid(message) = control.input else {
            panic!("queue discontinuity must be terminal")
        };
        assert_eq!(message, "session PCM input queue is full");
        assert!(control_receiver.try_recv().is_err());
    }

    #[test]
    fn input_policy_update_requires_a_positive_expected_revision() {
        let request = SessionRequest::SetInputDuringTts {
            id: 9,
            expected_revision: 0,
            policy: InputDuringTtsPolicy::SuppressInput,
        };

        assert_eq!(
            validate_request(request).unwrap_err(),
            "expected input-during-TTS revision must be positive"
        );
    }

    #[test]
    fn ready_requires_the_runtime_ready_event() {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        sender.blocking_send(VoiceInputEvent::Ready).unwrap();
        assert_eq!(
            wait_for_input_ready(&mut receiver, Duration::from_secs(1)),
            Ok(())
        );

        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        sender
            .blocking_send(VoiceInputEvent::Failed("not ready".into()))
            .unwrap();
        assert_eq!(
            wait_for_input_ready(&mut receiver, Duration::from_secs(1)),
            Err("not ready".into())
        );
    }

    #[test]
    fn stalled_input_startup_reaches_a_bounded_terminal_failure() {
        let (_sender, mut receiver) = tokio::sync::mpsc::channel(1);

        assert_eq!(
            wait_for_input_ready(&mut receiver, Duration::from_millis(10)),
            Err("voice input readiness timed out".into())
        );
    }

    #[test]
    fn held_prepare_waits_for_pending_to_clear_without_a_timeout() {
        let mut core = SessionCore::default();
        core.set_recognition_pending(true);
        let input_policy = test_input_policy_slot();
        let mut active = None;
        let mut held = None;
        let mut output = Vec::new();
        process_prepare(
            PrepareRequest {
                id: 4,
                acknowledgement: None,
                text: "reply".into(),
            },
            &mut core,
            &test_tts_slot(),
            &input_policy,
            &mut active,
            &mut held,
            &mut output,
        )
        .unwrap();
        assert!(held.is_some());
        assert!(output.is_empty());

        input_policy
            .update(1, InputDuringTtsPolicy::SuppressInput)
            .unwrap();
        core.set_recognition_pending(false);
        reevaluate_held(
            &mut held,
            &mut core,
            Some(&test_tts_slot()),
            Some(&input_policy),
            &mut active,
            &mut output,
        )
        .unwrap();
        assert_eq!(messages(&output)[0]["type"], "admitted");
        assert_eq!(
            active.as_ref().unwrap().input_during_tts.policy,
            InputDuringTtsPolicy::SuppressInput
        );
    }

    #[test]
    fn admission_leases_configuration_before_a_later_atomic_update() {
        let slot = test_tts_slot();
        let input_policy = test_input_policy_slot();
        let mut core = SessionCore::default();
        let mut active = None;
        let mut held = None;
        let mut output = Vec::new();
        process_prepare(
            PrepareRequest {
                id: 4,
                acknowledgement: None,
                text: "old voice".into(),
            },
            &mut core,
            &slot,
            &input_policy,
            &mut active,
            &mut held,
            &mut output,
        )
        .unwrap();
        let old_revision = active.as_ref().unwrap().tts.snapshot().revision;
        let leased_input_policy = active.as_ref().unwrap().input_during_tts;
        let replacement = slot
            .prepare_replacement(
                1,
                berd_voice::TtsSettings::OpenAi {
                    model: "test-model".into(),
                    voice: "next-voice".into(),
                    rate: 2.0,
                },
            )
            .unwrap();
        let applied = slot.commit_replacement(replacement).unwrap();
        let applied_input_policy = input_policy
            .update(1, InputDuringTtsPolicy::SuppressInput)
            .unwrap();

        assert_eq!(old_revision, 1);
        assert_eq!(active.as_ref().unwrap().tts.snapshot().revision, 1);
        assert_eq!(leased_input_policy.revision, 1);
        assert_eq!(
            leased_input_policy.policy,
            InputDuringTtsPolicy::AllowBargeIn
        );
        assert_eq!(
            active.as_ref().unwrap().input_during_tts,
            leased_input_policy
        );
        assert_eq!(applied_input_policy.revision, 2);
        assert_eq!(
            active.as_ref().unwrap().tts.snapshot().settings.voice(),
            "test-voice"
        );
        assert_eq!(applied.revision, 2);
        assert_eq!(
            slot.lease().unwrap().snapshot().settings.voice(),
            "next-voice"
        );
    }

    fn prepared_tts_event(
        slot: &ConfiguredTtsSlot,
        attempt: u64,
        id: u64,
        voice: &str,
    ) -> TtsConfigurationEvent {
        TtsConfigurationEvent {
            attempt,
            id,
            result: slot.prepare_replacement(
                1,
                berd_voice::TtsSettings::OpenAi {
                    model: "test-model".into(),
                    voice: voice.into(),
                    rate: 2.0,
                },
            ),
        }
    }

    #[test]
    fn tts_update_before_deadline_applies_once() {
        let slot = test_tts_slot();
        let (sender, receiver) = mpsc::channel();
        let now = Instant::now();
        let mut active = Some(ActiveTtsConfigurationUpdate {
            attempt: 9,
            id: 4,
            deadline: now + Duration::from_secs(1),
        });
        sender
            .send(prepared_tts_event(&slot, 9, 4, "next"))
            .unwrap();
        let mut output = Vec::new();

        poll_tts_configuration_update(now, &receiver, Some(&slot), &mut active, &mut output)
            .unwrap();

        assert!(active.is_none());
        assert_eq!(slot.snapshot().unwrap().revision, 2);
        assert_eq!(messages(&output).len(), 1);
        assert_eq!(messages(&output)[0]["outcome"], "applied");
    }

    #[test]
    fn tts_update_at_deadline_rejects_once_and_ignores_late_attempt() {
        let slot = test_tts_slot();
        let (sender, receiver) = mpsc::channel();
        let deadline = Instant::now();
        let mut active = Some(ActiveTtsConfigurationUpdate {
            attempt: 9,
            id: 4,
            deadline,
        });
        sender
            .send(prepared_tts_event(&slot, 9, 4, "too-late"))
            .unwrap();
        let mut output = Vec::new();

        poll_tts_configuration_update(deadline, &receiver, Some(&slot), &mut active, &mut output)
            .unwrap();
        poll_tts_configuration_update(
            deadline + Duration::from_secs(1),
            &receiver,
            Some(&slot),
            &mut active,
            &mut output,
        )
        .unwrap();

        assert!(active.is_none());
        assert_eq!(slot.snapshot().unwrap().revision, 1);
        assert_eq!(messages(&output).len(), 1);
        assert_eq!(messages(&output)[0]["outcome"], "rejected");
        assert_eq!(
            messages(&output)[0]["message"],
            "TTS configuration update timed out"
        );
    }

    #[test]
    fn shutdown_rejects_once_and_generation_blocks_a_reused_client_id() {
        let slot = test_tts_slot();
        let (sender, receiver) = mpsc::channel();
        let mut active = Some(ActiveTtsConfigurationUpdate {
            attempt: 9,
            id: 4,
            deadline: Instant::now() + Duration::from_secs(1),
        });
        sender
            .send(prepared_tts_event(&slot, 9, 4, "old-attempt"))
            .unwrap();
        let mut output = Vec::new();

        reject_tts_configuration_update(
            &mut active,
            Some(&slot),
            "session is shutting down",
            &mut output,
        )
        .unwrap();
        active = Some(ActiveTtsConfigurationUpdate {
            attempt: 10,
            id: 4,
            deadline: Instant::now() + Duration::from_secs(1),
        });
        poll_tts_configuration_update(
            Instant::now(),
            &receiver,
            Some(&slot),
            &mut active,
            &mut output,
        )
        .unwrap();

        assert_eq!(slot.snapshot().unwrap().revision, 1);
        assert_eq!(messages(&output).len(), 1);
        assert_eq!(messages(&output)[0]["outcome"], "rejected");
        assert_eq!(messages(&output)[0]["message"], "session is shutting down");
        assert_eq!(active.unwrap().attempt, 10);
    }

    #[test]
    fn targeted_cancel_orders_result_before_terminal_and_repeats_as_stale() {
        let mut core = SessionCore::default();
        let PrepareOutcome::Admitted {
            speech_id, text, ..
        } = core.prepare(PrepareRequest {
            id: 7,
            acknowledgement: None,
            text: "reply".into(),
        })
        else {
            panic!("test speech must be admitted")
        };
        let mut active = Some(ActivePlayback {
            prepare_id: 7,
            speech_id,
            text,
            output: None,
            active: None,
            ready_deadline: Instant::now() + Duration::from_secs(2),
            assistant_activity: None,
            input_during_tts: test_input_policy(),
            tts: test_tts_lease(),
            suspension_requested: false,
        });
        let mut held = None;
        let mut output = Vec::new();

        handle_cancel(7, &mut held, &mut core, &mut active, &mut output).unwrap();
        handle_cancel(7, &mut held, &mut core, &mut active, &mut output).unwrap();

        assert_eq!(
            messages(&output),
            [
                json!({"type":"cancel_result","id":7,"outcome":"cancelled","speech_id":1}),
                json!({"type":"speech_interrupted","id":7,"speech_id":1,"spoken_through_utf8":0}),
                json!({"type":"cancel_result","id":7,"outcome":"stale","speech_id":null}),
            ]
        );
    }

    #[test]
    fn output_ready_installs_leased_suppression_before_acknowledgement() {
        let mut core = SessionCore::default();
        let mut current = active_playback(&mut core);
        current.active = None;
        current.input_during_tts = InputDuringTtsSnapshot {
            revision: 2,
            policy: InputDuringTtsPolicy::SuppressInput,
        };
        let controls = VoiceInputControls::default();
        let mut writer = InputStateWriter {
            controls: &controls,
            expected_muted: true,
            bytes: Vec::new(),
        };

        acknowledge_output_ready(&mut current, Some(&controls), &mut writer).unwrap();

        assert!(current.assistant_activity.is_some());
        assert_eq!(
            messages(&writer.bytes),
            [json!({
                "type":"output_ready_result",
                "id":7,
                "speech_id":1,
                "outcome":"accepted"
            })]
        );
    }

    #[test]
    fn terminal_clears_suppression_before_publishing_completion() {
        let mut core = SessionCore::default();
        let mut current = active_playback(&mut core);
        current.input_during_tts = InputDuringTtsSnapshot {
            revision: 2,
            policy: InputDuringTtsPolicy::SuppressInput,
        };
        let controls = VoiceInputControls::default();
        let mut ignored = Vec::new();
        acknowledge_output_ready(&mut current, Some(&controls), &mut ignored).unwrap();
        assert!(controls.is_muted());
        let speech_id = current.speech_id;
        let mut active = Some(current);
        let mut writer = InputStateWriter {
            controls: &controls,
            expected_muted: false,
            bytes: Vec::new(),
        };

        handle_playback_event(
            PlaybackEvent::Completed(speech_id),
            &mut core,
            &mut active,
            &mut writer,
        )
        .unwrap();

        assert!(active.is_none());
        assert_eq!(messages(&writer.bytes)[0]["type"], "speech_completed");
    }

    #[test]
    fn unquiesced_output_failure_terminates_the_session_after_its_speech_terminal() {
        let mut core = SessionCore::default();
        let current = active_playback(&mut core);
        let speech_id = current.speech_id;
        let mut active = Some(current);
        let mut output = Vec::new();

        let error = handle_playback_event(
            PlaybackEvent::Failed(speech_id, "output failed".into(), false),
            &mut core,
            &mut active,
            &mut output,
        )
        .unwrap_err();

        assert_eq!(
            error,
            "remote PCM output did not reach a quiescent terminal"
        );
        assert!(active.is_none());
        assert_eq!(messages(&output)[0]["type"], "speech_failed");
    }

    #[test]
    fn query_state_returns_authoritative_confirmation_and_order() {
        let mut core = SessionCore::default();
        core.add_final(4, "one".into()).unwrap();
        core.add_final(9, "two".into()).unwrap();
        assert!(matches!(
            core.prepare(PrepareRequest {
                id: 5,
                acknowledgement: Some(9),
                text: "reply".into(),
            }),
            PrepareOutcome::Admitted { .. }
        ));
        let mut output = Vec::new();

        write_state(&mut output, 6, 4, &core).unwrap();

        assert_eq!(
            messages(&output),
            [json!({
                "type":"state",
                "id":6,
                "confirmed_token":9,
                "utterances_after":[{"token":9,"text":"two"}]
            })]
        );
    }

    #[test]
    fn runtime_final_is_stored_then_published_then_interrupts_output() {
        let mut core = SessionCore::default();
        let PrepareOutcome::Admitted {
            speech_id, text, ..
        } = core.prepare(PrepareRequest {
            id: 7,
            acknowledgement: None,
            text: "reply".into(),
        })
        else {
            panic!("test speech admitted")
        };
        let mut active = Some(ActivePlayback {
            prepare_id: 7,
            speech_id,
            text,
            output: None,
            active: None,
            ready_deadline: Instant::now() + Duration::from_secs(2),
            assistant_activity: None,
            input_during_tts: test_input_policy(),
            tts: test_tts_lease(),
            suspension_requested: false,
        });
        let mut next_token = 1;
        let mut output = Vec::new();
        let stored = AtomicBool::new(false);
        core.set_recognition_pending(true);
        active.as_mut().unwrap().suspension_requested = true;

        store_and_publish_voice_final(
            "hello".into(),
            || stored.store(true, Ordering::SeqCst),
            &mut core,
            &mut active,
            &mut next_token,
            &mut output,
        )
        .unwrap();

        assert!(stored.load(Ordering::SeqCst));
        assert_eq!(
            messages(&output)
                .iter()
                .map(|message| message["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["user_final", "speech_interrupted"]
        );
        assert_eq!(core.utterances_after(0)[0].token, 1);
    }

    #[test]
    fn runtime_pending_provisionally_holds_reserved_output_without_a_terminal() {
        let mut core = SessionCore::default();
        let PrepareOutcome::Admitted {
            speech_id, text, ..
        } = core.prepare(PrepareRequest {
            id: 7,
            acknowledgement: None,
            text: "reply".into(),
        })
        else {
            panic!("test speech admitted")
        };
        let mut active = Some(ActivePlayback {
            prepare_id: 7,
            speech_id,
            text,
            output: None,
            active: None,
            ready_deadline: Instant::now() + Duration::from_secs(2),
            assistant_activity: None,
            input_during_tts: test_input_policy(),
            tts: test_tts_lease(),
            suspension_requested: false,
        });
        let mut next_token = 1;
        let mut output = Vec::new();

        handle_voice_input_event(
            VoiceInputEvent::RecognitionPendingChanged(true),
            &mut core,
            &mut active,
            &mut next_token,
            &mut output,
        )
        .unwrap();

        assert_eq!(
            messages(&output)
                .iter()
                .map(|message| message["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["recognition_pending"]
        );
        assert!(core.recognition_pending());
        assert!(active.unwrap().suspension_requested);
    }

    #[test]
    fn final_then_pending_settlement_never_requests_resume() {
        let mut core = SessionCore::default();
        let mut current = active_playback(&mut core);
        let speech_id = current.speech_id;
        let (child, _host) = UnixStream::pair().unwrap();
        let transport = unsafe { AudioPipeTransport::from_raw_fd(child.into_raw_fd()) }.unwrap();
        let (control_sender, control_receiver) = mpsc::channel();
        current.output = Some(Arc::new(
            RemotePcmAudioOutput::new(
                speech_id,
                LongRemoteTts.pcm_spec(),
                Arc::new(transport),
                current.active.as_ref().unwrap().clone(),
                control_sender,
            )
            .unwrap(),
        ));
        let mut active = Some(current);
        let mut next_token = 1;
        let mut output = Vec::new();
        handle_voice_input_event(
            VoiceInputEvent::RecognitionPendingChanged(true),
            &mut core,
            &mut active,
            &mut next_token,
            &mut output,
        )
        .unwrap();
        assert!(matches!(
            control_receiver.recv_timeout(Duration::from_millis(30)),
            Ok(AudioOutputControlRequest::Suspend { .. })
        ));

        store_and_publish_voice_final(
            "real words".into(),
            || {},
            &mut core,
            &mut active,
            &mut next_token,
            &mut output,
        )
        .unwrap();
        handle_voice_input_event(
            VoiceInputEvent::RecognitionPendingChanged(false),
            &mut core,
            &mut active,
            &mut next_token,
            &mut output,
        )
        .unwrap();

        assert!(control_receiver.try_recv().is_err());
        assert!(!active
            .as_ref()
            .unwrap()
            .active
            .as_ref()
            .unwrap()
            .load(Ordering::SeqCst));
    }

    #[test]
    fn host_mute_and_reset_discard_only_a_provisional_hold() {
        for reset in [false, true] {
            let mut core = SessionCore::default();
            let mut active = Some(active_playback(&mut core));
            active.as_mut().unwrap().active = None;
            active.as_mut().unwrap().suspension_requested = true;
            let controls = VoiceInputControls::default();
            let mut output = Vec::new();
            if reset {
                handle_reset_input(9, &controls, &mut core, &mut active, &mut output).unwrap();
            } else {
                handle_input_muted(9, true, &controls, &mut core, &mut active, &mut output)
                    .unwrap();
            }
            assert!(active.is_none());
            assert_eq!(
                messages(&output)
                    .iter()
                    .map(|message| message["type"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                if reset {
                    vec!["input_reset_applied", "speech_interrupted"]
                } else {
                    vec!["input_mute_applied", "speech_interrupted"]
                }
            );
        }

        let mut core = SessionCore::default();
        let mut active = Some(active_playback(&mut core));
        let controls = VoiceInputControls::default();
        let mut output = Vec::new();
        handle_input_muted(10, true, &controls, &mut core, &mut active, &mut output).unwrap();
        assert!(active.is_some());
        assert_eq!(messages(&output)[0]["type"], "input_mute_applied");
    }

    #[test]
    fn input_control_acknowledgements_are_exact() {
        assert_eq!(
            serde_json::to_value(SessionMessage::InputMuteApplied {
                id: 8,
                active: true
            })
            .unwrap(),
            serde_json::json!({"type":"input_mute_applied","id":8,"active":true})
        );
        assert_eq!(
            serde_json::to_value(SessionMessage::InputResetApplied { id: 9 }).unwrap(),
            serde_json::json!({"type":"input_reset_applied","id":9})
        );
    }

    #[test]
    fn backend_neutral_playback_starts_only_after_initial_pcm_is_accepted() {
        let backend = FakeTts {
            frames: vec![0.1, 0.2],
        };
        let output = FakeOutput::default();
        let active = AtomicBool::new(true);
        let (sender, receiver) = mpsc::channel();
        assert!(synthesize_to_output(9, "hi", &backend, &output, &active, &sender).unwrap());
        assert!(matches!(receiver.try_recv(), Ok(PlaybackEvent::Started(9))));
        assert_eq!(*output.frames.lock().unwrap(), [0.1, 0.2]);
    }

    #[test]
    fn backend_neutral_playback_cancels_without_start_when_authority_is_absent() {
        let backend = FakeTts { frames: vec![0.1] };
        let output = FakeOutput::default();
        let active = AtomicBool::new(false);
        let (sender, receiver) = mpsc::channel();
        assert!(!synthesize_to_output(9, "hi", &backend, &output, &active, &sender).unwrap());
        assert!(receiver.try_recv().is_err());
        assert!(output.cancelled.load(Ordering::SeqCst));
        assert!(output.frames.lock().unwrap().is_empty());
    }

    #[test]
    fn cancellation_during_output_drain_returns_an_interruption_promptly() {
        let backend = FakeTts {
            frames: vec![0.1, 0.2],
        };
        let output = BlockingOutput {
            cancelled: AtomicBool::new(false),
        };
        let active = AtomicBool::new(true);
        let (sender, receiver) = mpsc::channel();
        std::thread::scope(|scope| {
            let active_ref = &active;
            scope.spawn(move || {
                assert!(matches!(receiver.recv(), Ok(PlaybackEvent::Started(9))));
                active_ref.store(false, Ordering::SeqCst);
            });
            assert!(!synthesize_to_output(9, "hi", &backend, &output, &active, &sender).unwrap());
        });
        assert!(output.cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn shutdown_drains_started_before_interrupted_terminal() {
        let mut core = SessionCore::default();
        let mut active = Some(active_playback(&mut core));
        let speech_id = active.as_ref().unwrap().speech_id;
        let mut output = Vec::new();
        interrupt_active(&mut core, &mut active, &mut output).unwrap();
        let (sender, receiver) = mpsc::channel();
        sender.send(PlaybackEvent::Started(speech_id)).unwrap();
        sender
            .send(PlaybackEvent::Interrupted(speech_id, 0))
            .unwrap();

        finish_shutdown_playback(
            &receiver,
            &mut core,
            &mut active,
            &mut output,
            Duration::from_millis(10),
        )
        .unwrap();

        assert!(active.is_none());
        assert_eq!(
            messages(&output)
                .iter()
                .map(|message| message["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["speech_started", "speech_interrupted"]
        );
    }

    #[test]
    fn shutdown_timeout_emits_terminal_failure_and_clears_state() {
        let mut core = SessionCore::default();
        let mut active = Some(active_playback(&mut core));
        let (_sender, receiver) = mpsc::channel();
        let mut output = Vec::new();
        finish_shutdown_playback(
            &receiver,
            &mut core,
            &mut active,
            &mut output,
            Duration::ZERO,
        )
        .unwrap();
        assert!(active.is_none());
        assert_eq!(messages(&output)[0]["type"], "speech_failed");
    }

    #[test]
    fn shutdown_worker_disconnect_emits_terminal_failure_and_clears_state() {
        let mut core = SessionCore::default();
        let mut active = Some(active_playback(&mut core));
        let (sender, receiver) = mpsc::channel();
        drop(sender);
        let mut output = Vec::new();
        finish_shutdown_playback(
            &receiver,
            &mut core,
            &mut active,
            &mut output,
            Duration::from_secs(1),
        )
        .unwrap();
        assert!(active.is_none());
        let failure = &messages(&output)[0];
        assert_eq!(failure["type"], "speech_failed");
        assert_eq!(
            failure["message"],
            "playback worker disconnected during shutdown"
        );
    }
}
