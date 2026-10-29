use std::collections::HashSet;
use std::io::{self, BufWriter, Read, Write};
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::{self, Receiver, SyncSender},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use berd_call::benchmark::{
    benchmark_stt, benchmark_tts, benchmark_tts_manifest, load_bundled_stt_fixture_pack,
    load_bundled_tts_prompt_manifest, SttBenchmarkEnvironment, SttBenchmarkMode,
    SttBenchmarkTarget, TtsBenchmarkMode, TtsBenchmarkPromptManifest, TtsBenchmarkTarget,
};
use berd_call::endpoint_url::{is_allowed_endpoint_url, EndpointProtocol};
use berd_call::input::{
    AssistantActivityGuard, InputDuringTtsPolicy, InputDuringTtsSlot, InputDuringTtsSnapshot,
    VoiceInputConfig, VoiceInputControls, VoiceInputEngineConfig, VoiceInputEvent, VoiceInputFrame,
    VoiceInputRuntime, INPUT_FRAME_SAMPLES,
};
use berd_call::protocol::{
    CancelOutcome, InputDuringTtsOutcome, NotAdmittedReason, OutputReadyOutcome, SessionMessage,
    SessionRequest, TtsSettingsOutcome, VoiceSessionSnapshot,
};
use berd_call::session::{PrepareOutcome, PrepareRequest, SessionCore};
use berd_call::ManagedStatusSoundRuntime;
use berd_call::{
    estimated_spoken_through_utf8,
    local_assets::{
        LocalAssetLockError, LocalAssetRoots, LocalInstallError, LocalInstallErrorKind,
        LocalInstallPhase, LocalInstallProgress,
    },
    ConfiguredTtsSlot, DeliveryProgress, TtsBackend, TtsConfiguration, TtsConfigurationLease,
    TtsConfigurationRejection, TtsConfigurationRejectionKind, TtsSettings, WavSynthesisErrorKind,
    DEFAULT_VAD_THRESHOLD,
};
use serde::Serialize;

mod cli_help;
#[cfg(target_os = "macos")]
mod codex;
mod host_control;
#[cfg(unix)]
mod host_lifetime;
#[cfg(target_os = "macos")]
mod host_session;
#[cfg(target_os = "macos")]
mod menu_bar;
#[cfg(any(target_os = "macos", test))]
mod microphone_recovery;
mod saved_settings;
mod session_audio;
mod session_framing;
#[cfg(target_os = "macos")]
mod system_input_mute;

use session_audio::{
    AudioHostAck, AudioOutputControlRequest, AudioPipeTransport, RemotePcmAudioOutput,
    AUDIO_CANCELLED, AUDIO_HOST_FAILED,
};

use session_framing::{
    FRAME_HEADER_BYTES, FRAME_MAGIC, FRAME_MARKER as INPUT_FRAME_MARKER, JSON_FRAME_KIND,
    PCM_FRAME_KIND, SESSION_PROTOCOL_VERSION,
};

const MAX_LINE_BYTES: usize = 1024 * 1024;
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
    /// A speech request whose voice is now built.
    VoiceBuilt(SessionRequest),
    /// A speech request's voice could not be built.
    VoiceUnavailable {
        id: u64,
        voice: String,
        message: String,
    },
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
    result: Result<berd_call::TtsConfigurationReplacement, TtsConfigurationRejection>,
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
    stt_hints: Vec<String>,
    endpoints: SessionEndpointOverrides,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct SessionEndpointOverrides {
    tts: Option<String>,
    stt: Option<String>,
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

#[derive(Clone, Debug, PartialEq)]
enum ManagementCommand {
    ListVoices {
        language: Option<String>,
    },
    DownloadVoice {
        identity: berd_call::siri::SiriVoiceIdentity,
        availability_wait: berd_call::siri::SiriDownloadAvailabilityWait,
    },
    PreviewVoice {
        identity: berd_call::siri::SiriVoiceIdentity,
        rate: f32,
    },
    MacosModelStatus,
    InstallMacosModel,
    PocketModelStatus {
        roots: LocalAssetRoots,
    },
    InstallPocketModel {
        roots: LocalAssetRoots,
    },
    ListOpenAiVoices,
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
            Self::PreviewVoice { .. } => "voices.preview",
            Self::MacosModelStatus => "models.macos.status",
            Self::InstallMacosModel => "models.macos.install",
            Self::PocketModelStatus { .. } => "models.pocket.status",
            Self::InstallPocketModel { .. } => "models.pocket.install",
            Self::ListOpenAiVoices => "models.openai.voices",
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
            Self::Pocket => berd_call::pocket_assets::MODEL_ID,
            Self::Parakeet => berd_call::parakeet_assets::MODEL_ID,
        }
    }

    fn total_download_bytes(self) -> u64 {
        match self {
            Self::Pocket => berd_call::pocket_assets::download_bytes(),
            Self::Parakeet => berd_call::parakeet_assets::download_bytes(),
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
struct OpenAiVoicesResult {
    backend: &'static str,
    voices: &'static [&'static str],
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
    voices: Vec<berd_call::siri::SiriVoice>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceDownloadResult {
    backend: &'static str,
    voice: berd_call::siri::SiriVoiceIdentity,
    installed: bool,
    availability_wait_seconds: u64,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoicePreviewResult {
    backend: &'static str,
    voice: berd_call::siri::SiriVoiceIdentity,
    rate: f32,
    source: berd_call::siri::SiriPreviewSource,
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
    match cli_help::parse(&args).unwrap_or_else(|error| usage_error(&error, &args)) {
        Some(cli_help::MetaCommand::Help(help)) => {
            println!("{help}");
            return;
        }
        Some(cli_help::MetaCommand::Version) => {
            println!("berd-call {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        None => {}
    }
    match args.get(1).map(String::as_str) {
        Some("start") => {
            let options = parse_or_exit(parse_saved_start_args(&args), &args);
            #[cfg(target_os = "macos")]
            if let Err(error) = host_lifetime::route_stop_signals(options.port) {
                eprintln!("berd-call start failed: {error}");
                std::process::exit(1);
            }
            #[cfg(target_os = "macos")]
            let _update_guard = guard_and_request_update();
            #[cfg(target_os = "macos")]
            if let Err(error) = menu_bar::run(options) {
                eprintln!("berd-call start failed: {error}");
                std::process::exit(1);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = options;
                eprintln!("berd-call start is supported only on macOS");
                std::process::exit(1);
            }
        }
        Some("speak") => {
            let SpeakOptions {
                port,
                acknowledgement,
                voice,
                language,
                text,
            } = parse_or_exit(parse_speak_control_args(&args), &args);
            let response = host_control::request(
                port,
                host_control::ControlRequest::Speak {
                    text,
                    acknowledgement,
                    voice,
                    language,
                },
            )
            .unwrap_or_else(|error| operational_error("speak", error));
            print_pretty_json(&response).unwrap_or_else(|error| operational_error("speak", error));
        }
        Some("status") => {
            let port = parse_or_exit(parse_control_port(&args), &args);
            let response = host_control::request(port, host_control::ControlRequest::Status)
                .unwrap_or_else(|error| operational_error("status", error));
            print_pretty_json(&response).unwrap_or_else(|error| operational_error("status", error));
        }
        Some(operation @ ("catch-up" | "wait-for-input")) => {
            let (port, request) = parse_or_exit(
                parse_poll_input_args(operation == "wait-for-input", &args),
                &args,
            );
            let response = host_control::request(port, request)
                .unwrap_or_else(|error| operational_error(operation, error));
            print_pretty_json(&response)
                .unwrap_or_else(|error| operational_error(operation, error));
        }
        Some("settings") => {
            let (port, request) = parse_or_exit(parse_host_settings_args(&args), &args);
            let response = host_control::request(port, request)
                .unwrap_or_else(|error| operational_error("settings", error));
            print_pretty_json(&response)
                .unwrap_or_else(|error| operational_error("settings", error));
        }
        Some("stop") => {
            let port = parse_or_exit(parse_control_port(&args), &args);
            let response = host_control::request(port, host_control::ControlRequest::Stop)
                .unwrap_or_else(|error| operational_error("stop", error));
            print_pretty_json(&response).unwrap_or_else(|error| operational_error("stop", error));
        }
        Some("session") => {
            // A host blocks its stop signals, and the session inherits that mask.
            unsafe {
                let mut signals = std::mem::zeroed::<libc::sigset_t>();
                libc::sigemptyset(&mut signals);
                libc::pthread_sigmask(libc::SIG_SETMASK, &signals, std::ptr::null_mut());
            }
            let config = parse_or_exit(parse_args(&args), &args);
            let pcm_output_fd = parse_or_exit(parse_pcm_output_fd(&args), &args);
            if let Err(error) = run_session(config, pcm_output_fd) {
                eprintln!("berd-call session failed: {error}");
                std::process::exit(1);
            }
        }
        Some("benchmark") if args.get(2).map(String::as_str) == Some("tts") => {
            let config = parse_or_exit(parse_tts_benchmark_args(&args), &args);
            if let Err(error) = run_tts_benchmark(config) {
                eprintln!("berd-call benchmark tts failed: {error}");
                std::process::exit(1);
            }
        }
        Some("benchmark") if args.get(2).map(String::as_str) == Some("stt") => {
            let config = parse_or_exit(parse_stt_benchmark_args(&args), &args);
            if let Err(error) = run_stt_benchmark(config) {
                eprintln!("berd-call benchmark stt failed: {error}");
                std::process::exit(1);
            }
        }
        Some("synthesize") => {
            let config = parse_or_exit(parse_synthesis_args(&args), &args);
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
                        eprintln!("berd-call could not write synthesis error: {error}");
                    }
                }
                eprintln!("berd-call synthesize failed: {}", failure.detail);
                std::process::exit(1);
            }
        }
        Some("voices" | "models") if args.get(2).is_some_and(|value| is_help_flag(value)) => {
            help_and_exit(&args)
        }
        Some("voices" | "models") => {
            let command = parse_or_exit(parse_management_args(&args), &args);
            let operation = command.operation();
            if let Err(failure) = run_management_command(command) {
                if failure.code == "output_failed" {
                    eprintln!("berd-call {operation} failed: {}", failure.detail);
                    std::process::exit(1);
                }
                let envelope = management_error_envelope(operation, &failure);
                if let Err(error) = write_json_line(io::stdout().lock(), &envelope) {
                    eprintln!("berd-call could not write management error: {error}");
                }
                eprintln!("berd-call {operation} failed: {}", failure.detail);
                std::process::exit(1);
            }
        }
        Some("benchmark") if args.get(2).is_some_and(|value| is_help_flag(value)) => {
            help_and_exit(&args)
        }
        Some("benchmark") => match args.get(2) {
            Some(command) => {
                usage_error(&format!("unrecognized benchmark command: {command}"), &args)
            }
            None => usage_error("benchmark requires tts or stt", &args),
        },
        Some(command) => usage_error(&format!("unrecognized command: {command}"), &args),
        None => usage_error("a command is required", &args),
    }
}

#[cfg(target_os = "macos")]
fn resolved_executable_path(executable: &Path) -> PathBuf {
    // Replacement may briefly remove the executable after this process has
    // started. The symlink target or original path still identifies its bundle.
    if let Ok(path) = executable.canonicalize() {
        return path;
    }
    match std::fs::read_link(executable) {
        Ok(target) if target.is_absolute() => target,
        Ok(target) => executable
            .parent()
            .map(|parent| parent.join(target))
            .unwrap_or_else(|| executable.to_path_buf()),
        Err(_) => executable.to_path_buf(),
    }
}

#[cfg(target_os = "macos")]
fn bundled_app_path(executable: &Path) -> Option<PathBuf> {
    let executable = resolved_executable_path(executable);
    if executable.file_name()?.to_str()? != "berd-call" {
        return None;
    }
    let macos = executable.parent()?;
    if macos.file_name()?.to_str()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()?.to_str()? != "Contents" {
        return None;
    }
    let app = contents.parent()?;
    (app.file_name()?.to_str()? == "Berd.app").then(|| app.to_path_buf())
}

#[cfg(target_os = "macos")]
fn guard_and_request_update() -> Option<std::fs::File> {
    use std::os::unix::process::CommandExt;
    let executable = resolved_executable_path(&std::env::current_exe().ok()?);
    let guard = match berd_call::update_guard::hold_call() {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("berd-call could not guard updates during this call: {error}");
            return None;
        }
    };
    if let Some(app_path) = bundled_app_path(&executable) {
        request_bundled_app_update(&app_path);
    } else if std::env::var("BERD_CALL_AUTO_UPDATE").as_deref() != Ok("0") {
        if let Some(helper) = standalone_update_helper(&executable) {
            match std::process::Command::new("/bin/bash")
                .arg(helper)
                .process_group(0)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(mut child) => {
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                }
                Err(error) => eprintln!("berd-call could not check standalone updates: {error}"),
            }
        }
    }
    Some(guard)
}

