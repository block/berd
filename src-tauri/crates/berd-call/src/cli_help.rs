const TOP_LEVEL_HELP: &str = r#"Berd Call

Voice-call runtime and speech tools for Berd and other hosts.

Usage:
  berd-call <command> [options]

Call runtime:
  start                   Run a microphone-backed local voice call
  speak                   Speak through the active local call
  status                  Inspect the active local call
  catch-up                Read finalized input after a cursor
  wait-for-input          Wait for finalized input after a cursor
  settings                Update the active local call settings
  stop                    Stop the active local call
  session                 Run the host-facing framed voice-session protocol

Speech and models:
  synthesize              Render text to a WAV file
  voices                  List, download, or preview Siri voices
  models                  Inspect or install speech models

Diagnostics:
  vad-replay              Compare offline continuous-recognition VAD fixtures
  benchmark tts           Benchmark a TTS backend
  benchmark stt           Benchmark an STT backend

Other:
  help [command]          Show help for a command
  version                 Print the installed version

Run `berd-call help <command>` for command-specific usage."#;

const START_HELP: &str = r#"Run a local voice call backed by the shared session runtime.

Usage:
  berd-call start [--port PORT] [--stream | --codex] [--non-blocking]
    [--no-menu-bar]
    --voice NAME --language BCP47 [session options]

The foreground process owns the default microphone and audio output. Session
options are the same as `berd-call session`, except the PCM descriptor is owned
internally. `--stream` prints cursor, role, and text as TSV. `--codex` delivers
the same rows as `--stream` to the calling Codex task (requires CODEX_THREAD_ID). A
menu-bar item controls speech rate, input muting, and ending the call; pass
`--no-menu-bar` to omit it.

Accepted voice, rate, and input policy settings are saved for the next call.
Microphone mute is temporary; each new call starts unmuted. Explicit startup
options override saved defaults. Preferences are stored in
$XDG_CONFIG_HOME/berd-call/settings.json or
$HOME/.config/berd-call/settings.json. BERD_CALL_SETTINGS_FILE selects an
alternate file. Agent identity and transcript routing are never saved."#;

const SPEAK_HELP: &str = r#"Speak through the active local voice call.

Usage:
  berd-call speak [--port PORT] [--re CURSOR]
    [--voice NAME [--language BCP47]] TEXT

Speech waits for admission. The session setting controls whether it also waits
for delivery. Non-blocking sessions require --stream or --codex and emit speech_result
rows only for interruptions, failures, or pending user input. Interrupted results include
estimatedSpokenText, a best-effort prefix based on delivered audio. --voice speaks
this text in another voice of the call's reply backend without changing its saved
voice, so several agents can share one call in distinct voices."#;

const SETTINGS_HELP: &str = r#"Update settings for the active local voice call.

Usage:
  berd-call settings [--port PORT] --non-blocking true|false
  berd-call settings [--port PORT] --rate FLOAT
  berd-call settings [--port PORT] --voice NAME [--language BCP47]
  berd-call settings [--port PORT] --tts JSON
  berd-call settings [--port PORT] --input-during-tts auto|allow|suppress
  berd-call settings [--port PORT] --muted true|false
  berd-call settings [--port PORT] --vad-debug-sounds on|off
  berd-call settings [--port PORT] --status-sounds off|working|working-and-waiting
  berd-call settings [--port PORT] --conversation-status working|waiting
  berd-call settings [--port PORT] --restart [session options]

The setting applies to subsequent speak calls.
--conversation-status tells the call whether the agent is working on a reply
or waiting for you; status sounds play only once something reports it. They
play Pop while the agent works and, with working-and-waiting, Purr while it
waits. The mode is saved for later calls.
Non-blocking delivery requires a call started with --stream or --codex.
Successful delivery produces no notification."#;

const STATUS_HELP: &str = r#"Inspect the active local voice call.

Usage:
  berd-call status [--port PORT]"#;

const POLL_INPUT_HELP: &str = r#"Read input from the active local voice call.

Usage:
  berd-call catch-up [--port PORT] [--since CURSOR] [--timeout SECONDS]
  berd-call wait-for-input [--port PORT] [--since CURSOR] [--timeout SECONDS]

Both wait for active speech to finish. Catch-up returns immediately when there
is no active speech; wait-for-input also waits for new user input.
The default cursor is the session's acknowledged input. Reading does not
acknowledge input: reply using speak --re CURSOR. Results are JSON with
utterances, cursor, and timedOut. Timeout defaults to
30 seconds (range 1..3600). Cursors reset when the session restarts."#;

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
    [--rate FLOAT] [--listening-threshold 0..1] [--interruption-threshold 0..1]
    [--pending-utterance-timeout-ms 250..30000] [--interim-words-wait-ms 250..60000]
    [--dynamic-listening true|false] [--dynamic-interruption true|false]
    [--dynamic-pending-utterance-timeout true|false] [--dynamic-interim-words-wait true|false]
    [--dynamic-release true|false]
    [--stt-backend macos|parakeet|openai] [--stt-model-dir PATH] [--stt-hint PHRASE]...
    [--stt-url WS_URL] [--tts-url HTTP_URL]
    [--capture DIR]

