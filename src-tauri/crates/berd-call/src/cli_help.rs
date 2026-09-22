const TOP_LEVEL_HELP: &str = r#"Berd Call

Voice-call runtime and speech tools for Berd and other hosts.

Usage:
  berd-call <command> [options]

Call runtime:
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

const SESSION_HELP: &str = r#"Run the host-facing framed voice-session protocol.

Usage:
  berd-call session --pcm-output-fd FD [--tts-backend siri|openai|pocket]
    [--model-dir PATH] [--voice ID] [--language BCP47] [--rate FLOAT]
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
            .map(|help| Some(MetaCommand::Help(help)))
            .ok_or_else(|| format!("unknown help topic: {}", topic.join(" "))),
        _ if values
            .last()
            .is_some_and(|value| matches!(*value, "-h" | "--help")) =>
        {
            let topic = values
                .iter()
                .take_while(|value| !value.starts_with('-'))
                .copied()
                .collect::<Vec<_>>();
            help_for(&topic)
                .map(|help| Some(MetaCommand::Help(help)))
                .ok_or_else(|| format!("unknown help topic: {}", topic.join(" ")))
        }
        _ => Ok(None),
    }
}

fn help_for(topic: &[&str]) -> Option<&'static str> {
    match topic {
        [] => Some(TOP_LEVEL_HELP),
        ["session"] => Some(SESSION_HELP),
        ["synthesize"] => Some(SYNTHESIZE_HELP),
        ["voices"] | ["voices", "list" | "download"] => Some(VOICES_HELP),
        ["models"]
        | ["models", "macos" | "openai" | "pocket" | "parakeet"]
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

#[cfg(test)]
mod tests {
    use super::{parse, MetaCommand, TOP_LEVEL_HELP};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn parses_global_help_and_version_without_claiming_an_operational_command() {
        assert!(matches!(
            parse(&args(&["berd-call", "--help"])).unwrap(),
            Some(MetaCommand::Help(TOP_LEVEL_HELP))
        ));
        assert!(matches!(
            parse(&args(&["berd-call", "version"])).unwrap(),
            Some(MetaCommand::Version)
        ));
        assert!(parse(&args(&["berd-call", "session"])).unwrap().is_none());
    }

    #[test]
    fn accepts_both_help_forms_for_nested_commands() {
        let prefixed = parse(&args(&["berd-call", "help", "benchmark", "tts"])).unwrap();
        let suffixed = parse(&args(&["berd-call", "benchmark", "tts", "--help"])).unwrap();
        assert!(matches!(prefixed, Some(MetaCommand::Help(_))));
        assert!(matches!(suffixed, Some(MetaCommand::Help(_))));
    }

    #[test]
    fn rejects_help_for_commands_the_binary_does_not_implement() {
        let error = parse(&args(&["berd-call", "help", "start"])).unwrap_err();
        assert_eq!(error, "unknown help topic: start");
    }
}