// A managed standalone install has its helper and metadata beside the binary.
// Every app bundle, including Buzz, keeps ownership of its own executable.
#[cfg(any(target_os = "macos", test))]
fn standalone_update_helper(executable: &Path) -> Option<PathBuf> {
    if executable.file_name()?.to_str()? != "berd-call"
        || executable
            .ancestors()
            .any(|path| path.extension().is_some_and(|ext| ext == "app"))
    {
        return None;
    }
    let root = executable.parent()?.join(".berd-call");
    let helper = root.join("update");
    (root.join("installed").is_file() && helper.is_file()).then_some(helper)
}

#[cfg(target_os = "macos")]
fn request_bundled_app_update(app_path: &Path) {
    // `open -g` returns promptly and routes the URL to an already-running app,
    // or starts this same bundle in the background. Berd owns update trust.
    match std::process::Command::new("/usr/bin/open")
        .arg("-g")
        .arg("-a")
        .arg(app_path)
        .arg("berd://update-check")
        .spawn()
    {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(error) => eprintln!("berd-call could not request a background app update: {error}"),
    }
}

/// Where a call's transcript records go.
#[derive(Clone, Copy, Debug, PartialEq)]
enum TranscriptDestination {
    None,
    Stdout,
    Codex,
}

struct StartOptions {
    saved: Option<(PathBuf, saved_settings::SavedSettings)>,
    port: u16,
    transcript: TranscriptDestination,
    menu_bar: bool,
    non_blocking: bool,
    session_arguments: Vec<String>,
}

fn validate_session_arguments(arguments: &[String]) -> Result<(), String> {
    if arguments
        .iter()
        .any(|argument| argument == "--pcm-output-fd")
    {
        return Err("berd-call start owns its PCM output descriptor".into());
    }
    let mut validation = vec!["berd-call".to_string()];
    validation.extend(arguments.iter().cloned());
    match parse_args(&validation) {
        Ok(_) => Ok(()),
        Err(ParseFailure::HelpRequested) => Err("session options must not request help".into()),
        Err(ParseFailure::Usage(message)) => Err(message),
    }
}

fn parse_start_args(args: &[String]) -> Result<StartOptions, ParseFailure> {
    let mut port = 5222_u16;
    let mut port_seen = false;
    let mut transcript = TranscriptDestination::None;
    let mut menu_bar = true;
    let mut non_blocking = false;
    let mut session_arguments = vec!["session".to_string()];
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "-h" | "--help" => return Err(ParseFailure::HelpRequested),
            flag @ ("--stream" | "--codex") => {
                if transcript != TranscriptDestination::None {
                    return Err("choose one of --stream or --codex for transcript delivery".into());
                }
                index += 1;
                transcript = if flag == "--codex" {
                    TranscriptDestination::Codex
                } else {
                    TranscriptDestination::Stdout
                };
            }
            "--no-menu-bar" if menu_bar => {
                menu_bar = false;
                index += 1;
            }
            "--no-menu-bar" => return Err("--no-menu-bar may be provided only once".into()),
            "--non-blocking" if !non_blocking => {
                non_blocking = true;
                index += 1;
            }
            "--non-blocking" => return Err("--non-blocking may be provided only once".into()),
            "--port" if !port_seen => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--port requires a value".to_string())?;
                port = parse_port(value)?;
                port_seen = true;
                index += 2;
            }
            "--port" => return Err("--port may be provided only once".into()),
            "--pcm-output-fd" => {
                return Err("berd-call start owns its PCM output descriptor".into())
            }
            _ => {
                session_arguments.push(args[index].clone());
                index += 1;
            }
        }
    }
    validate_session_arguments(&session_arguments)?;
    if non_blocking && transcript == TranscriptDestination::None {
        return Err(
            "non-blocking speech requires --stream or --codex for interruption and failure events"
                .into(),
        );
    }
    Ok(StartOptions {
        saved: None,
        port,
        transcript,
        menu_bar,
        non_blocking,
        session_arguments,
    })
}

fn parse_saved_start_args(args: &[String]) -> Result<StartOptions, ParseFailure> {
    if args.iter().skip(2).any(|arg| is_help_flag(arg)) {
        return Err(ParseFailure::HelpRequested);
    }
    let path = saved_settings::path()?;
    parse_saved_start_args_at(args, path)
}

fn parse_saved_start_args_at(args: &[String], path: PathBuf) -> Result<StartOptions, ParseFailure> {
    let mut saved = saved_settings::load(&path)?;
    // Restore the accepted runtime rate through its own backend validation.
    if saved.tts.is_some() {
        saved.arguments = saved
            .arguments
            .chunks_exact(2)
            .filter(|pair| pair[0] != "--rate")
            .flat_map(|pair| pair.iter().cloned())
            .collect();
    }
    let mut merged = args[..2].to_vec();
    merged.extend(saved_settings::merge_arguments(
        &saved.arguments,
        &args[2..],
    ));
    let mut options = parse_start_args(&merged)?;
    // Explicit synthesis choices use normal startup validation.
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--tts-backend" | "--model-dir"))
    {
        saved.tts = None;
    }
    if let Some(settings) = &mut saved.tts {
        for pair in args[2..].windows(2) {
            match pair[0].as_str() {
                "--rate" => {
                    *settings = settings
                        .clone()
                        .with_rate(pair[1].parse::<f32>().map_err(|_| "invalid rate")?)
                }
                "--voice" => match settings {
                    TtsSettings::Siri { voice, .. }
                    | TtsSettings::Pocket { voice, .. }
                    | TtsSettings::OpenAi { voice, .. } => *voice = pair[1].clone(),
                },
                "--language" => {
                    if let TtsSettings::Siri { language, .. } = settings {
                        *language = pair[1].clone();
                    }
                }
                _ => {}
            }
        }
    }
    saved.arguments = saved_settings::persistable_arguments(&options.session_arguments[1..]);
    options.saved = Some((path, saved));
    Ok(options)
}

#[derive(Debug, PartialEq)]
struct SpeakOptions {
    port: u16,
    acknowledgement: Option<u64>,
    voice: Option<String>,
    language: Option<String>,
    text: String,
}

fn parse_speak_control_args(args: &[String]) -> Result<SpeakOptions, ParseFailure> {
    let mut port = 5222_u16;
    let mut port_seen = false;
    let mut acknowledgement = None;
    let (mut voice, mut language) = (None, None);
    let mut text = None;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "-h" | "--help" => return Err(ParseFailure::HelpRequested),
            "--port" if !port_seen => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--port requires a value".to_string())?;
                port = parse_port(value)?;
                port_seen = true;
                index += 2;
            }
            "--port" => return Err("--port may be provided only once".into()),
            "--re" if acknowledgement.is_none() => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--re requires a value".to_string())?;
                acknowledgement = Some(
                    value
                        .parse::<u64>()
                        .map_err(|_| "--re must be a nonnegative integer".to_string())?,
                );
                index += 2;
            }
            "--re" => return Err("--re may be provided only once".into()),
            flag @ ("--voice" | "--language") => {
                let slot = if flag == "--voice" {
                    &mut voice
                } else {
                    &mut language
                };
                if slot.is_some() {
                    return Err(format!("{flag} may be provided only once").into());
                }
                *slot = Some(
                    args.get(index + 1)
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| format!("{flag} requires a value"))?
                        .clone(),
                );
                index += 2;
            }
            value if value.starts_with('-') => {
                return Err(format!("unknown speak argument: {value}").into())
            }
            value if text.is_none() => {
                text = Some(value.to_string());
                index += 1;
            }
            _ => return Err("speak accepts exactly one text argument".into()),
        }
    }
    let text = text
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| ParseFailure::Usage("speak text is required".into()))?;
    if text.len() > MAX_SPEAK_TEXT_BYTES {
        return Err("speak text is larger than 16 KiB".into());
    }
    if language.is_some() && voice.is_none() {
        return Err("--language requires --voice".into());
    }
    Ok(SpeakOptions {
        port,
        acknowledgement,
        voice,
        language,
        text,
    })
}

fn parse_host_settings_args(
    args: &[String],
) -> Result<(u16, host_control::ControlRequest), ParseFailure> {
    let mut port = None;
    let mut language = None;
    let mut request = None;
    let mut index = 2;
    while index < args.len() {
        let flag = args[index].as_str();
        if flag == "--language" {
            if language.is_some() {
                return Err("--language may be provided only once".into());
            }
            language = Some(
                args.get(index + 1)
                    .ok_or("--language requires a value")?
                    .clone(),
            );
            index += 2;
            continue;
        }
        if flag == "--port" {
            if port.is_some() {
                return Err("--port may be provided only once".into());
            }
            let value = args
                .get(index + 1)
                .ok_or_else(|| "--port requires a value".to_string())?;
            port = Some(parse_port(value)?);
            index += 2;
            continue;
        }
        let setting = match flag {
            "-h" | "--help" => return Err(ParseFailure::HelpRequested),
            "--restart" => {
                // Restart consumes the rest of argv as session options.
                if request.is_some() {
                    return Err(SETTINGS_CHOICE_ERROR.into());
                }
                let mut session_arguments = vec!["session".to_string()];
                session_arguments.extend(args[index + 1..].iter().cloned());
                validate_session_arguments(&session_arguments)?;
                request = Some(host_control::ControlRequest::Restart { session_arguments });
                break;
            }
            "--non-blocking" => host_control::ControlRequest::NonBlocking {
                enabled: parse_bool_setting(flag, args.get(index + 1))?,
            },
            "--muted" => host_control::ControlRequest::Muted {
                muted: parse_bool_setting(flag, args.get(index + 1))?,
            },
            "--status-sounds" => host_control::ControlRequest::StatusSounds {
                mode: Some(match args.get(index + 1).map(String::as_str) {
                    Some("off") => berd_call::StatusSoundMode::Off,
                    Some("working") => berd_call::StatusSoundMode::Working,
                    Some("working-and-waiting") => berd_call::StatusSoundMode::WorkingAndWaiting,
                    _ => {
                        return Err(
                            "--status-sounds requires off, working, or working-and-waiting".into(),
                        )
                    }
                }),
                status: None,
            },
            "--conversation-status" => host_control::ControlRequest::StatusSounds {
                mode: None,
                status: Some(match args.get(index + 1).map(String::as_str) {
                    Some("working") => berd_call::ConversationStatus::Working,
                    Some("waiting") => berd_call::ConversationStatus::Waiting,
                    _ => return Err("--conversation-status requires working or waiting".into()),
                }),
            },
            "--input-during-tts" => host_control::ControlRequest::InputDuringTts {
                policy: match args.get(index + 1).map(String::as_str) {
                    Some("allow") => berd_call::input::InputDuringTtsPolicy::AllowBargeIn,
                    Some("suppress") => berd_call::input::InputDuringTtsPolicy::SuppressInput,
                    Some("auto") => InputDuringTtsPolicy::Auto,
                    _ => return Err("--input-during-tts requires auto, allow or suppress".into()),
                },
            },
            "--rate" => host_control::ControlRequest::Rate {
                rate: args
                    .get(index + 1)
                    .and_then(|value| value.parse::<f32>().ok())
                    .filter(|rate| rate.is_finite() && *rate > 0.0)
                    .ok_or("--rate requires a positive number")?,
            },
            "--voice" => host_control::ControlRequest::Voice {
                voice: args
                    .get(index + 1)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or("--voice requires a name")?
                    .clone(),
                language: None,
            },
            "--tts" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--tts requires a JSON settings object".to_string())?;
                host_control::ControlRequest::TtsSettings {
                    settings: serde_json::from_str(value)
                        .map_err(|error| format!("invalid TTS settings: {error}"))?,
                }
            }
            _ => return Err(format!("unrecognized settings option: {flag}").into()),
        };
        index += 2;
        if request.replace(setting).is_some() {
            return Err(SETTINGS_CHOICE_ERROR.into());
        }
    }
    let mut request = request.ok_or_else(|| ParseFailure::Usage(SETTINGS_CHOICE_ERROR.into()))?;
    if language.is_some() {
        if let host_control::ControlRequest::Voice {
            language: selected, ..
        } = &mut request
        {
            *selected = language;
        } else {
            return Err("--language requires --voice".into());
        }
    }
    Ok((port.unwrap_or(5222), request))
}

const SETTINGS_CHOICE_ERROR: &str =
    "provide exactly one of --non-blocking, --rate, --voice, --tts, --input-during-tts, --muted, --status-sounds, --conversation-status, or --restart";

fn parse_bool_setting(flag: &str, value: Option<&String>) -> Result<bool, String> {
    match value.map(String::as_str) {
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        _ => Err(format!("{flag} requires true or false")),
    }
}

fn parse_control_port(args: &[String]) -> Result<u16, ParseFailure> {
    match args.get(2..).unwrap_or_default() {
        [] => Ok(5222),
        [help] if is_help_flag(help) => Err(ParseFailure::HelpRequested),
        [flag, value] if flag == "--port" => parse_port(value).map_err(Into::into),
        _ => Err(format!("{} accepts only --port PORT", args[1]).into()),
    }
}