--listening-threshold sets local speech detection before agent playback (default 0.5).
--interruption-threshold sets local speech detection during agent playback (default 0.65).
--pending-utterance-timeout-ms bounds the idle agent speech hold (default 5000 ms).
Expiry keeps macOS recognition running and accepts late transcripts.
--interim-words-wait-ms extends that hold while Apple still has interim words to finalize (default 10000 ms).
Higher values require stronger evidence of speech before pausing playback.
Dynamic adjustment is experimental, off by default, and requires macOS STT.
Each enabled threshold learns independently, moving by 0.01 within 0.10..0.95:
a transcript missed by detection lowers it, and every 99 detected transcripts raise it back.
--dynamic-pending-utterance-timeout and --dynamic-interim-words-wait lengthen their wait (by 250 and
500 ms, within 2000..8000 and 2000..20000 ms) when a transcript arrives after the hold expired,
and shorten it after 19 transcripts that arrived in time. --dynamic-release lengthens VAD release
(300 ms by default) by 32 ms, within 160..1500 ms, when an agent began speaking in the middle of a
transcript that spanned several pauses, and shortens it after 19 split transcripts it did not.
Learned values are saved to the default audio setup profile.
Use detection-profile [--settings JSON] to read or save the default audio setup profile.

The host owns microphone capture, audio playback, transcript delivery, and
agent integration. See PROTOCOL.md for the framed stdin, stdout, and PCM
contracts. Endpoint URL flags override only the matching service for this call
and default to OpenAI when no environment override is set.

--capture records a session into a new directory under DIR for
speech-detection replay: microphone audio, every protocol message, and the audio
sent for each reply. It keeps all captures in DIR under 10 GB, deleting the
oldest first. Saved settings don't keep it, so pass it on each start."#;

const SYNTHESIZE_HELP: &str = r#"Render text through a configured TTS backend into a new WAV file.

Usage:
  berd-call synthesize --tts-backend siri|openai|pocket --voice ID
    [--language BCP47] [--model MODEL] [--model-dir ABSOLUTE_PATH]
    [--rate FLOAT] [--allow-paid-openai] --text TEXT --output PATH

The command never overwrites an existing output file. OpenAI synthesis requires
explicit --allow-paid-openai consent."#;

const VOICES_HELP: &str = r#"Inspect, download, or preview Siri voices.

Usage:
  berd-call voices list [--language BCP47]
  berd-call voices download --voice NAME --language BCP47
    [--availability-wait-seconds 1..1800]
  berd-call voices preview --voice NAME --language BCP47 [--rate 0.5..2.0]

preview plays the voice through the default output and exits when playback
ends. It plays Apple's system sample, which works before the voice is
downloaded, or else speaks a short sentence with an installed voice. SIGINT or
SIGTERM stops playback and exits."#;

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
        ["catch-up"] | ["wait-for-input"] => Some(POLL_INPUT_HELP),
        ["settings"] => Some(SETTINGS_HELP),
        ["stop"] => Some(STOP_HELP),
        ["session"] => Some(SESSION_HELP),
        ["synthesize"] => Some(SYNTHESIZE_HELP),
        ["voices"] | ["voices", "list" | "download" | "preview"] => Some(VOICES_HELP),
        ["models"]
        | ["models", "macos", "status" | "install"]
        | ["models", "openai", "voices"]
        | ["models", "pocket", "status" | "install" | "voices"]
        | ["models", "parakeet", "status" | "install"] => Some(MODELS_HELP),
        ["vad-replay"] => Some("Usage: berd-call vad-replay INPUT.json [--candidates CANDIDATES.json]\n       berd-call vad-replay events CAPTURE_DIR\n       berd-call vad-replay convert CAPTURE_DIR\n       berd-call vad-replay extract CAPTURE_DIR OUT_DIR --partition train|held-out\n       berd-call vad-replay evaluate BASELINE.json FIXTURE_DIR...\n\nReplays continuous-recognition VAD fixtures without changing live profiles.\nWrites one JSON report per recorded/candidate profile. See VAD_REPLAY.md for the fixture schema and scoring limits."),
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

#[cfg(test)]
mod tests {
    use super::START_HELP;

    #[test]
    fn start_help_distinguishes_saved_preferences_from_transient_mute() {
        assert!(START_HELP.contains("Accepted voice, rate, and input policy settings are saved"));
        assert!(START_HELP.contains("Microphone mute is temporary"));
        assert!(!START_HELP.contains("microphone mute settings are saved"));
    }
}
