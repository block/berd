use std::io::{self, BufWriter, Read, Write};
use std::path::PathBuf;
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
    AssistantActivityGuard, VoiceInputConfig, VoiceInputControls, VoiceInputEngineConfig,
    VoiceInputEvent, VoiceInputFrame, VoiceInputRuntime, INPUT_FRAME_SAMPLES,
};
use berd_voice::protocol::{
    CancelOutcome, NotAdmittedReason, OutputReadyOutcome, SessionMessage, SessionRequest,
    TtsSettingsOutcome, VoiceSessionSnapshot,
};
use berd_voice::session::{PrepareOutcome, PrepareRequest, SessionCore};
use berd_voice::{
    ConfiguredTtsSlot, TtsBackend, TtsConfiguration, TtsConfigurationLease,
    TtsConfigurationRejection, TtsConfigurationRejectionKind, POCKET_TTS_MODEL_ID,
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
const SHUTDOWN_PLAYBACK_TIMEOUT: Duration = Duration::from_secs(2);
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

#[derive(Debug)]
enum PlaybackEvent {
    Started(u64),
    Completed(u64),
    Interrupted(u64),
    Failed(u64, String),
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
    output_device: Option<String>,
    active: Option<Arc<AtomicBool>>,
    ready_deadline: Instant,
    assistant_activity: Option<AssistantActivityGuard>,
    tts: TtsConfigurationLease,
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

fn main() {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("session") => {
            let config = parse_args(&args).unwrap_or_else(|error| usage_error(&error));
            if let Err(error) = run_session(config) {
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
        _ => usage_error("supported commands are session, benchmark tts, and benchmark stt"),
    }
}

fn usage_error(error: &str) -> ! {
    eprintln!("{error}");
    eprintln!(
        "usage:\n  berd-voice session [--tts-backend siri|openai|pocket] \
         [--model-dir PATH] [--voice ID] [--language BCP47] [--rate FLOAT] \
         [--stt-backend macos|parakeet|openai] [--stt-model-dir PATH]\n  \
         berd-voice benchmark tts --tts-backend openai|siri|pocket \
         [--model-dir PATH] [--voice ID] [--language BCP47] [--rate FLOAT] \
         (--text TEXT --runs COUNT | --prompt-manifest english-short-v1) \
         --mode fresh-backend|warm [--allow-paid-openai]\n  \
         berd-voice benchmark stt --stt-backend macos|parakeet|openai \
         [--stt-model-dir PATH] --runs COUNT --mode cold|warm \
         [--allow-paid-openai]"
    );
    std::process::exit(2);
}

fn run_session(config: SessionConfig) -> Result<(), String> {
    let (input_tx, input_rx) = mpsc::sync_channel(INPUT_QUEUE_CAPACITY);
    thread::spawn(move || read_framed_requests(io::stdin().lock(), input_tx));
    let (playback_tx, playback_rx) = mpsc::channel();
    let (tts_configuration_tx, tts_configuration_rx) = mpsc::channel::<TtsConfigurationEvent>();
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    let mut core = SessionCore::default();
    let mut initialized = false;
    let mut tts_slot: Option<Arc<ConfiguredTtsSlot>> = None;
    let mut tts_update: Option<ActiveTtsConfigurationUpdate> = None;
    let mut next_tts_update_attempt = 1_u64;
    let mut input_runtime: Option<VoiceInputRuntime> = None;
    let mut input_events: Option<tokio::sync::mpsc::Receiver<VoiceInputEvent>> = None;
    let mut input_controls: Option<VoiceInputControls> = None;
    let mut next_input_token = 1_u64;
    let mut output_device = None;
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
        while let Ok(event) = playback_rx.try_recv() {
            handle_playback_event(event, &mut core, &mut active, &mut writer)?;
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
            &output_device,
            tts_slot.as_deref(),
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

        let input = match input_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(input) => input,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => Input::Eof,
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
                output_device: requested,
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
                if let Err(message) = validate_output_device(requested.as_deref()) {
                    write_protocol_fatal(
                        &mut writer,
                        "selected audio output is unavailable",
                        &message,
                    )?;
                    return Ok(());
                }
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
                if let Err(message) = wait_for_input_ready(&mut events) {
                    runtime.cancel();
                    write_protocol_fatal(
                        &mut writer,
                        &public_stt_startup_error(&config.stt),
                        &format!("STT readiness failed: {message}"),
                    )?;
                    return Ok(());
                }
                input_controls = Some(runtime.controls());
                input_runtime = Some(runtime);
                input_events = Some(events);
                initialized = true;
                output_device = requested;
                let session = VoiceSessionSnapshot {
                    tts: slot.snapshot()?,
                };
                tts_slot = Some(slot);
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
                input_controls
                    .as_ref()
                    .expect("hello initialized input controls")
                    .set_muted(muted);
                write_message(
                    &mut writer,
                    &SessionMessage::InputMuteApplied { id, active: muted },
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
            Input::Request(SessionRequest::ResetInput { id }) => {
                input_controls
                    .as_ref()
                    .expect("hello initialized input controls")
                    .reset();
                write_message(&mut writer, &SessionMessage::InputResetApplied { id })?;
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
                        &output_device,
                        tts_slot.as_deref().expect("hello initialized TTS"),
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
                    write_message(
                        &mut writer,
                        &SessionMessage::OutputReadyResult {
                            id,
                            speech_id,
                            outcome: OutputReadyOutcome::Accepted,
                        },
                    )?;
                    current.assistant_activity = input_controls.as_ref().map(|controls| {
                        controls
                            .begin_assistant_activity(0.65)
                            .expect("balanced assistant threshold is valid")
                    });
                    let playback_active = Arc::new(AtomicBool::new(true));
                    current.active = Some(Arc::clone(&playback_active));
                    spawn_playback(
                        speech_id,
                        current.text.clone(),
                        current.output_device.clone(),
                        Arc::clone(current.tts.backend()),
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
            Input::Request(SessionRequest::QueryState { id, after }) => {
                write_state(&mut writer, id, after, &core)?
            }
            Input::Request(SessionRequest::Cancel { id }) => {
                handle_cancel(id, &mut held, &mut core, &mut active, &mut writer)?;
            }
        }
    }
}

fn wait_for_input_ready(
    events: &mut tokio::sync::mpsc::Receiver<VoiceInputEvent>,
) -> Result<(), String> {
    match events.blocking_recv() {
        Some(VoiceInputEvent::Ready) => Ok(()),
        Some(VoiceInputEvent::Failed(message)) => Err(message),
        Some(_) => Err("voice input emitted data before readiness".into()),
        None => Err("voice input stopped before readiness".into()),
    }
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
            _ => return Err(format!("unknown argument: {flag}")),
        }
        index += 2;
    }
    let tts = build_tts_backend_config(backend, voice, language, model_dir, rate)?;
    let stt = build_stt_backend_config(stt_backend, stt_model_dir)?;
    Ok(SessionConfig { tts, stt })
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
        TtsBackendConfig::OpenAi { .. } => TtsBenchmarkTarget {
            backend: "openai".into(),
            model: Some(
                std::env::var("OPENAI_TTS_MODEL").unwrap_or_else(|_| "gpt-4o-mini-tts".into()),
            ),
            voice: Some(std::env::var("OPENAI_TTS_VOICE").unwrap_or_else(|_| "marin".into())),
            language: None,
            rate: Some(1.0),
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
        TtsBackendConfig::OpenAi { rate } => {
            let api_key = std::env::var("OPENAI_API_KEY")
                .ok()
                .filter(|key| !key.trim().is_empty())
                .ok_or_else(|| "OPENAI_API_KEY is required".to_string())?;
            let base = std::env::var("OPENAI_BASE_URL")
                .unwrap_or_else(|_| "https://api.openai.com/v1".into());
            Ok(TtsConfiguration::openai(
                format!("{}/audio/speech", base.trim_end_matches('/')),
                api_key,
                std::env::var("OPENAI_TTS_MODEL").unwrap_or_else(|_| "gpt-4o-mini-tts".into()),
                std::env::var("OPENAI_TTS_VOICE").unwrap_or_else(|_| "marin".into()),
                *rate,
            ))
        }
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
            POCKET_TTS_MODEL_ID.into(),
            voice.clone(),
            *rate,
        )),
    }
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

#[cfg(target_os = "macos")]
fn validate_output_device(name: Option<&str>) -> Result<(), String> {
    let Some(name) = name else { return Ok(()) };
    coreaudio::audio_unit::macos_helpers::get_device_id_from_name(name, false)
        .map(|_| ())
        .ok_or_else(|| format!("audio output not found: {name}"))
}

#[cfg(not(target_os = "macos"))]
fn validate_output_device(name: Option<&str>) -> Result<(), String> {
    if name.is_some() {
        Err("named audio output is only available on macOS".into())
    } else {
        Ok(())
    }
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
    output_device: &Option<String>,
    tts_slot: &ConfiguredTtsSlot,
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
            *active = Some(ActivePlayback {
                prepare_id: id,
                speech_id,
                text,
                output_device: output_device.clone(),
                active: None,
                ready_deadline: Instant::now() + Duration::from_secs(2),
                assistant_activity: None,
                tts,
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
    output_device: &Option<String>,
    tts_slot: Option<&ConfiguredTtsSlot>,
    active: &mut Option<ActivePlayback>,
    writer: &mut impl Write,
) -> Result<(), String> {
    if !core.user_speaking() && !core.recognition_pending() && active.is_none() {
        if let Some(pending_prepare) = held.take() {
            process_prepare(
                pending_prepare,
                core,
                output_device,
                tts_slot.expect("held prepare requires initialized TTS"),
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
            let interrupts = core.set_user_speaking(speaking);
            write_message(writer, &SessionMessage::InputSpeaking { active: speaking })?;
            if interrupts {
                interrupt_active(core, active, writer)?;
            }
        }
        VoiceInputEvent::RecognitionPendingChanged(pending) => {
            let interrupts = core.set_recognition_pending(pending);
            write_message(
                writer,
                &SessionMessage::RecognitionPending { active: pending },
            )?;
            if interrupts {
                interrupt_active(core, active, writer)?;
            }
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
            .and_then(|runtime_handle| runtime_handle.block_on(runtime.finish()));
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
        PlaybackEvent::Started(speech_id) => {
            if core.mark_started(speech_id) {
                let id = active.as_ref().map_or(0, |current| current.prepare_id);
                write_message(writer, &SessionMessage::SpeechStarted { id, speech_id })?;
            }
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
        PlaybackEvent::Interrupted(speech_id) => {
            let id = active.as_ref().map_or(0, |current| current.prepare_id);
            finish_playback(
                core,
                active,
                speech_id,
                SessionMessage::SpeechInterrupted { id, speech_id },
                writer,
            )?
        }
        PlaybackEvent::Failed(speech_id, message) => {
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
            )?
        }
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
    } else {
        let id = current.prepare_id;
        let speech_id = current.speech_id;
        core.finish(speech_id);
        *active = None;
        write_message(writer, &SessionMessage::SpeechInterrupted { id, speech_id })?;
    }
    Ok(())
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

fn read_framed_requests(mut reader: impl Read, sender: SyncSender<Input>) {
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
        let terminal = matches!(input, Input::Invalid(_));
        if sender.send(input).is_err() || terminal {
            return;
        }
    }
    let _ = sender.send(Input::Eof);
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
        | SessionRequest::ResetInput { id }
        | SessionRequest::PrepareSpeak { id, .. }
        | SessionRequest::OutputReady { id, .. }
        | SessionRequest::QueryState { id, .. }
        | SessionRequest::Cancel { id } => Some(*id),
        SessionRequest::SetPaused { .. } | SessionRequest::Shutdown => None,
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
        _ => {}
    }
    Ok(request)
}

#[cfg(target_os = "macos")]
fn spawn_playback(
    speech_id: u64,
    text: String,
    output_device: Option<String>,
    backend: Arc<dyn TtsBackend>,
    active: Arc<AtomicBool>,
    sender: mpsc::Sender<PlaybackEvent>,
) {
    thread::spawn(move || {
        let terminal = match play_tts(
            speech_id,
            &text,
            output_device.as_deref(),
            backend.as_ref(),
            &active,
            &sender,
        ) {
            Ok(true) => PlaybackEvent::Completed(speech_id),
            Ok(false) => PlaybackEvent::Interrupted(speech_id),
            Err(message) => PlaybackEvent::Failed(speech_id, message),
        };
        let _ = sender.send(terminal);
    });
}

#[cfg(not(target_os = "macos"))]
fn spawn_playback(
    speech_id: u64,
    _text: String,
    _output_device: Option<String>,
    _backend: Arc<dyn TtsBackend>,
    _active: Arc<AtomicBool>,
    sender: mpsc::Sender<PlaybackEvent>,
) {
    let _ = sender.send(PlaybackEvent::Failed(
        speech_id,
        "native PCM output is only available on macOS".into(),
    ));
}

#[cfg(target_os = "macos")]
fn play_tts(
    speech_id: u64,
    text: &str,
    output_device: Option<&str>,
    backend: &dyn TtsBackend,
    active: &AtomicBool,
    sender: &mpsc::Sender<PlaybackEvent>,
) -> Result<bool, String> {
    use berd_voice::PocketAudioPlayer;

    let spec = backend.pcm_spec();
    let output = PocketAudioPlayer::new(spec.sample_rate, spec.playback_rate, output_device)?;
    synthesize_to_output(speech_id, text, backend, &output, active, sender)
}

fn synthesize_to_output(
    speech_id: u64,
    text: &str,
    backend: &dyn TtsBackend,
    output: &dyn berd_voice::PcmAudioOutput,
    active: &AtomicBool,
    sender: &mpsc::Sender<PlaybackEvent>,
) -> Result<bool, String> {
    use berd_voice::{DrainPolicy, OutboundOutcome, OutboundPlayback};

    let spec = backend.pcm_spec();
    let initial_frames = usize::try_from(spec.sample_rate / 5)
        .map_err(|_| "TTS sample rate is too large".to_string())?;
    let mut playback = OutboundPlayback::new(output, active, spec.sample_rate, initial_frames)?;
    if playback
        .synthesize_segment(
            backend,
            text,
            &mut |_| Ok(()),
            &mut || {
                let _ = sender.send(PlaybackEvent::Started(speech_id));
                Ok(())
            },
            &mut |_| Ok(()),
        )
        .map_err(|failure| failure.message)?
        == OutboundOutcome::Interrupted
    {
        return Ok(false);
    }
    playback
        .finish(DrainPolicy::default(), &mut |_| Ok(()))
        .map(|outcome| outcome == OutboundOutcome::Completed)
        .map_err(|failure| failure.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use berd_voice::{PcmAudioOutput, TtsOutcome, TtsPcmSpec};
    use serde_json::{json, Value};
    use std::io::Cursor;
    use std::sync::Mutex;

    struct FakeTts {
        frames: Vec<f32>,
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
            output_device: None,
            active: Some(Arc::new(AtomicBool::new(true))),
            ready_deadline: Instant::now() + Duration::from_secs(2),
            assistant_activity: None,
            tts: test_tts_lease(),
        }
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
                model: POCKET_TTS_MODEL_ID.into(),
                voice: "mary".into(),
                rate: 1.0,
            },
        };
        let ready = serde_json::to_string(&SessionMessage::Ready {
            id: 1,
            protocol: WIRE_MARKER,
            session: VoiceSessionSnapshot {
                tts: snapshot.clone(),
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
    fn openai_tts_target_reports_only_endpoint_source() {
        assert_eq!(
            tts_benchmark_target(&TtsBackendConfig::OpenAi { rate: 1.0 }, false)
                .endpoint_source
                .as_deref(),
            Some("built_in_default")
        );
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

    fn framed(kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::from([b'B', b'V', WIRE_MARKER as u8, kind]);
        frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        frame.extend_from_slice(payload);
        frame
    }

    #[test]
    fn framing_decodes_json_and_exact_pcm_without_line_ambiguity() {
        let json = br#"{"type":"hello","id":1,"output_device":null}"#;
        let pcm = [0_u8; PCM_FRAME_BYTES];
        let mut bytes = framed(JSON_FRAME_KIND, json);
        bytes.extend_from_slice(&framed(PCM_FRAME_KIND, &pcm));
        let (sender, receiver) = mpsc::sync_channel(3);

        read_framed_requests(Cursor::new(bytes), sender);

        assert!(matches!(
            receiver.recv().unwrap(),
            Input::Request(SessionRequest::Hello { id: 1, .. })
        ));
        assert!(matches!(receiver.recv().unwrap(), Input::Pcm(_)));
        assert!(matches!(receiver.recv().unwrap(), Input::Eof));
    }

    #[test]
    fn framing_rejects_oversized_json_and_wrong_pcm_before_payload_allocation() {
        for (kind, length, expected) in [
            (JSON_FRAME_KIND, MAX_LINE_BYTES + 1, "request exceeds 1 MiB"),
            (PCM_FRAME_KIND, PCM_FRAME_BYTES - 1, "PCM frame has"),
        ] {
            let mut header = Vec::from([b'B', b'V', WIRE_MARKER as u8, kind]);
            header.extend_from_slice(&(length as u32).to_le_bytes());
            let (sender, receiver) = mpsc::sync_channel(1);
            read_framed_requests(Cursor::new(header), sender);
            let Input::Invalid(message) = receiver.recv().unwrap() else {
                panic!("invalid frame must be terminal")
            };
            assert!(message.contains(expected));
            assert!(receiver.try_recv().is_err());
        }
    }

    #[test]
    fn ready_requires_the_runtime_ready_event() {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        sender.blocking_send(VoiceInputEvent::Ready).unwrap();
        assert_eq!(wait_for_input_ready(&mut receiver), Ok(()));

        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        sender
            .blocking_send(VoiceInputEvent::Failed("not ready".into()))
            .unwrap();
        assert_eq!(wait_for_input_ready(&mut receiver), Err("not ready".into()));
    }

    #[test]
    fn held_prepare_waits_for_pending_to_clear_without_a_timeout() {
        let mut core = SessionCore::default();
        core.set_recognition_pending(true);
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
            &None,
            &test_tts_slot(),
            &mut active,
            &mut held,
            &mut output,
        )
        .unwrap();
        assert!(held.is_some());
        assert!(output.is_empty());

        core.set_recognition_pending(false);
        reevaluate_held(
            &mut held,
            &mut core,
            &None,
            Some(&test_tts_slot()),
            &mut active,
            &mut output,
        )
        .unwrap();
        assert_eq!(messages(&output)[0]["type"], "admitted");
    }

    #[test]
    fn admission_leases_configuration_before_a_later_atomic_update() {
        let slot = test_tts_slot();
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
            &None,
            &slot,
            &mut active,
            &mut held,
            &mut output,
        )
        .unwrap();
        let old_revision = active.as_ref().unwrap().tts.snapshot().revision;
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

        assert_eq!(old_revision, 1);
        assert_eq!(active.as_ref().unwrap().tts.snapshot().revision, 1);
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
            output_device: None,
            active: None,
            ready_deadline: Instant::now() + Duration::from_secs(2),
            assistant_activity: None,
            tts: test_tts_lease(),
        });
        let mut held = None;
        let mut output = Vec::new();

        handle_cancel(7, &mut held, &mut core, &mut active, &mut output).unwrap();
        handle_cancel(7, &mut held, &mut core, &mut active, &mut output).unwrap();

        assert_eq!(
            messages(&output),
            [
                json!({"type":"cancel_result","id":7,"outcome":"cancelled","speech_id":1}),
                json!({"type":"speech_interrupted","id":7,"speech_id":1}),
                json!({"type":"cancel_result","id":7,"outcome":"stale","speech_id":null}),
            ]
        );
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
            output_device: None,
            active: None,
            ready_deadline: Instant::now() + Duration::from_secs(2),
            assistant_activity: None,
            tts: test_tts_lease(),
        });
        let mut next_token = 1;
        let mut output = Vec::new();
        let stored = AtomicBool::new(false);

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
    fn runtime_pending_is_published_before_it_interrupts_reserved_output() {
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
            output_device: None,
            active: None,
            ready_deadline: Instant::now() + Duration::from_secs(2),
            assistant_activity: None,
            tts: test_tts_lease(),
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
            ["recognition_pending", "speech_interrupted"]
        );
        assert!(core.recognition_pending());
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
        sender.send(PlaybackEvent::Interrupted(speech_id)).unwrap();

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