fn parse_poll_input_args(
    wait: bool,
    args: &[String],
) -> Result<(u16, host_control::ControlRequest), ParseFailure> {
    let mut port = 5222;
    let mut since = None;
    let mut timeout_seconds = 30;
    let mut seen = std::collections::HashSet::new();
    let mut options = args.iter().skip(2);
    while let Some(flag) = options.next() {
        if is_help_flag(flag) {
            return Err(ParseFailure::HelpRequested);
        }
        if !seen.insert(flag) {
            return Err(format!("duplicate polling option: {flag}").into());
        }
        let value = options
            .next()
            .ok_or_else(|| format!("{flag} requires a value"))?;
        match flag.as_str() {
            "--port" => port = parse_port(value)?,
            "--since" => {
                since = Some(
                    value
                        .parse::<u64>()
                        .map_err(|_| "--since requires a nonnegative integer")?,
                )
            }
            "--timeout" => {
                timeout_seconds = value
                    .parse::<u64>()
                    .ok()
                    .filter(|v| host_control::POLL_TIMEOUT_SECONDS.contains(v))
                    .ok_or("--timeout requires seconds from 1 to 3600")?;
            }
            _ => return Err(format!("unknown polling option: {flag}").into()),
        }
    }
    Ok((
        port,
        host_control::ControlRequest::PollInput {
            since,
            wait,
            timeout_seconds,
        },
    ))
}

fn parse_port(value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| "--port must be an integer from 1 to 65535".into())
}

fn print_pretty_json(value: &serde_json::Value) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .map_err(|error| format!("could not encode command result: {error}"))?
    );
    Ok(())
}

fn operational_error(operation: &str, error: String) -> ! {
    eprintln!("berd-call {operation} failed: {error}");
    std::process::exit(1)
}

#[derive(Debug, PartialEq, Eq)]
enum ParseFailure {
    HelpRequested,
    Usage(String),
}

#[cfg(test)]
impl ParseFailure {
    fn contains(&self, pattern: &str) -> bool {
        matches!(self, Self::Usage(message) if message.contains(pattern))
    }
}

impl From<String> for ParseFailure {
    fn from(message: String) -> Self {
        Self::Usage(message)
    }
}

impl From<&str> for ParseFailure {
    fn from(message: &str) -> Self {
        Self::Usage(message.into())
    }
}

#[cfg(test)]
impl PartialEq<&str> for ParseFailure {
    fn eq(&self, other: &&str) -> bool {
        matches!(self, Self::Usage(message) if message == *other)
    }
}

fn parse_or_exit<T, E>(result: Result<T, E>, args: &[String]) -> T
where
    E: Into<ParseFailure>,
{
    match result.map_err(Into::into) {
        Ok(value) => value,
        Err(ParseFailure::HelpRequested) => help_and_exit(args),
        Err(ParseFailure::Usage(error)) => usage_error(&error, args),
    }
}

fn help_and_exit(args: &[String]) -> ! {
    println!("{}", cli_help::usage_for(args));
    std::process::exit(0);
}

fn is_help_flag(value: &str) -> bool {
    matches!(value, "-h" | "--help")
}

fn usage_error(error: &str, args: &[String]) -> ! {
    eprintln!("{error}");
    eprintln!("{}", cli_help::usage_for(args));
    std::process::exit(2);
}

fn parse_management_args(args: &[String]) -> Result<ManagementCommand, ParseFailure> {
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
                if is_help_flag(flag) {
                    return Err(ParseFailure::HelpRequested);
                }
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("{flag} requires a value"))?;
                match flag {
                    "--language" if language.is_none() => language = Some(value.clone()),
                    "--language" => return Err("--language may be provided only once".into()),
                    _ => return Err(format!("unknown voices list argument: {flag}").into()),
                }
                index += 2;
            }
            let language = language
                .as_deref()
                .map(berd_call::siri::normalize_language)
                .transpose()?;
            Ok(ManagementCommand::ListVoices { language })
        }
        (Some("voices"), Some("download"), _) => {
            let mut voice = None;
            let mut language = None;
            let mut availability_wait = berd_call::siri::SiriDownloadAvailabilityWait::default();
            let mut wait_seen = false;
            let mut index = 3;
            while index < args.len() {
                let flag = args[index].as_str();
                if is_help_flag(flag) {
                    return Err(ParseFailure::HelpRequested);
                }
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
                            berd_call::siri::SiriDownloadAvailabilityWait::from_seconds(seconds)?;
                        wait_seen = true;
                    }
                    "--voice" | "--language" | "--availability-wait-seconds" => {
                        return Err(format!("{flag} may be provided only once").into())
                    }
                    _ => return Err(format!("unknown voices download argument: {flag}").into()),
                }
                index += 2;
            }
            let voice = voice.ok_or_else(|| "--voice is required".to_string())?;
            let language = language.ok_or_else(|| "--language is required".to_string())?;
            Ok(ManagementCommand::DownloadVoice {
                identity: berd_call::siri::SiriVoiceIdentity::new(voice, &language)?,
                availability_wait,
            })
        }
        (Some("voices"), Some("preview"), _) => {
            let mut voice = None;
            let mut language = None;
            let mut rate = None;
            let mut index = 3;
            while index < args.len() {
                let flag = args[index].as_str();
                if is_help_flag(flag) {
                    return Err(ParseFailure::HelpRequested);
                }
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| format!("{flag} requires a value"))?;
                match flag {
                    "--voice" if voice.is_none() => voice = Some(value.clone()),
                    "--language" if language.is_none() => language = Some(value.clone()),
                    "--rate" if rate.is_none() => {
                        let value = value
                            .parse::<f32>()
                            .map_err(|_| "--rate must be a number".to_string())?;
                        if !value.is_finite() || !(0.5..=2.0).contains(&value) {
                            return Err("--rate must be between 0.5 and 2.0".into());
                        }
                        rate = Some(value);
                    }
                    "--voice" | "--language" | "--rate" => {
                        return Err(format!("{flag} may be provided only once").into())
                    }
                    _ => return Err(format!("unknown voices preview argument: {flag}").into()),
                }
                index += 2;
            }
            let voice = voice.ok_or_else(|| "--voice is required".to_string())?;
            let language = language.ok_or_else(|| "--language is required".to_string())?;
            Ok(ManagementCommand::PreviewVoice {
                identity: berd_call::siri::SiriVoiceIdentity::new(voice, &language)?,
                rate: rate.unwrap_or(1.0),
            })
        }
        (Some("models"), Some("macos"), Some("status" | "install"))
            if args.len() == 5 && args.get(4).is_some_and(|value| is_help_flag(value)) =>
        {
            Err(ParseFailure::HelpRequested)
        }
        (Some("models"), Some("openai"), Some("voices"))
            if args.len() == 5 && args.get(4).is_some_and(|value| is_help_flag(value)) =>
        {
            Err(ParseFailure::HelpRequested)
        }
        (Some("models"), Some("pocket"), Some("voices"))
            if args.len() == 5 && args.get(4).is_some_and(|value| is_help_flag(value)) =>
        {
            Err(ParseFailure::HelpRequested)
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
        (Some("models"), Some("openai"), Some("voices")) if args.len() == 4 => {
            Ok(ManagementCommand::ListOpenAiVoices)
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
        (Some("voices"), _, _) => Err("expected voices list, download, or preview".into()),
        (Some("models"), _, _) => Err("expected a supported models command".into()),
        _ => Err("expected a management command".into()),
    }
}

fn parse_local_model_roots(args: &[String]) -> Result<LocalAssetRoots, ParseFailure> {
    let mut store_root = None;
    let mut index = 4;
    while index < args.len() {
        let flag = args[index].as_str();
        if is_help_flag(flag) {
            return Err(ParseFailure::HelpRequested);
        }
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("{flag} requires a value"))?;
        if flag != "--store-root" || store_root.is_some() {
            return Err("local model status/install requires --store-root exactly once".into());
        }
        store_root = Some(value);
        index += 2;
    }
    let value =
        store_root.ok_or("local model status/install requires --store-root exactly once")?;
    if value
        .split(['/', '\\'])
        .any(|component| matches!(component, "." | ".."))
    {
        return Err("--store-root must not contain . or .. components".into());
    }
    Ok(local_model_roots(std::path::Path::new(value))?)
}

fn local_model_roots(store_root: &std::path::Path) -> Result<LocalAssetRoots, String> {
    LocalAssetRoots::new(
        store_root,
        store_root.join(berd_call::pocket_assets::MODEL_ID),
        store_root
            .join(berd_call::pocket_assets::MODEL_ID)
            .join("stt"),
    )
    .map_err(|error| error.to_string())
}

fn voices_list_report(
    supported: bool,
    language_filter: Option<String>,
    catalog: berd_call::siri::SiriVoiceCatalog,
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
    identity: &berd_call::siri::SiriVoiceIdentity,
    availability_wait: berd_call::siri::SiriDownloadAvailabilityWait,
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
        model_id: berd_call::pocket_assets::MODEL_ID,
        voice_license_id: berd_call::pocket_assets::VOICE_LICENSE_ID,
        voices: berd_call::pocket_assets::voices()
            .iter()
            .map(|voice| PocketVoiceResult {
                id: voice.id,
                name: voice.name,
            })
            .collect(),
    }
}

