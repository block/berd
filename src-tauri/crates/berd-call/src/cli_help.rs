const TOP_LEVEL_HELP: &str = r#"Berd Call

Voice-call runtime and speech tools for Berd and other hosts.

Usage:
  berd-call <command> [options]

Call runtime:
  start                   Run a microphone-backed local voice call
  speak                   Speak through the active local call
  status                  Inspect the active local call
  stop                    Stop the active local call
  session                 Run the host-facing framed voice-session protocol

Speech and models:
  synthesize              Render text to a WAV file
  voices                  List or download Siri voices
  models                  Inspect or install speech models

Diagnostics:
  benchmark tts           Benchmark a TTS backend
  benchmark stt           Benchmark an STT backend

Other:
  help [command]          Show help for a command
  version                 Print the installed version

Run `berd-call help <command>` for command-specific usage."#;

const START_HELP: &str = r#"Run a local voice call backed by the shared session runtime.

Usage:
  berd-call start [--port PORT] [--stream]
    --voice NAME --language BCP47 [session options]

The foreground process owns the default microphone and audio output. Session
options are the same as `berd-call session`, except the PCM descriptor is owned
internally. `--stream` prints cursor, role, and text as TSV."#;

const SPEAK_HELP: &str = r#"Speak through the active local voice call.

Usage:
  berd-call speak [--port PORT] [--re CURSOR]
    [--resolves HANDOFF_ID]... TEXT"#;

const STATUS_HELP: &str = r#"Inspect the active local voice call.

Usage:
  berd-call status [--port PORT]"#;

const STOP_HELP: &str = r#"Stop the active local voice call.

Usage:
  berd-call stop [--port PORT]"#;

const SESSION_HELP: &str = r#"Run the host-facing framed voice-session protocol.

Usage:
  berd-call session --pcm-output-fd FD --voice NAME --language BCP47
  berd-call session --pcm-output-fd FD --tts-backend openai
  berd-call session --pcm-output-fd FD --tts-backend pocket
    --model-dir ABSOLUTE_PATH --voice ID

Each form also accepts:
    [--rate FLOAT]
    [--stt-backend macos|parakeet|openai] [--stt-model-dir PATH]
    [--mode conventional|expert-spokesperson]

The host owns microphone capture, audio playback, transcript delivery, and
agent integration. See PROTOCOL.md for the framed stdin, stdout, and PCM
contracts."#;

const SYNTHESIZE_HELP: &str = r#"Render text through a configured TTS backend into a new WAV file.

Usage:
  berd-call synthesize --tts-backend siri|openai|pocket --voice ID
    [--language BCP47] [--model MODEL] [--model-dir ABSOLUTE_PATH]
    [--rate FLOAT] [--allow-paid-openai] --text TEXT --output PATH

The command never overwrites an existing output file. OpenAI synthesis requires
explicit --allow-paid-openai consent."#;

const VOICES_HELP: &str = r#"Inspect or download Siri voices.

Usage:
  berd-call voices list [--language BCP47]
  berd-call voices download --voice NAME --language BCP47
    [--availability-wait-seconds 1..1800]"#;

const MODELS_HELP: &str = r#"Inspect or install speech models.

Usage:
  berd-call models macos status
  berd-call models macos install
  berd-call models openai voices
  berd-call models pocket status|install --store-root ABSOLUTE_PATH
  berd-call models pocket voices
  berd-call models parakeet status|install --store-root ABSOLUTE_PATH"#;

const BENCHMARK_HELP: &str = r#"Benchmark speech backends without opening an audio device.

Usage:
  berd-call benchmark tts --tts-backend openai|siri|pocket
    [--model-dir PATH] [--voice ID] [--language BCP47] [--rate FLOAT]
    (--text TEXT --runs COUNT | --prompt-manifest english-short-v1)
    --mode fresh-backend|warm [--allow-paid-openai]
  berd-call benchmark stt --stt-backend macos|parakeet|openai
    [--stt-model-dir PATH] --runs COUNT --mode cold|warm
    [--allow-paid-openai]"#;

const BENCHMARK_TTS_HELP: &str = r#"Benchmark a TTS backend without opening an audio device.

Usage:
  berd-call benchmark tts --tts-backend openai|siri|pocket
    [--model-dir PATH] [--voice ID] [--language BCP47] [--rate FLOAT]
    (--text TEXT --runs COUNT | --prompt-manifest english-short-v1)
    --mode fresh-backend|warm [--allow-paid-openai]"#;

const BENCHMARK_STT_HELP: &str = r#"Benchmark an STT backend with the bundled LibriSpeech fixture.

Usage:
  berd-call benchmark stt --stt-backend macos|parakeet|openai
    [--stt-model-dir PATH] --runs COUNT --mode cold|warm
    [--allow-paid-openai]"#;

#[derive(Debug)]
pub(crate) enum MetaCommand {
    Help(&'static str),
    Version,
}

pub(crate) fn parse(args: &[String]) -> Result<Option<MetaCommand>, String> {
    let values = args.iter().skip(1).map(String::as_str).collect::<Vec<_>>();
    match values.as_slice() {
        ["-h" | "--help" | "help"] => Ok(Some(MetaCommand::Help(TOP_LEVEL_HELP))),
        ["-V" | "--version" | "version"] => Ok(Some(MetaCommand::Version)),
        ["help", topic @ ..] => help_for(topic)
            .map(MetaCommand::Help)
            .map(Some)
            .ok_or_else(|| format!("unknown help topic: {}", topic.join(" "))),
        _ => Ok(None),
    }
}

fn help_for(topic: &[&str]) -> Option<&'static str> {
    match topic {
        [] => Some(TOP_LEVEL_HELP),
        ["start"] => Some(START_HELP),
        ["speak"] => Some(SPEAK_HELP),
        ["status"] => Some(STATUS_HELP),
        ["stop"] => Some(STOP_HELP),
        ["session"] => Some(SESSION_HELP),
        ["synthesize"] => Some(SYNTHESIZE_HELP),
        ["voices"] | ["voices", "list" | "download"] => Some(VOICES_HELP),
        ["models"]
        | ["models", "macos", "status" | "install"]
        | ["models", "openai", "voices"]
        | ["models", "pocket", "status" | "install" | "voices"]
        | ["models", "parakeet", "status" | "install"] => Some(MODELS_HELP),
        ["benchmark"] => Some(BENCHMARK_HELP),
        ["benchmark", "tts"] => Some(BENCHMARK_TTS_HELP),
        ["benchmark", "stt"] => Some(BENCHMARK_STT_HELP),
        _ => None,
    }
}

fn command_path<'a>(values: &'a [&str]) -> Vec<&'a str> {
    values
        .iter()
        .take_while(|value| !value.starts_with('-'))
        .copied()
        .collect()
}

pub(crate) fn usage_for(args: &[String]) -> &'static str {
    let values = args.iter().skip(1).map(String::as_str).collect::<Vec<_>>();
    let mut topic = command_path(&values);
    loop {
        if let Some(help) = help_for(&topic) {
            return help;
        }
        if topic.pop().is_none() {
            return TOP_LEVEL_HELP;
        }
    }
}