fn openai_voices_report() -> OpenAiVoicesResult {
    OpenAiVoicesResult {
        backend: "openai",
        voices: berd_call::openai::OPENAI_VOICE_IDS,
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
        berd_call::local_assets::try_lock_for_read(roots).map_err(local_model_lock_failure)?;
    let state = match model {
        LocalModelKind::Pocket => match berd_call::pocket_assets::inspect(
            roots.pocket_bundle_root(),
        )
        .map_err(|error| {
            management_failure(
                "integrity_failed",
                "Could not inspect the Pocket model",
                error,
            )
        })? {
            berd_call::pocket_assets::PocketAssetStatus::Missing => LocalModelState::Missing,
            berd_call::pocket_assets::PocketAssetStatus::Invalid => LocalModelState::Invalid,
            berd_call::pocket_assets::PocketAssetStatus::Ready { verified_bytes } => {
                LocalModelState::Ready { verified_bytes }
            }
        },
        LocalModelKind::Parakeet => {
            match berd_call::parakeet_assets::inspect(roots.parakeet_bundle_root()).map_err(
                |error| {
                    management_failure(
                        "integrity_failed",
                        "Could not inspect the Parakeet model",
                        error,
                    )
                },
            )? {
                berd_call::parakeet_assets::ParakeetAssetStatus::Missing => {
                    LocalModelState::Missing
                }
                berd_call::parakeet_assets::ParakeetAssetStatus::Invalid => {
                    LocalModelState::Invalid
                }
                berd_call::parakeet_assets::ParakeetAssetStatus::Ready { verified_bytes } => {
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
    let status = berd_call::mac_speech::mac_speech_status()?;
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
    berd_call::mac_speech::install_mac_speech_model(write_management_progress)
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
        eprintln!("berd-call ignored invalid macOS model install progress: {progress}");
        return;
    };
    let envelope = ManagementProgressEnvelope {
        schema_version: MANAGEMENT_SCHEMA_VERSION,
        operation: "models.macos.install",
        event: "progress",
        fraction,
    };
    if let Err(error) = write_json_line(io::stdout().lock(), &envelope) {
        eprintln!("berd-call could not write install progress: {error}");
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
        eprintln!("berd-call could not write local model install progress: {error}");
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
            match runtime.block_on(berd_call::pocket_assets::install(&roots, |progress| {
                write_local_model_progress(operation, progress);
            })) {
                Ok(berd_call::pocket_assets::PocketInstallOutcome::AlreadyReady {
                    verified_bytes,
                }) => ("alreadyReady", verified_bytes, None),
                Ok(berd_call::pocket_assets::PocketInstallOutcome::Installed {
                    verified_bytes,
                    cleanup_pending,
                }) => ("installed", verified_bytes, cleanup_pending),
                Err(error) => return Err(local_install_failure(error)),
            }
        }
        LocalModelKind::Parakeet => {
            match runtime.block_on(berd_call::parakeet_assets::install(&roots, |progress| {
                write_local_model_progress(operation, progress);
            })) {
                Ok(berd_call::parakeet_assets::ParakeetInstallOutcome::AlreadyReady {
                    verified_bytes,
                }) => ("alreadyReady", verified_bytes, None),
                Ok(berd_call::parakeet_assets::ParakeetInstallOutcome::Installed {
                    verified_bytes,
                    cleanup_pending,
                }) => ("installed", verified_bytes, cleanup_pending),
                Err(error) => return Err(local_install_failure(error)),
            }
        }
    };
    if let Some(path) = cleanup_pending.as_ref() {
        eprintln!(
            "berd-call installed the {} model; prior backup cleanup remains at {}",
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
fn voice_download_failure(error: berd_call::siri::SiriVoiceDownloadError) -> ManagementFailure {
    match error {
        berd_call::siri::SiriVoiceDownloadError::NotFound(_) => management_failure(
            "voice_not_found",
            "The requested Siri voice was not found",
            error.to_string(),
        ),
        berd_call::siri::SiriVoiceDownloadError::Operation(_) => management_failure(
            "operation_failed",
            "Could not make the requested Siri voice available",
            error.to_string(),
        ),
    }
}

/// Previews a voice, stopping playback and exiting on SIGINT or SIGTERM so a
/// host can end a preview by signaling the process.
#[cfg(target_os = "macos")]
fn preview_voice_until_stopped(
    identity: &berd_call::siri::SiriVoiceIdentity,
    rate: f32,
) -> Result<berd_call::siri::SiriPreviewSource, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static ACTIVE: AtomicBool = AtomicBool::new(true);
    extern "C" fn stop(_: libc::c_int) {
        ACTIVE.store(false, Ordering::SeqCst);
    }
    let handler = stop as extern "C" fn(libc::c_int) as libc::sighandler_t;
    // SAFETY: The handler only stores to an atomic.
    unsafe {
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGTERM, handler);
    }
    let result = berd_call::siri::preview_voice(identity, rate, &ACTIVE);
    if !ACTIVE.load(Ordering::SeqCst) {
        std::process::exit(130);
    }
    result
}

fn run_management_command(command: ManagementCommand) -> Result<(), ManagementFailure> {
    let operation = command.operation();
    match command {
        ManagementCommand::ListVoices { language } => {
            let catalog =
                berd_call::siri::load_voice_catalog(language.as_deref()).map_err(|error| {
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
                let identity = berd_call::siri::download_voice(&identity, availability_wait)
                    .map_err(voice_download_failure)?;
                let result = voice_download_report(&identity, availability_wait);
                write_management_result(operation, result).map_err(|error| {
                    management_failure("output_failed", "Could not write command result", error)
                })
            }
        }
        ManagementCommand::PreviewVoice { identity, rate } => {
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (identity, rate);
                return Err(management_failure(
                    "unsupported",
                    "Siri voice preview is available only on macOS",
                    "Siri voice preview is available only on macOS",
                ));
            }
            #[cfg(target_os = "macos")]
            {
                let source = preview_voice_until_stopped(&identity, rate).map_err(|error| {
                    management_failure(
                        "operation_failed",
                        "Could not preview the Siri voice",
                        error,
                    )
                })?;
                let result = VoicePreviewResult {
                    backend: "siri",
                    voice: identity,
                    rate,
                    source,
                };
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
        ManagementCommand::ListOpenAiVoices => {
            write_management_result(operation, openai_voices_report()).map_err(|error| {
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

fn standard_session_status_cues_suppressed(
    core: &SessionCore,
    assistant_output_active: bool,
) -> bool {
    core.user_speaking() || assistant_output_active
}

fn run_session(config: SessionConfig, pcm_output_fd: RawFd) -> Result<(), String> {
    let (control_tx, control_rx) = mpsc::channel();
    let (pcm_tx, pcm_rx) = mpsc::sync_channel(INPUT_QUEUE_CAPACITY);
    let mut voice_builds = VoiceBuilds {
        controls: control_tx.clone(),
        pending: HashSet::new(),
    };
    let input_progress = Arc::new(SessionInputProgress::default());
    let reader_progress = Arc::clone(&input_progress);
    thread::spawn(move || {
        read_framed_requests(
            io::stdin().lock(),
            control_tx,
            pcm_tx,
            &reader_progress,
            &mut io::stderr(),
        )
    });
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
    let mut held: Option<HeldPrepare> = None;
    let mut active: Option<ActivePlayback> = None;
    input_progress.enter("status_assets");
    let status_sound_runtime = ManagedStatusSoundRuntime::spawn(None)?;

    loop {
        input_progress.enter("voice_events");
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
        input_progress.enter("playback");
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
        input_progress.enter("maintenance");
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
        let conversation_active = standard_session_status_cues_suppressed(&core, active.is_some());
        input_progress.enter("status_sounds");
        let status_sound_result =
            status_sound_runtime.queue_conversation_active(conversation_active);
        if let Err(message) = status_sound_result {
            eprintln!("status sound playback disabled: {message}");
        }

        input_progress.enter("receive");
        let Some(input) = receive_session_input(
            &control_rx,
            &pcm_rx,
            &mut pending_control,
            &mut processed_pcm,
        ) else {
            continue;
        };
        input_progress
            .processed
            .store(processed_pcm, Ordering::Relaxed);
        input_progress.enter(match &input {
            Input::Pcm(_) => "pcm",
            Input::Request(SessionRequest::Hello { .. }) => "hello_tts",
            _ => "control",
        });
        let Some(input) = voice_builds.filter(input, tts_slot.as_ref(), &mut writer)? else {
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
            Input::VoiceBuilt(_) | Input::VoiceUnavailable { .. } => {
                unreachable!("voice builds are filtered")
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
                if let Some((held, _)) = held.take() {
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
                status_sound_output_device,
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
                let slot = match create_tts_slot(&config.tts, config.endpoints.tts.as_deref()) {
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
                input_progress.enter("hello_stt");
                let (runtime, mut events) = match create_input_runtime(
                    &config.stt,
                    config.endpoints.stt.as_deref(),
                    &config.stt_hints,
                ) {
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
                input_progress.enter("hello_ready");
                status_sound_runtime.set_input_controls(runtime.controls())?;
                input_controls = Some(runtime.controls());
                input_runtime = Some(runtime);
                input_events = Some(events);
                initialized = true;
                status_sound_runtime.set_output_device(status_sound_output_device)?;
                status_sound_runtime.set_input_policy(input_during_tts)?;
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
                        protocol: SESSION_PROTOCOL_VERSION,
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
            Input::Request(SessionRequest::SetConversationStatus {
                id,
                status,
                settings,
            }) => {
                status_sound_runtime.update(status, settings)?;
                write_message(
                    &mut writer,
                    &SessionMessage::ConversationStatusApplied {
                        id,
                        status,
                        settings,
                    },
                )?;
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
                status_sound_runtime.set_input_policy(snapshot.policy)?;
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
                voice,
                language,
            }) => {
                let request = PrepareRequest {
                    id,
                    acknowledgement,
                    text,
                };
                let Some(voice) =
                    speak_voice(tts_slot.as_deref(), voice, language, id, &mut writer)?
                else {
                    continue;
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
                        voice,
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
            Input::Request(SessionRequest::CancelSpeech { id, speech_id }) => {
                handle_cancel_speech(id, speech_id, &mut core, &mut active, &mut writer)?;
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
            .begin_assistant_activity(current.input_during_tts.policy)
            .expect("VAD threshold is valid")
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

fn parse_args(args: &[String]) -> Result<SessionConfig, ParseFailure> {
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
    let mut stt_hints = Vec::new();
    let mut endpoints = SessionEndpointOverrides::default();
    let mut index = 2;
    while index < args.len() {
        let flag = args[index].as_str();
        if is_help_flag(flag) {
            return Err(ParseFailure::HelpRequested);
        }
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
            "--stt-hint" => {
                let hint = value.trim();
                if hint.is_empty() || hint.len() > 256 || stt_hints.len() >= 100 {
                    return Err(
                        "--stt-hint accepts up to 100 nonempty phrases of at most 256 bytes".into(),
                    );
                }
                if !stt_hints.iter().any(|existing| existing == hint) {
                    stt_hints.push(hint.to_string());
                }
            }
            "--stt-url" => endpoints.stt = Some(parse_endpoint_url(value, "--stt-url", true)?),
            "--tts-url" => endpoints.tts = Some(parse_endpoint_url(value, "--tts-url", false)?),
            "--pcm-output-fd" => {}
            _ => return Err(format!("unknown argument: {flag}").into()),
        }
        index += 2;
    }
    let tts = build_tts_backend_config(backend, voice, language, model_dir, rate)?;
    let stt = build_stt_backend_config(stt_backend, stt_model_dir)?;
    if endpoints.tts.is_some() && !matches!(tts, TtsBackendConfig::OpenAi { .. }) {
        return Err("--tts-url requires --tts-backend openai".into());
    }
    if endpoints.stt.is_some() && !matches!(stt, SttBackendConfig::OpenAi) {
        return Err("--stt-url requires --stt-backend openai".into());
    }
    Ok(SessionConfig {
        tts,
        stt,
        stt_hints,
        endpoints,
    })
}

fn parse_endpoint_url(value: &str, flag: &str, websocket: bool) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|error| format!("{flag} is invalid: {error}"))?;
    let protocol = if websocket {
        EndpointProtocol::WebSocket
    } else {
        EndpointProtocol::Http
    };
    if !is_allowed_endpoint_url(&url, protocol) {
        return Err(format!("{flag} requires a full URL with the correct protocol, HTTPS/WSS outside loopback, and no embedded credentials or fragment"));
    }
    Ok(url.to_string())
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

fn parse_synthesis_args(args: &[String]) -> Result<SynthesisConfig, ParseFailure> {
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
        if is_help_flag(flag) {
            return Err(ParseFailure::HelpRequested);
        }
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
            _ => return Err(format!("unknown synthesize argument: {flag}").into()),
        };
        if destination.is_some() {
            return Err(format!("{flag} may be provided only once").into());
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
        return Err(format!("--text exceeds {MAX_SPEAK_TEXT_BYTES} UTF-8 bytes").into());
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
                let identity = berd_call::siri::SiriVoiceIdentity::new(voice.clone(), language)?;
                *voice = identity.name().to_string();
                *language = identity.language().to_string();
            }
            if matches!(local, TtsBackendConfig::Pocket { rate, .. } if rate != 1.0) {
                return Err("Pocket WAV synthesis supports only --rate 1.0".into());
            }
            SynthesisTtsConfig::Local(local)
        }
        value => return Err(format!("unsupported TTS backend: {value}").into()),
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

fn parse_tts_benchmark_args(args: &[String]) -> Result<TtsBenchmarkConfig, ParseFailure> {
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
        if is_help_flag(flag) {
            return Err(ParseFailure::HelpRequested);
        }
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
            _ => return Err(format!("unknown argument: {flag}").into()),
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
                return Err(format!("--text exceeds {MAX_SPEAK_TEXT_BYTES} UTF-8 bytes").into());
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
            )
            .into());
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
            )
            .into());
        }
        if total_text_bytes > MAX_OPENAI_BENCHMARK_TEXT_BYTES {
            return Err(format!(
                "OpenAI benchmark would submit {total_text_bytes} total UTF-8 text bytes; maximum is {MAX_OPENAI_BENCHMARK_TEXT_BYTES}"
            )
            .into());
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

fn parse_stt_benchmark_args(args: &[String]) -> Result<SttBenchmarkConfig, ParseFailure> {
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
        if is_help_flag(flag) {
            return Err(ParseFailure::HelpRequested);
        }
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
            _ => return Err(format!("unknown argument: {flag}").into()),
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
    workload: &berd_call::benchmark::SttBenchmarkWorkload,
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
) -> Result<berd_call::benchmark::SttBenchmarkReport, String> {
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
        || create_input_runtime(&config.stt, None, &[]),
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
            vad_threshold: DEFAULT_VAD_THRESHOLD,
            endpoint_source: None,
            model_source: Some("explicit --stt-model-dir".into()),
            credential_source: None,
        }),
        SttBackendConfig::Macos => {
            #[cfg(target_os = "macos")]
            {
                let status = berd_call::mac_speech::mac_speech_status()?;
                Ok(SttBenchmarkTarget {
                    backend: "macos".into(),
                    model: Some(status.model_status),
                    locale: status.locale,
                    vad_threshold: DEFAULT_VAD_THRESHOLD,
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
                vad_threshold: DEFAULT_VAD_THRESHOLD,
                endpoint_source: Some(endpoint_source.into()),
                model_source: Some(model_source.into()),
                credential_source: Some(format!(
                    "{} environment variable",
                    berd_call::openai::openai_key_var("OPENAI_STT_API_KEY")
                        .unwrap_or("OPENAI_STT_API_KEY")
                )),
            })
        }
    }
}

fn create_tts_configuration(
    config: &TtsBackendConfig,
    endpoint: Option<&str>,
) -> Result<TtsConfiguration, String> {
    match config {
        TtsBackendConfig::OpenAi { rate } => create_openai_tts_configuration(
            *rate,
            std::env::var("OPENAI_TTS_MODEL").unwrap_or_else(|_| "gpt-4o-mini-tts".into()),
            std::env::var("OPENAI_TTS_VOICE").unwrap_or_else(|_| "marin".into()),
            endpoint,
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
            berd_call::pocket_assets::MODEL_ID.into(),
            voice.clone(),
            *rate,
        )),
    }
}

fn create_openai_tts_configuration(
    rate: f32,
    model: String,
    voice: String,
    endpoint: Option<&str>,
) -> Result<TtsConfiguration, String> {
    let api_key = berd_call::openai::openai_key("OPENAI_TTS_API_KEY")
        .ok_or_else(|| "OPENAI_TTS_API_KEY or OPENAI_API_KEY is required".to_string())?;
    let base =
        std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into());
    Ok(TtsConfiguration::openai(
        endpoint
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}/audio/speech", base.trim_end_matches('/'))),
        api_key,
        model,
        voice,
        rate,
    ))
}

fn create_tts_slot(
    config: &TtsBackendConfig,
    endpoint: Option<&str>,
) -> Result<ConfiguredTtsSlot, String> {
    #[cfg(not(target_os = "macos"))]
    if matches!(config, TtsBackendConfig::Siri { .. }) {
        return Err(
            "Siri TTS is the default but is only available on macOS; explicitly select --tts-backend openai or --tts-backend pocket on this platform"
                .into(),
        );
    }
    ConfiguredTtsSlot::new(create_tts_configuration(config, endpoint)?).map_err(|error| match config {
        TtsBackendConfig::Siri {
            voice, language, ..
        } => format!(
            "Siri TTS voice {voice:?} ({language}) is unavailable: {error}. Download it in Berd Voice settings or select another installed voice with --voice and --language"
        ),
        _ => error,
    })
}

fn create_tts_backend(config: &TtsBackendConfig) -> Result<Arc<dyn TtsBackend>, String> {
    let slot = create_tts_slot(config, None)?;
    Ok(Arc::clone(slot.lease()?.backend()))
}

fn create_synthesis_backend(config: &SynthesisTtsConfig) -> Result<Arc<dyn TtsBackend>, String> {
    match config {
        SynthesisTtsConfig::OpenAi { model, voice, rate } => {
            let slot = ConfiguredTtsSlot::new(create_openai_tts_configuration(
                *rate,
                model.clone(),
                voice.clone(),
                None,
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
        .prefix(".berd-call-synthesize-")
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
            Some(berd_call::pocket_assets::MODEL_ID.into()),
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
        berd_call::synthesize_pcm16_wav(backend.as_ref(), &config.text, temporary.as_file_mut())
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
    endpoint_override: Option<&str>,
    _hints: &[String],
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
                let status = berd_call::mac_speech::mac_speech_status().map_err(|error| {
                    format!(
                        "Could not check the default macOS speech recognition engine: {error}. Open Berd Voice settings to verify or install the current-locale model"
                    )
                })?;
                validate_macos_stt_status(&status)?;
                VoiceInputEngineConfig::MacSpeech {
                    hints: _hints.to_vec(),
                }
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
            let api_key = berd_call::openai::openai_key("OPENAI_STT_API_KEY").ok_or_else(|| {
                "OPENAI_STT_API_KEY or OPENAI_API_KEY is required for OpenAI STT".to_string()
            })?;
            let endpoint = endpoint_override
                .map(str::to_string)
                .or_else(|| {
                    std::env::var("OPENAI_REALTIME_ENDPOINT")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                })
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
        speech_vad_threshold: DEFAULT_VAD_THRESHOLD,
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
    status: &berd_call::mac_speech::MacSpeechEngineStatus,
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
            "OpenAI TTS could not initialize; verify OPENAI_TTS_API_KEY or OPENAI_API_KEY and the selected model and voice"
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
            "OpenAI speech recognition could not initialize; verify OPENAI_STT_API_KEY or OPENAI_API_KEY and the selected transcription model"
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

/// A held reply, with the voice it asked for.
type HeldPrepare = (PrepareRequest, Option<TtsConfigurationLease>);

/// The voice one reply asked for, or `None` after telling the host it can't
/// have it.
fn speak_voice(
    slot: Option<&ConfiguredTtsSlot>,
    voice: Option<String>,
    language: Option<String>,
    id: u64,
    writer: &mut impl Write,
) -> Result<Option<Option<TtsConfigurationLease>>, String> {
    let Some(voice) = voice else {
        return Ok(Some(None));
    };
    let lease = slot
        .ok_or_else(|| "this call's replies have no voice of their own".to_string())
        .and_then(|slot| slot.lease_voice(&voice, language.as_deref()));
    match lease {
        Ok(lease) => Ok(Some(Some(lease))),
        Err(message) => {
            refuse_voice(id, &voice, &message, writer)?;
            Ok(None)
        }
    }
}

fn refuse_voice(
    id: u64,
    voice: &str,
    message: &str,
    writer: &mut impl Write,
) -> Result<(), String> {
    eprintln!("berd-call: speech {id} can't use voice {voice}: {message}");
    write_message(
        writer,
        &SessionMessage::NotAdmitted {
            id,
            reason: NotAdmittedReason::InvalidVoice,
        },
    )
}

/// Speech requests waiting on a worker to build a voice the session hasn't used yet, since that
/// can take seconds and the session must keep serving audio and input meanwhile.
struct VoiceBuilds {
    controls: mpsc::Sender<OrderedControl>,
    pending: HashSet<u64>,
}

impl VoiceBuilds {
    /// Takes the requests that wait on a voice, and hands each back once its voice is built.
    fn filter(
        &mut self,
        input: Input,
        slot: Option<&Arc<ConfiguredTtsSlot>>,
        writer: &mut impl Write,
    ) -> Result<Option<Input>, String> {
        match input {
            Input::VoiceBuilt(request) => {
                let SessionRequest::PrepareSpeak { id, .. } = request else {
                    unreachable!("only speech waits on a voice")
                };
                Ok(self.pending.remove(&id).then_some(Input::Request(request)))
            }
            Input::VoiceUnavailable { id, voice, message } => {
                if self.pending.remove(&id) {
                    refuse_voice(id, &voice, &message, writer)?;
                }
                Ok(None)
            }
            Input::Request(SessionRequest::Cancel { id }) if self.pending.remove(&id) => {
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
                Ok(None)
            }
            Input::Request(request @ SessionRequest::PrepareSpeak { id, .. }) => {
                let missing = slot.and_then(|slot| {
                    missing_voice(slot, &request).map(|voice| (Arc::clone(slot), voice))
                });
                let Some((slot, (voice, language))) = missing else {
                    return Ok(Some(Input::Request(request)));
                };
                let controls = self.controls.clone();
                self.pending.insert(id);
                thread::spawn(move || {
                    let input = match slot.lease_voice(&voice, language.as_deref()) {
                        Ok(_) => Input::VoiceBuilt(request),
                        Err(message) => Input::VoiceUnavailable { id, voice, message },
                    };
                    let _ = controls.send(OrderedControl {
                        after_pcm: 0,
                        input,
                    });
                });
                Ok(None)
            }
            input => Ok(Some(input)),
        }
    }
}

/// The voice and language a speech request asks for, when the slot hasn't built them yet.
fn missing_voice(
    slot: &ConfiguredTtsSlot,
    request: &SessionRequest,
) -> Option<(String, Option<String>)> {
    let SessionRequest::PrepareSpeak {
        voice: Some(voice),
        language,
        ..
    } = request
    else {
        return None;
    };
    (!slot.has_voice(voice, language.as_deref())).then(|| (voice.clone(), language.clone()))
}

#[allow(clippy::too_many_arguments)]
fn process_prepare(
    request: PrepareRequest,
    voice: Option<TtsConfigurationLease>,
    core: &mut SessionCore,
    tts_slot: &ConfiguredTtsSlot,
    input_during_tts_slot: &InputDuringTtsSlot,
    active: &mut Option<ActivePlayback>,
    held: &mut Option<HeldPrepare>,
    writer: &mut impl Write,
) -> Result<(), String> {
    let id = request.id;
    match core.prepare(request.clone()) {
        PrepareOutcome::Hold => {
            *held = Some((request, voice));
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
            let tts = voice.map_or_else(|| tts_slot.lease(), Ok)?;
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
    held: &mut Option<HeldPrepare>,
    core: &mut SessionCore,
    tts_slot: Option<&ConfiguredTtsSlot>,
    input_during_tts_slot: Option<&InputDuringTtsSlot>,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    if !core.user_speaking() && !core.recognition_pending() && active.is_none() {
        if let Some((pending_prepare, voice)) = held.take() {
            process_prepare(
                pending_prepare,
                voice,
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
        VoiceInputEvent::InterimTranscript(text) => write_message(
            writer,
            &SessionMessage::UserInterim {
                token: *next_token,
                text,
            },
        )?,
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
    write_message(writer, &SessionMessage::LiveEvent { token, text })?;
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
    held: &mut Option<HeldPrepare>,
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    if held.as_ref().is_some_and(|(held, _)| held.id == id) {
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

fn handle_cancel_speech(
    id: u64,
    speech_id: u64,
    core: &mut SessionCore,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    let outcome = if active
        .as_ref()
        .is_some_and(|current| current.speech_id == speech_id)
    {
        CancelOutcome::Cancelled
    } else {
        CancelOutcome::Stale
    };
    write_message(
        writer,
        &SessionMessage::CancelResult {
            id,
            outcome,
            speech_id: Some(speech_id),
        },
    )?;
    if outcome == CancelOutcome::Cancelled {
        interrupt_active(core, active, writer)?;
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

struct SessionInputProgress {
    phase: Mutex<(&'static str, Instant)>,
    processed: AtomicU64,
}

impl Default for SessionInputProgress {
    fn default() -> Self {
        Self {
            phase: Mutex::new(("init", Instant::now())),
            processed: AtomicU64::new(0),
        }
    }
}

impl SessionInputProgress {
    fn enter(&self, phase: &'static str) {
        *self
            .phase
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = (phase, Instant::now());
    }

    fn overflow(&self, accepted: u64) -> String {
        // Never wait on the consumer. The phase lock is held only while replacing this tuple.
        let (phase, age) = self
            .phase
            .try_lock()
            .map(|state| (state.0, state.1.elapsed().as_millis()))
            .unwrap_or(("transition", 0));
        // Processed counts dequeued frames, not completed recognition work; this snapshot may race.
        let processed = self.processed.load(Ordering::Relaxed);
        format!("berd-call: PCM overflow accepted={accepted} processed={processed} phase={phase} phase_age_ms={age}")
    }
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
    progress: &SessionInputProgress,
    diagnostics: &mut impl Write,
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
                    let diagnostic = progress.overflow(sent_pcm);
                    let _ = control_sender.send(OrderedControl {
                        after_pcm: sent_pcm,
                        input: Input::Invalid("session PCM input queue is full".into()),
                    });
                    let _ = writeln!(diagnostics, "{diagnostic}");
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
    if header[2] != INPUT_FRAME_MARKER {
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
        | SessionRequest::SetConversationStatus { id, .. }
        | SessionRequest::SetTtsSettings { id, .. }
        | SessionRequest::SetInputDuringTts { id, .. }
        | SessionRequest::ResetInput { id }
        | SessionRequest::PrepareSpeak { id, .. }
        | SessionRequest::OutputReady { id, .. }
        | SessionRequest::QueryState { id, .. }
        | SessionRequest::Cancel { id }
        | SessionRequest::CancelSpeech { id, .. } => Some(*id),
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
        SessionRequest::SetConversationStatus { settings, .. } => {
            settings.validate().map_err(str::to_string)?;
        }
        SessionRequest::PrepareSpeak { text, .. } if text.len() > MAX_SPEAK_TEXT_BYTES => {
            return Err("speak text exceeds 16 KiB".into())
        }
        SessionRequest::OutputReady { speech_id: 0, .. } => {
            return Err("speech id must be positive".into())
        }
        SessionRequest::CancelSpeech { speech_id: 0, .. } => {
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
        let delivery = DeliveryProgress {
            sample_rate: backend.pcm_spec().sample_rate,
            segments: Vec::new(),
        };
        if message == AUDIO_CANCELLED {
            return Ok((false, delivery));
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
    output: &dyn berd_call::PcmAudioOutput,
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
    output: &dyn berd_call::PcmAudioOutput,
    active: &AtomicBool,
    finish_writes: &mut dyn FnMut() -> Result<(), String>,
    on_started: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(bool, DeliveryProgress), PlaybackFailure> {
    use berd_call::{DrainPolicy, DrainTimeoutOutcome, OutboundOutcome, OutboundPlayback};

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
    let completed = (|| {
        if playback
            .synthesize_segment(backend, text, &mut |_| Ok(()), on_started, &mut |_| Ok(()))
            .map_err(|failure| PlaybackFailure {
                message: failure.message,
                output_quiescent: failure.output_quiescent,
            })?
            == OutboundOutcome::Interrupted
        {
            return Ok(false);
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
        Ok(outcome == OutboundOutcome::Completed)
    })();
    match completed {
        Ok(completed) => Ok((completed, playback.snapshot())),
        // Speech the host stopped playing, as when the speakers change, ends where it was cut off, as if you had talked over it.
        Err(failure) if failure.message == AUDIO_HOST_FAILED && failure.output_quiescent => {
            Ok((false, playback.snapshot()))
        }
        Err(failure) => Err(failure),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use berd_call::{PcmAudioOutput, TtsOutcome, TtsPcmSpec};
    use serde_json::{json, Value};
    use std::io::{Cursor, Read, Write};
    use std::os::fd::IntoRawFd;
    use std::os::unix::net::UnixStream;
    use std::sync::Mutex;

    #[test]
    fn standalone_updates_require_a_managed_install_outside_app_bundles() {
        let directory = tempfile::tempdir().unwrap();
        let bin = directory.path().join("bin with spaces");
        std::fs::create_dir_all(bin.join(".berd-call")).unwrap();
        let executable = bin.join("berd-call");
        assert!(standalone_update_helper(&executable).is_none());
        std::fs::write(bin.join(".berd-call/installed"), "0.6.5\n").unwrap();
        std::fs::write(bin.join(".berd-call/update"), "").unwrap();
        assert_eq!(
            standalone_update_helper(&executable),
            Some(bin.join(".berd-call/update"))
        );
        let app = directory.path().join("Buzz.app/Contents/MacOS");
        std::fs::create_dir_all(app.join(".berd-call")).unwrap();
        std::fs::write(app.join(".berd-call/installed"), "0.6.5\n").unwrap();
        std::fs::write(app.join(".berd-call/update"), "").unwrap();
        assert!(standalone_update_helper(&app.join("berd-call")).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn update_check_only_targets_the_owning_app_bundle() {
        let directory = tempfile::tempdir().unwrap();
        let app = directory.path().join("Berd.app");
        let bundle = app.join("Contents/MacOS/berd-call");
        std::fs::create_dir_all(bundle.parent().unwrap()).unwrap();
        std::fs::write(&bundle, []).unwrap();
        assert_eq!(bundled_app_path(&bundle), Some(app.canonicalize().unwrap()));
        assert!(bundled_app_path(Path::new("/tmp/berd-call")).is_none());
        let other = bundle.with_file_name("other");
        std::fs::write(&other, []).unwrap();
        assert!(bundled_app_path(&other).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn update_check_recognizes_a_path_symlink_to_the_bundled_cli() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let app = directory.path().join("Berd.app");
        let executable = app.join("Contents/MacOS/berd-call");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, []).unwrap();
        let link = directory.path().join("berd-call");
        symlink(&executable, &link).unwrap();

        assert_eq!(bundled_app_path(&link), Some(app.canonicalize().unwrap()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn update_lock_still_recognizes_a_bundle_during_replacement() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let app = directory.path().join("Berd.app");
        let executable = app.join("Contents/MacOS/berd-call");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, []).unwrap();
        let link = directory.path().join("berd-call");
        symlink(&executable, &link).unwrap();

        std::fs::remove_file(&executable).unwrap();
        assert_eq!(bundled_app_path(&link), Some(app.clone()));
        assert_eq!(bundled_app_path(&executable), Some(app));
    }

    #[test]
    fn status_cues_ignore_pending_recognition_but_suppress_actual_audio() {
        let mut core = SessionCore::default();
        core.set_recognition_pending(true);
        assert!(!standard_session_status_cues_suppressed(&core, false));
        assert!(standard_session_status_cues_suppressed(&core, true));
        core.set_user_speaking(true);
        assert!(standard_session_status_cues_suppressed(&core, false));
        core.set_user_speaking(false);
        assert!(!standard_session_status_cues_suppressed(&core, false));
    }
    fn synthesis_config(tts: SynthesisTtsConfig, output: PathBuf) -> SynthesisConfig {
        SynthesisConfig {
            tts,
            text: "A bounded test sentence.".into(),
            output,
        }
    }

    #[test]
    fn cli_accepts_auto_input_policy() {
        let (_, request) = parse_host_settings_args(&args(&[
            "berd-call",
            "settings",
            "--input-during-tts",
            "auto",
        ]))
        .unwrap();
        assert!(matches!(
            request,
            host_control::ControlRequest::InputDuringTts {
                policy: InputDuringTtsPolicy::Auto
            }
        ));
    }

    #[test]
    fn parses_closed_synthesis_surface_for_each_backend() {
        let siri = parse_synthesis_args(&args(&[
            "berd-call",
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
            "berd-call",
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
            "berd-call",
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
            let mut values = vec!["berd-call", "synthesize"];
            values.append(&mut flags);
            values.extend(["--text", "hello", "--output", "voice.wav"]);
            assert!(parse_synthesis_args(&args(&values)).is_err(), "{values:?}");
        }
        assert!(parse_synthesis_args(&args(&[
            "berd-call",
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
        assert_eq!(value["result"]["model"], berd_call::pocket_assets::MODEL_ID);
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

    #[test]
    fn a_new_voice_is_built_off_the_session_loop_and_its_request_handed_back() {
        let slot = Arc::new(test_tts_slot());
        let (controls, handed_back) = mpsc::channel::<OrderedControl>();
        let mut builds = VoiceBuilds {
            controls,
            pending: HashSet::new(),
        };
        let mut writer = Vec::new();
        let mut filter = |input, slot| builds.filter(input, slot, &mut writer).unwrap();
        let prepare = |id, voice: &str| {
            Input::Request(SessionRequest::PrepareSpeak {
                id,
                acknowledgement: None,
                text: "Hello.".into(),
                voice: Some(voice.into()),
                language: None,
            })
        };
        let next = || {
            handed_back
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .input
        };
        assert!(filter(prepare(1, "coral"), Some(&slot)).is_none());
        assert!(matches!(
            filter(next(), Some(&slot)),
            Some(Input::Request(SessionRequest::PrepareSpeak { id: 1, .. }))
        ));
        assert!(matches!(
            filter(prepare(2, "coral"), Some(&slot)),
            Some(Input::Request(SessionRequest::PrepareSpeak { id: 2, .. }))
        ));
        assert!(filter(prepare(3, "nobody"), Some(&slot)).is_none());
        assert!(filter(next(), Some(&slot)).is_none());
        // A request cancelled while its voice is built is not revived by the build.
        assert!(filter(prepare(4, "marin"), Some(&slot)).is_none());
        assert!(filter(
            Input::Request(SessionRequest::Cancel { id: 4 }),
            Some(&slot)
        )
        .is_none());
        assert!(filter(next(), Some(&slot)).is_none());
        assert!(filter(prepare(5, "cedar"), None).is_some());
        drop(filter);
        let types: Vec<_> = String::from_utf8(writer)
            .unwrap()
            .lines()
            .map(|line| {
                let message: serde_json::Value = serde_json::from_str(line).unwrap();
                format!(
                    "{} {} {}",
                    message["type"],
                    message["id"],
                    message["reason"]
                        .as_str()
                        .or(message["outcome"].as_str())
                        .unwrap()
                )
            })
            .collect();
        assert_eq!(
            types,
            [
                r#""not_admitted" 3 invalid_voice"#,
                r#""cancel_result" 4 cancelled"#,
                r#""not_admitted" 4 cancelled"#,
            ]
        );
    }

    #[test]
    fn speech_in_another_voice_is_refused_when_the_voice_is_unavailable() {
        let slot = test_tts_slot();
        let mut writer = Vec::new();
        assert!(speak_voice(Some(&slot), None, None, 1, &mut writer)
            .unwrap()
            .unwrap()
            .is_none());
        let coral = speak_voice(Some(&slot), Some("coral".into()), None, 2, &mut writer)
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(coral.snapshot().settings.voice(), "coral");
        assert!(writer.is_empty());
        for (id, slot, voice) in [(3, Some(&slot), "nobody"), (4, None, "coral")] {
            assert!(speak_voice(slot, Some(voice.into()), None, id, &mut writer)
                .unwrap()
                .is_none());
        }
        let refusals = String::from_utf8(writer).unwrap();
        assert_eq!(
            refusals.lines().collect::<Vec<_>>(),
            [
                r#"{"type":"not_admitted","id":3,"reason":"invalid_voice"}"#,
                r#"{"type":"not_admitted","id":4,"reason":"invalid_voice"}"#,
            ]
        );
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
        let snapshot = berd_call::TtsConfigurationSnapshot {
            revision: 1,
            settings: berd_call::TtsSettings::Pocket {
                model: berd_call::pocket_assets::MODEL_ID.into(),
                voice: "mary".into(),
                rate: 1.0,
            },
        };
        let ready = serde_json::to_string(&SessionMessage::Ready {
            id: 1,
            protocol: SESSION_PROTOCOL_VERSION,
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
            parse_management_args(&args(&["berd-call", "voices", "list"])).unwrap(),
            ManagementCommand::ListVoices { language: None }
        );
        assert_eq!(
            parse_management_args(&args(&[
                "berd-call",
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
                "berd-call",
                "voices",
                "download",
                "--voice",
                "Aaron",
                "--language",
                "en_US"
            ]))
            .unwrap(),
            ManagementCommand::DownloadVoice {
                identity: berd_call::siri::SiriVoiceIdentity::new("Aaron", "en-US").unwrap(),
                availability_wait: berd_call::siri::SiriDownloadAvailabilityWait::default(),
            }
        );
        assert_eq!(
            parse_management_args(&args(&[
                "berd-call",
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
                identity: berd_call::siri::SiriVoiceIdentity::new("Aaron", "en-US").unwrap(),
                availability_wait: berd_call::siri::SiriDownloadAvailabilityWait::from_seconds(12)
                    .unwrap(),
            }
        );
        assert_eq!(
            parse_management_args(&args(&["berd-call", "models", "macos", "status"])).unwrap(),
            ManagementCommand::MacosModelStatus
        );
        assert_eq!(
            parse_management_args(&args(&["berd-call", "models", "macos", "install"])).unwrap(),
            ManagementCommand::InstallMacosModel
        );
        assert_eq!(
            parse_management_args(&args(&["berd-call", "models", "openai", "voices"])).unwrap(),
            ManagementCommand::ListOpenAiVoices
        );
        let store = std::env::temp_dir().join("berd-call-management-parser");
        let roots = local_model_roots(&store).unwrap();
        assert_eq!(
            parse_management_args(&args(&[
                "berd-call",
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
                "berd-call",
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
                "berd-call",
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
                "berd-call",
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
            parse_management_args(&args(&["berd-call", "models", "pocket", "voices"])).unwrap(),
            ManagementCommand::ListPocketVoices
        );

        for invalid in [
            vec!["berd-call", "voices", "list", "--language"],
            vec!["berd-call", "voices", "list", "--unknown", "en-US"],
            vec!["berd-call", "voices", "download", "--voice", "Aaron"],
            vec![
                "berd-call",
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
                "berd-call",
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
                "berd-call",
                "voices",
                "download",
                "--voice",
                "aaron ",
                "--language",
                "en-US",
            ],
            vec!["berd-call", "models", "macos", "status", "extra"],
            vec!["berd-call", "models", "pocket", "status"],
            vec![
                "berd-call",
                "models",
                "pocket",
                "status",
                "--store-root",
                "relative",
            ],
            vec![
                "berd-call",
                "models",
                "parakeet",
                "install",
                "--store-root",
                "/tmp/../outside",
            ],
            vec![
                "berd-call",
                "models",
                "pocket",
                "status",
                "--store-root",
                "/tmp/./store",
            ],
            vec!["berd-call", "models", "pocket", "voices", "extra"],
        ] {
            assert!(
                parse_management_args(&args(&invalid)).is_err(),
                "{invalid:?}"
            );
        }
        assert_eq!(
            parse_management_args(&args(&["berd-call", "models", "pocket", "typo"])).unwrap_err(),
            "expected a supported models command"
        );
    }

    #[test]
    fn management_json_schemas_are_stable_and_sanitized() {
        let list = voices_list_report(
            true,
            Some("en-US".into()),
            berd_call::siri::SiriVoiceCatalog {
                available_languages: vec!["en-US".into()],
                voices: vec![berd_call::siri::SiriVoice {
                    name: "Aaron".into(),
                    display_name: "Aaron".into(),
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
                        "displayName": "Aaron",
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
                    "totalDownloadBytes": berd_call::pocket_assets::download_bytes()
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
                operation: "models.openai.voices",
                event: "result",
                result: openai_voices_report(),
            })
            .unwrap(),
            json!({
                "schemaVersion": 1,
                "operation": "models.openai.voices",
                "event": "result",
                "result": {
                    "backend": "openai",
                    "voices": berd_call::openai::OPENAI_VOICE_IDS
                }
            })
        );

        assert_eq!(
            serde_json::to_value(ManagementResultEnvelope {
                schema_version: MANAGEMENT_SCHEMA_VERSION,
                operation: "models.parakeet.install",
                event: "result",
                result: LocalModelInstallResult {
                    backend: "parakeet",
                    model_id: berd_call::parakeet_assets::MODEL_ID,
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

        let identity = berd_call::siri::SiriVoiceIdentity::new("Aaron", "en_US").unwrap();
        assert_eq!(
            serde_json::to_value(ManagementResultEnvelope {
                schema_version: MANAGEMENT_SCHEMA_VERSION,
                operation: "voices.download",
                event: "result",
                result: voice_download_report(
                    &identity,
                    berd_call::siri::SiriDownloadAvailabilityWait::default(),
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

        #[cfg(target_os = "macos")]
        assert_eq!(
            serde_json::to_value(ManagementResultEnvelope {
                schema_version: MANAGEMENT_SCHEMA_VERSION,
                operation: "voices.preview",
                event: "result",
                result: VoicePreviewResult {
                    backend: "siri",
                    voice: identity,
                    rate: 1.5,
                    source: berd_call::siri::SiriPreviewSource::Sample,
                },
            })
            .unwrap(),
            json!({
                "schemaVersion": 1,
                "operation": "voices.preview",
                "event": "result",
                "result": {
                    "backend": "siri",
                    "voice": {"name": "Aaron", "language": "en-US"},
                    "rate": 1.5,
                    "source": "sample"
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

        let missing = voice_download_failure(berd_call::siri::SiriVoiceDownloadError::NotFound(
            berd_call::siri::SiriVoiceIdentity::new("Missing", "en-US").unwrap(),
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
        let missing_voice = parse_args(&args(&["berd-call", "session"])).unwrap_err();
        assert!(missing_voice.contains("Siri TTS is the default"));
        assert!(missing_voice.contains("--voice NAME and --language BCP47"));

        assert_eq!(
            parse_args(&args(&[
                "berd-call",
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
                stt_hints: vec![],
                endpoints: SessionEndpointOverrides::default(),
            }
        );

        assert_eq!(
            parse_args(&args(&["berd-call", "session", "--tts-backend", "openai"])).unwrap(),
            SessionConfig {
                tts: TtsBackendConfig::OpenAi { rate: 1.0 },
                stt: SttBackendConfig::Macos,
                stt_hints: vec![],
                endpoints: SessionEndpointOverrides::default(),
            }
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_default_availability_errors_are_actionable() {
        let unavailable_siri = create_tts_backend(&TtsBackendConfig::Siri {
            voice: "__berd_call_does_not_exist__".into(),
            language: "en-US".into(),
            rate: 1.0,
        })
        .err()
        .unwrap();
        assert!(unavailable_siri.contains("is unavailable"));
        assert!(unavailable_siri.contains("Download it in Berd Voice settings"));

        let status = |supported: bool, locale_supported: bool, model_status: &str, ready: bool| {
            berd_call::mac_speech::MacSpeechEngineStatus {
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
                "berd-call",
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
                stt_hints: vec![],
                endpoints: SessionEndpointOverrides::default(),
            }
        );
        assert!(parse_args(&args(&[
            "berd-call",
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
                "berd-call",
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
            "berd-call",
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
    fn session_endpoint_overrides_are_independent_and_require_matching_backends() {
        let overrides = parse_args(&args(&[
            "berd-call",
            "session",
            "--tts-backend",
            "openai",
            "--stt-backend",
            "openai",
            "--tts-url",
            "https://proxy.example/v1/audio/speech?api-version=1",
            "--stt-url",
            "wss://proxy.example/v1/realtime?intent=transcription",
        ]))
        .unwrap();
        assert_eq!(
            overrides.endpoints.tts.as_deref(),
            Some("https://proxy.example/v1/audio/speech?api-version=1")
        );
        assert_eq!(
            overrides.endpoints.stt.as_deref(),
            Some("wss://proxy.example/v1/realtime?intent=transcription")
        );
        assert!(parse_endpoint_url("http://example.test/speech", "--tts-url", false).is_err());
        assert!(parse_endpoint_url("ws://example.test/realtime", "--stt-url", true).is_err());
        assert!(parse_endpoint_url("http://127.0.0.1:18870/speech", "--tts-url", false).is_ok());
        assert!(parse_args(&args(&[
            "berd-call",
            "session",
            "--tts-url",
            "wss://localhost/audio/speech"
        ]))
        .is_err());
        assert!(parse_args(&args(&[
            "berd-call",
            "session",
            "--tts-backend",
            "openai",
            "--stt-url",
            "wss://localhost/realtime"
        ]))
        .unwrap_err()
        .contains("--stt-backend openai"));
    }

    #[test]
    fn cli_requires_explicit_pocket_bundle_and_voice() {
        assert_eq!(
            parse_args(&args(&[
                "berd-call",
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
                stt_hints: vec![],
                endpoints: SessionEndpointOverrides::default(),
            }
        );
        assert!(parse_args(&args(&[
            "berd-call",
            "session",
            "--tts-backend",
            "pocket",
            "--voice",
            "george"
        ]))
        .unwrap_err()
        .contains("--model-dir is required"));
        assert!(parse_args(&args(&[
            "berd-call",
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
            "berd-call",
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
                "berd-call",
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
                },
                stt_hints: vec![],
                endpoints: SessionEndpointOverrides::default(),
            }
        );
        assert!(parse_args(&args(&[
            "berd-call",
            "session",
            "--tts-backend",
            "openai",
            "--stt-backend",
            "parakeet"
        ]))
        .unwrap_err()
        .contains("--stt-model-dir is required"));
        assert!(parse_args(&args(&[
            "berd-call",
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
            "berd-call",
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
                "berd-call",
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
            "berd-call",
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
            "berd-call",
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
            "berd-call",
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
            "berd-call",
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
            "berd-call",
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
            "berd-call",
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
            "berd-call",
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
            "berd-call",
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
            "berd-call",
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
            "berd-call".into(),
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
                "berd-call",
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
            "berd-call",
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
            "berd-call",
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
            "berd-call",
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
            "berd-call",
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
                "berd-call",
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
                stt: SttBackendConfig::OpenAi,
                stt_hints: vec![],
                endpoints: SessionEndpointOverrides::default(),
            }
        );
    }

    #[test]
    fn session_requires_one_inherited_pcm_output_descriptor() {
        assert_eq!(
            parse_pcm_output_fd(&args(&["berd-call", "session", "--pcm-output-fd", "9"])).unwrap(),
            9
        );
        assert_eq!(
            parse_pcm_output_fd(&args(&["berd-call", "session"])).unwrap_err(),
            "--pcm-output-fd is required"
        );
        assert!(
            parse_pcm_output_fd(&args(&["berd-call", "session", "--pcm-output-fd", "2"])).is_err()
        );
        assert!(parse_pcm_output_fd(&args(&[
            "berd-call",
            "session",
            "--pcm-output-fd",
            "7",
            "--pcm-output-fd",
            "8"
        ]))
        .is_err());
    }

    fn framed(kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::from([b'B', b'V', INPUT_FRAME_MARKER, kind]);
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

        read_framed_requests(
            Cursor::new(bytes),
            control_sender,
            pcm_sender,
            &SessionInputProgress::default(),
            &mut Vec::new(),
        );

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
            let mut header = Vec::from([b'B', b'V', INPUT_FRAME_MARKER, kind]);
            header.extend_from_slice(&(length as u32).to_le_bytes());
            let (control_sender, control_receiver) = mpsc::channel();
            let (pcm_sender, _pcm_receiver) = mpsc::sync_channel(1);
            read_framed_requests(
                Cursor::new(header),
                control_sender,
                pcm_sender,
                &SessionInputProgress::default(),
                &mut Vec::new(),
            );
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

        read_framed_requests(
            Cursor::new(bytes),
            control_sender,
            pcm_sender,
            &SessionInputProgress::default(),
            &mut Vec::new(),
        );

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
    fn pcm_overflow_reports_fatal_before_blocked_diagnostics() {
        struct GatedWriter(Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>);
        impl Write for GatedWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if let Some((entered, release)) = self.0.take() {
                    entered.send(()).unwrap();
                    release.recv_timeout(Duration::from_secs(2)).unwrap();
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let (control_tx, control_rx) = mpsc::channel();
        let (pcm_tx, _pcm_rx) = mpsc::sync_channel(1);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let bytes = framed(PCM_FRAME_KIND, &[0_u8; PCM_FRAME_BYTES]).repeat(2);
        let worker = thread::spawn(move || {
            read_framed_requests(
                Cursor::new(bytes),
                control_tx,
                pcm_tx,
                &SessionInputProgress::default(),
                &mut GatedWriter(Some((entered_tx, release_rx))),
            );
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let terminal = control_rx.try_recv();
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        let terminal = terminal.expect("blocked diagnostics must not delay fatal control");
        assert_eq!(terminal.after_pcm, 1);
        assert!(matches!(terminal.input, Input::Invalid(_)));
    }

    #[test]
    fn pcm_overflow_diagnostic_does_not_wait_for_a_phase_transition() {
        let progress = SessionInputProgress::default();
        let _transition = progress.phase.lock().unwrap();
        assert_eq!(
            progress.overflow(32),
            "berd-call: PCM overflow accepted=32 processed=0 phase=transition phase_age_ms=0"
        );
    }

    #[test]
    fn pcm_overflow_reports_stalled_phase_without_reordering_input() {
        struct GatedReader {
            first: Cursor<Vec<u8>>,
            rest: Cursor<Vec<u8>>,
            reached: mpsc::Sender<()>,
            resume: mpsc::Receiver<()>,
            resumed: bool,
        }
        impl Read for GatedReader {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                if self.first.position() < self.first.get_ref().len() as u64 {
                    return self.first.read(bytes);
                }
                if !self.resumed {
                    self.reached.send(()).unwrap();
                    self.resume.recv_timeout(Duration::from_secs(2)).unwrap();
                    self.resumed = true;
                }
                self.rest.read(bytes)
            }
        }
        let frame = framed(PCM_FRAME_KIND, &[0_u8; PCM_FRAME_BYTES]);
        let mut rest = frame.repeat(INPUT_QUEUE_CAPACITY + 1);
        rest.extend_from_slice(&framed(JSON_FRAME_KIND, br#"{"type":"shutdown"}"#));
        let (reached_tx, reached_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let reader = GatedReader {
            first: Cursor::new(frame),
            rest: Cursor::new(rest),
            reached: reached_tx,
            resume: resume_rx,
            resumed: false,
        };
        let progress = Arc::new(SessionInputProgress::default());
        let reader_progress = Arc::clone(&progress);
        let (control_tx, control_rx) = mpsc::channel();
        let (pcm_tx, pcm_rx) = mpsc::sync_channel(INPUT_QUEUE_CAPACITY);
        let worker = thread::spawn(move || {
            let mut diagnostics = Vec::new();
            read_framed_requests(
                reader,
                control_tx,
                pcm_tx,
                &reader_progress,
                &mut diagnostics,
            );
            diagnostics
        });
        reached_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut pending = None;
        let mut processed = 0;
        assert!(matches!(
            receive_session_input(&control_rx, &pcm_rx, &mut pending, &mut processed),
            Some(Input::Pcm(_))
        ));
        progress.processed.store(processed, Ordering::Relaxed);
        *progress.phase.lock().unwrap() =
            ("status_sounds", Instant::now() - Duration::from_secs(1));
        resume_tx.send(()).unwrap();
        let control = control_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(control.after_pcm, 1 + INPUT_QUEUE_CAPACITY as u64);
        assert!(
            matches!(control.input, Input::Invalid(ref message) if message == "session PCM input queue is full")
        );
        assert!(control_rx.recv_timeout(Duration::from_secs(2)).is_err());
        let diagnostic = String::from_utf8(worker.join().unwrap()).unwrap();
        assert!(
            diagnostic.starts_with(
                "berd-call: PCM overflow accepted=33 processed=1 phase=status_sounds phase_age_ms="
            ),
            "{diagnostic:?}"
        );
        assert!(
            diagnostic
                .trim()
                .rsplit('=')
                .next()
                .unwrap()
                .parse::<u64>()
                .unwrap()
                >= 1000
        );
        assert_eq!(diagnostic.lines().count(), 1);
        assert!(diagnostic.len() < 200);
        // The fatal control remains behind every accepted frame.
        pending = Some(control);
        for _ in 0..INPUT_QUEUE_CAPACITY {
            assert!(matches!(
                receive_session_input(&control_rx, &pcm_rx, &mut pending, &mut processed),
                Some(Input::Pcm(_))
            ));
        }
        assert!(matches!(
            receive_session_input(&control_rx, &pcm_rx, &mut pending, &mut processed),
            Some(Input::Invalid(_))
        ));
    }

    #[test]
    fn status_sound_requests_validate_volume() {
        for volume in [-1.0, 2.0, f32::NAN, f32::INFINITY] {
            let request = SessionRequest::SetConversationStatus {
                id: 1,
                status: berd_call::ConversationStatus::Working,
                settings: berd_call::StatusSoundSettings {
                    volume,
                    ..Default::default()
                },
            };
            assert_eq!(
                validate_request(request).unwrap_err(),
                "status sound volume must be finite and between 0 and 1"
            );
        }
        for volume in [0.0, 0.8, 1.0] {
            assert!(validate_request(SessionRequest::SetConversationStatus {
                id: 1,
                status: berd_call::ConversationStatus::Working,
                settings: berd_call::StatusSoundSettings {
                    volume,
                    ..Default::default()
                },
            })
            .is_ok());
        }
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
            None,
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
            None,
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
                berd_call::TtsSettings::OpenAi {
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
                berd_call::TtsSettings::OpenAi {
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
    fn speech_targeted_cancel_orders_result_before_terminal() {
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
        let mut output = Vec::new();

        handle_cancel_speech(9, speech_id, &mut core, &mut active, &mut output).unwrap();

        assert_eq!(
            messages(&output),
            [
                json!({"type":"cancel_result","id":9,"outcome":"cancelled","speech_id":1}),
                json!({"type":"speech_interrupted","id":7,"speech_id":1,"spoken_through_utf8":0}),
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
            ["live_event", "speech_interrupted"]
        );
        assert_eq!(core.utterances_after(0)[0].token, 1);
    }

    #[test]
    fn interim_words_carry_the_token_their_final_will_take() {
        let mut core = SessionCore::default();
        let mut active = None;
        let mut output = Vec::new();
        let mut next_token = 7;
        handle_voice_input_event(
            VoiceInputEvent::InterimTranscript("you sh".into()),
            &mut core,
            &mut active,
            &mut next_token,
            &mut output,
        )
        .unwrap();
        assert_eq!(next_token, 7);
        store_and_publish_voice_final(
            "you should".into(),
            || {},
            &mut core,
            &mut active,
            &mut next_token,
            &mut output,
        )
        .unwrap();
        let messages: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            messages[0],
            json!({"type":"user_interim","token":7,"text":"you sh"})
        );
        assert_eq!(messages[1]["type"], "live_event");
        assert_eq!(messages[1]["token"], 7);
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

    #[test]
    fn start_parser_keeps_only_session_options_for_the_child() {
        let parsed = parse_start_args(&args(&[
            "berd-call",
            "start",
            "--port",
            "5300",
            "--stream",
            "--voice",
            "Aaron",
            "--language",
            "en-US",
        ]))
        .unwrap();
        assert_eq!(parsed.port, 5300);
        assert_eq!(parsed.transcript, TranscriptDestination::Stdout);
        assert_eq!(
            parsed.session_arguments,
            ["session", "--voice", "Aaron", "--language", "en-US"]
        );
        assert!(parse_start_args(&args(&[
            "berd-call",
            "start",
            "--voice",
            "Aaron",
            "--language",
            "en-US",
            "--pcm-output-fd",
            "9",
        ]))
        .is_err());
    }

    #[test]
    fn start_parser_accepts_one_transcript_destination() {
        let start = |flags: &[&str]| {
            let mut all = vec!["berd-call", "start"];
            all.extend_from_slice(flags);
            all.extend(["--voice", "Aaron", "--language", "en-US"]);
            parse_start_args(&args(&all))
        };
        let parsed = start(&["--codex", "--non-blocking"]).unwrap();
        assert_eq!(parsed.transcript, TranscriptDestination::Codex);
        assert!(parsed.non_blocking);
        let parsed = start(&["--stream", "--non-blocking"]).unwrap();
        assert_eq!(parsed.transcript, TranscriptDestination::Stdout);
        assert_eq!(
            parsed.session_arguments[1..],
            ["--voice", "Aaron", "--language", "en-US"]
        );
        assert!(start(&["--codex", "--stream"]).is_err());
        assert!(start(&["--codex", "--codex"]).is_err());
        assert!(start(&["--non-blocking"]).is_err());
    }

    #[test]
    fn start_parser_shows_the_menu_bar_unless_disabled() {
        let start = |flags: &[&str]| {
            let mut all = vec!["berd-call", "start"];
            all.extend_from_slice(flags);
            all.extend(["--voice", "Aaron", "--language", "en-US"]);
            parse_start_args(&args(&all))
        };
        assert!(start(&[]).unwrap().menu_bar);
        let parsed = start(&["--no-menu-bar"]).unwrap();
        assert!(!parsed.menu_bar);
        assert!(!parsed
            .session_arguments
            .iter()
            .any(|arg| arg == "--no-menu-bar"));
        assert!(start(&["--no-menu-bar", "--no-menu-bar"]).is_err());
    }

    #[test]
    fn settings_rate_changes_only_the_speech_rate() {
        let (_, request) =
            parse_host_settings_args(&args(&["berd-call", "settings", "--rate", "1.5"])).unwrap();
        assert!(matches!(request, host_control::ControlRequest::Rate { rate } if rate == 1.5));
        assert!(
            parse_host_settings_args(&args(&["berd-call", "settings", "--rate", "fast"])).is_err()
        );
    }

    #[test]
    fn saved_start_restores_preferences_but_not_agent_routing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        saved_settings::save(
            &path,
            &saved_settings::SavedSettings {
                arguments: args(&["--voice", "Aaron", "--language", "en-US", "--rate", "1.5"]),
                tts: Some(TtsSettings::Siri {
                    voice: "Aaron".into(),
                    language: "en-US".into(),
                    rate: 1.5,
                }),
                input_policy: Some(berd_call::input::InputDuringTtsPolicy::SuppressInput),
                status_sounds: None,
                ..Default::default()
            },
        )
        .unwrap();
        let restored =
            parse_saved_start_args_at(&args(&["berd-call", "start"]), path.clone()).unwrap();
        assert_eq!(restored.transcript, TranscriptDestination::None);
        assert_eq!(restored.saved.unwrap().1.tts.unwrap().rate(), 1.5);
        let changed = parse_saved_start_args_at(
            &args(&["berd-call", "start", "--rate", "1.2", "--codex"]),
            path,
        )
        .unwrap();
        assert_eq!(changed.transcript, TranscriptDestination::Codex);
        let saved = changed.saved.unwrap().1;
        assert_eq!(saved.tts.unwrap().rate(), 1.2);
        assert!(!saved.arguments.contains(&"--codex".into()));
        let with_endpoint = parse_saved_start_args_at(
            &args(&[
                "berd-call",
                "start",
                "--stt-backend",
                "openai",
                "--stt-url",
                "wss://proxy.example/v1/realtime?intent=transcription",
            ]),
            directory.path().join("settings.json"),
        )
        .unwrap();
        assert!(with_endpoint
            .session_arguments
            .contains(&"--stt-url".into()));
        assert!(!with_endpoint
            .saved
            .unwrap()
            .1
            .arguments
            .contains(&"--stt-url".into()));
    }

    #[test]
    fn polling_options_reject_duplicates_and_use_camel_case_wire_fields() {
        for (flag, value) in [("--port", "5338"), ("--since", "9"), ("--timeout", "2")] {
            assert!(
                parse_poll_input_args(
                    false,
                    &args(&["berd-call", "catch-up", flag, value, flag, value])
                )
                .is_err(),
                "accepted duplicate {flag}"
            );
        }
        let (_, request) = parse_poll_input_args(false, &args(&["berd-call", "catch-up"])).unwrap();
        let wire = serde_json::to_value(request).unwrap();
        assert_eq!(wire["timeoutSeconds"], 30);
        assert!(wire.get("timeout_seconds").is_none());
    }

    #[test]
    fn polling_options_preserve_cursor_and_bound_timeout() {
        let (port, request) = parse_poll_input_args(
            true,
            &args(&[
                "berd-call",
                "wait-for-input",
                "--port",
                "5338",
                "--since",
                "9",
                "--timeout",
                "2",
            ]),
        )
        .unwrap();
        assert_eq!(port, 5338);
        assert!(matches!(
            request,
            host_control::ControlRequest::PollInput {
                since: Some(9),
                wait: true,
                timeout_seconds: 2
            }
        ));
        let (_, request) = parse_poll_input_args(false, &args(&["berd-call", "catch-up"])).unwrap();
        assert!(matches!(
            request,
            host_control::ControlRequest::PollInput {
                since: None,
                wait: false,
                timeout_seconds: 30
            }
        ));
        for invalid in ["0", "3601", "-1", "NaN"] {
            assert!(parse_poll_input_args(
                true,
                &args(&["berd-call", "wait-for-input", "--timeout", invalid])
            )
            .is_err());
        }
    }

    #[test]
    fn voice_setting_accepts_locale_without_other_settings() {
        let (_, request) = parse_host_settings_args(&args(&[
            "berd-call",
            "settings",
            "--language",
            "en-GB",
            "--voice",
            "Daniel",
        ]))
        .unwrap();
        assert!(
            matches!(request, host_control::ControlRequest::Voice { voice, language: Some(language) } if voice == "Daniel" && language == "en-GB")
        );
        assert!(parse_host_settings_args(&args(&[
            "berd-call",
            "settings",
            "--language",
            "en-GB",
            "--rate",
            "1.2"
        ]))
        .is_err());
    }

    #[test]
    fn control_command_parsers_are_closed_and_correlated() {
        let (port, request) = parse_host_settings_args(&args(&[
            "berd-call",
            "settings",
            "--port",
            "5340",
            "--tts",
            r#"{"backend":"siri","voice":"Aaron","language":"en-US","rate":1.5}"#,
        ]))
        .unwrap();
        assert_eq!(port, 5340);
        assert!(
            matches!(request, host_control::ControlRequest::TtsSettings { settings: TtsSettings::Siri { rate, .. } } if rate == 1.5)
        );
        assert!(
            parse_host_settings_args(&args(&["berd-call", "settings", "--tts", "{}"])).is_err()
        );
        assert!(matches!(
            parse_host_settings_args(&args(&[
                "berd-call",
                "settings",
                "--input-during-tts",
                "suppress",
            ]))
            .unwrap()
            .1,
            host_control::ControlRequest::InputDuringTts {
                policy: berd_call::input::InputDuringTtsPolicy::SuppressInput
            }
        ));
        assert!(matches!(
            parse_host_settings_args(&args(&["berd-call", "settings", "--muted", "true"]))
                .unwrap()
                .1,
            host_control::ControlRequest::Muted { muted: true }
        ));
        assert!(matches!(
            parse_host_settings_args(&args(&[
                "berd-call",
                "settings",
                "--status-sounds",
                "working-and-waiting",
            ]))
            .unwrap()
            .1,
            host_control::ControlRequest::StatusSounds {
                mode: Some(berd_call::StatusSoundMode::WorkingAndWaiting),
                status: None,
            }
        ));
        assert!(matches!(
            parse_host_settings_args(&args(&[
                "berd-call",
                "settings",
                "--conversation-status",
                "waiting",
            ]))
            .unwrap()
            .1,
            host_control::ControlRequest::StatusSounds {
                mode: None,
                status: Some(berd_call::ConversationStatus::Waiting),
            }
        ));
        for (flag, value) in [
            ("--status-sounds", "loud"),
            ("--conversation-status", "idle"),
        ] {
            assert!(
                parse_host_settings_args(&args(&["berd-call", "settings", flag, value])).is_err()
            );
        }
        assert!(matches!(
            parse_host_settings_args(&args(&[
                "berd-call",
                "settings",
                "--port",
                "5340",
                "--restart",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
                "--rate",
                "1.25",
            ]))
            .unwrap(),
            (5340, host_control::ControlRequest::Restart { session_arguments })
                if session_arguments.last().map(String::as_str) == Some("1.25")
        ));
        assert!(parse_host_settings_args(&args(&[
            "berd-call",
            "settings",
            "--restart",
            "--rate",
            "fast",
        ]))
        .is_err());
        assert!(parse_host_settings_args(&args(&[
            "berd-call",
            "settings",
            "--non-blocking",
            "true",
            "--tts",
            r#"{"backend":"siri","voice":"Aaron","language":"en-US","rate":1.5}"#
        ]))
        .is_err());
        assert!(parse_speak_control_args(&args(&[
            "berd-call",
            "speak",
            "--non-blocking",
            "hello"
        ]))
        .is_err());
        assert!(parse_speak_control_args(&args(&[
            "berd-call",
            "speak",
            "--non-blocking",
            "--non-blocking",
            "hello"
        ]))
        .is_err());
        assert_eq!(
            parse_speak_control_args(&args(&[
                "berd-call",
                "speak",
                "--port",
                "5300",
                "--re",
                "17",
                "--voice",
                "Nora",
                "--language",
                "en-GB",
                "hello",
            ]))
            .unwrap(),
            SpeakOptions {
                port: 5300,
                acknowledgement: Some(17),
                voice: Some("Nora".into()),
                language: Some("en-GB".into()),
                text: "hello".into(),
            }
        );
        assert!(parse_speak_control_args(&args(&[
            "berd-call",
            "speak",
            "--language",
            "en-GB",
            "hello"
        ]))
        .is_err());
        assert_eq!(
            parse_control_port(&args(&["berd-call", "status", "--port", "5301"])).unwrap(),
            5301
        );
        assert!(
            parse_speak_control_args(&args(&["berd-call", "speak", "--legacy", "hello",])).is_err()
        );
        assert!(parse_control_port(&args(&["berd-call", "stop", "extra"])).is_err());
    }
}

#[cfg(test)]
mod speech_hint_tests {
    use super::*;

    #[test]
    fn speech_hints_are_bounded_and_preserve_names() {
        let args = |hints: &[&str]| {
            [
                "berd-call",
                "session",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
            ]
            .into_iter()
            .chain(hints.iter().flat_map(|hint| ["--stt-hint", *hint]))
            .map(String::from)
            .collect::<Vec<_>>()
        };
        assert_eq!(
            parse_args(&args(&["Nora", " Aaron ", "Nora"]))
                .unwrap()
                .stt_hints,
            ["Nora", "Aaron"]
        );
        assert!(parse_args(&args(&[""])).is_err());
        assert!(parse_args(&args(&[&"a".repeat(257)])).is_err());
        let many = (0..101).map(|i| format!("agent{i}")).collect::<Vec<_>>();
        assert!(parse_args(&args(&many.iter().map(String::as_str).collect::<Vec<_>>())).is_err());
    }
}
