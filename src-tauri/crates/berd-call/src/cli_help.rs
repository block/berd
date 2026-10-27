const TOP_LEVEL_HELP: &str = r#"Berd Call

Voice-call runtime and speech tools for Berd and other hosts.

Usage:
  berd-call <command> [options]

Call runtime:
  start                   Run a microphone-backed local voice call
  speak                   Speak through the active local call
  message-spokesperson    Have the Spokesperson tell the user
  status                  Inspect the active local call
  catch-up                Read finalized input after a cursor
  wait-for-input          Wait for finalized input after a cursor
  settings                Update the active local call settings
  stop                    Stop the active local call
  session                 Run the host-facing framed voice-session protocol

Agent harnesses:
  plugin                  Install or remove the Claude Code plugin
  hook                    Run one agent harness hook against the active call

Speech and models:
  synthesize              Render text to a WAV file
  voices                  List, download, or preview Siri voices
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
  berd-call start [--port PORT] [--stream [live] | --codex] [--non-blocking]
    [--no-menu-bar] [--enable-hooks-for-session-id ID]
    --voice NAME --language BCP47 [session options]

The foreground process owns the default microphone and audio output. Session
options are the same as `berd-call session`, except the PCM descriptor is owned
internally. `--stream` prints cursor, role, and text as TSV. In
Expert-Spokesperson mode it prints a batch after every Spokesperson reply and
at each handoff, as Berd's Expert hears the call; `--stream live` prints each
row as it happens. `--codex` delivers the same batches as `--stream` to the
calling Codex task (requires CODEX_THREAD_ID). A
menu-bar item controls speech rate, input muting, and ending the call; pass
`--no-menu-bar` to omit it.

Hooks from `berd-call plugin` act only for the agent session the call is bound
to: `--enable-hooks-for-session-id`, or else the CLAUDE_CODE_SESSION_ID of the
Claude Code session that runs `start`. A call with neither holds no agent.

Accepted voice, rate, and input policy settings are saved for the next call.
Microphone mute is temporary; each new call starts unmuted. Explicit startup
options override saved defaults. Preferences are stored in
$XDG_CONFIG_HOME/berd-call/settings.json or
$HOME/.config/berd-call/settings.json. BERD_CALL_SETTINGS_FILE selects an
alternate file. Agent identity and transcript routing are never saved."#;

const SPEAK_HELP: &str = r#"Speak through the active local voice call.

Usage:
  berd-call speak [--port PORT] [--re CURSOR]
    [--resolves HANDOFF_ID]... [--voice NAME [--language BCP47]] TEXT

Speech waits for admission. The session setting controls whether it also waits
for delivery. Non-blocking sessions require --stream or --codex and emit speech_result
rows only for interruptions, failures, or pending user input. Interrupted results include
estimatedSpokenText, a best-effort prefix based on delivered audio. --voice speaks
this text in another voice of the call's reply backend without changing its saved
voice, so several agents can share one call in distinct voices. An
Expert-Spokesperson call refuses speak unless started with
--allow-direct-agent-speech; otherwise use message-spokesperson. With it, a
reply acknowledging the latest input is spoken in the Expert's own voice, and
handoffs are never held open, so there is nothing for --resolves to name."#;

const MESSAGE_SPOKESPERSON_HELP: &str = r#"Message the Spokesperson of the active realtime call.

Usage:
  berd-call message-spokesperson [--port PORT] --re CURSOR
    [--resolves HANDOFF_ID]... TEXT

The Spokesperson tells the user in its own voice, even in a call with
--allow-direct-agent-speech, where `speak` uses the Expert's. Like a directive
from Berd's Expert, the message must acknowledge the latest input (the
Spokesperson's own speech doesn't count), each --resolves settles that handoff
once the Spokesperson has said it, and the result is the same as `speak`'s."#;

const SETTINGS_HELP: &str = r#"Update settings for the active local voice call.

Usage:
  berd-call settings [--port PORT] --non-blocking true|false
  berd-call settings [--port PORT] --rate FLOAT
  berd-call settings [--port PORT] --voice NAME [--language BCP47]
  berd-call settings [--port PORT] --spokesperson-voice NAME
  berd-call settings [--port PORT] --spokesperson-rate FLOAT
  berd-call settings [--port PORT] --tts JSON
  berd-call settings [--port PORT] --input-during-tts auto|allow|suppress
  berd-call settings [--port PORT] --muted true|false
  berd-call settings [--port PORT] --status-sounds off|working|working-and-waiting
  berd-call settings [--port PORT] --conversation-status working|waiting
  berd-call settings [--port PORT] --spokesperson true|false
  berd-call settings [--port PORT] --restart [session options]

The setting applies to subsequent speak calls. In a call started with
--allow-direct-agent-speech, --voice and --rate change the agents' voice, and
--spokesperson-voice changes the Spokesperson's (an OpenAI realtime voice).
--rate also sets the Spokesperson's speed, as close as it can go (0.25 to
1.5); --spokesperson-rate sets only the Spokesperson's. --spokesperson turns the Spokesperson on
or off, restarting the call's session in the other mode with the same voice;
options only the other mode takes are dropped, and in a call started with
--stream live, agents keep their own voice beside the Spokesperson's.
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
is no active speech; wait-for-input also waits for new user input or a handoff.
The default cursor is the session's acknowledged input. Reading does not
acknowledge input: reply using speak --re CURSOR. Results are JSON with
utterances, cursor, unresolvedHandoffIds, and timedOut. Timeout defaults to
30 seconds (range 1..3600). Cursors reset when the session restarts."#;

const STOP_HELP: &str = r#"Stop the active local voice call.

Usage:
  berd-call stop [--port PORT]"#;

const PLUGIN_HELP: &str = r#"Install or remove the Claude Code plugin.

Usage:
  berd-call plugin install claude-code
  berd-call plugin uninstall claude-code

The plugin is a skill for using a call plus hooks that hold the session that
starts one to answering it. It is written to $CLAUDE_CONFIG_DIR/skills/berd-call,
or ~/.claude/skills/berd-call, and loads in new Claude Code sessions. Each
`berd-call start` brings an installed plugin up to this version. Neither command
touches a directory of that name it didn't write."#;

const HOOK_HELP: &str = r#"Run one agent harness hook against the active call.

Usage:
  berd-call hook prompt-submit|pre-tool|post-tool|stop|permission-request
    [--port PORT]

The plugin runs this with the harness's hook payload on stdin and prints the
call's decision. While the bound session has input it hasn't answered, a tool
call is refused; ending the turn is also refused after tools with nothing said
since, or while nothing delivers the transcript. A command that runs only
berd-call is never refused. A permission request is announced on the call. The
hooks also report whether the agent is working, for status sounds. With no call
running, or for any other session or a subagent, the hook does nothing."#;

const SESSION_HELP: &str = r#"Run the host-facing framed voice-session protocol.

Usage:
  berd-call session --pcm-output-fd FD --voice NAME --language BCP47
  berd-call session --pcm-output-fd FD --tts-backend openai
  berd-call session --pcm-output-fd FD --tts-backend pocket
    --model-dir ABSOLUTE_PATH --voice ID

Each form also accepts:
    [--rate FLOAT]
    [--stt-backend macos|parakeet|openai] [--stt-model-dir PATH] [--stt-hint PHRASE]...
    [--mode conventional|expert-spokesperson] [--allow-direct-agent-speech]
    [--spokesperson-voice NAME] [--spokesperson-rate 0.25..1.5]
    [--spokesperson-options JSON]
    [--realtime-url WS_URL] [--stt-url WS_URL] [--tts-url HTTP_URL]

The host owns microphone capture, audio playback, transcript delivery, and
agent integration. See PROTOCOL.md for the framed stdin, stdout, and PCM
contracts. Endpoint URL flags override only the matching service for this call
and default to OpenAI when no environment override is set.

In expert-spokesperson mode, the Expert speaks through the Spokesperson.
--allow-direct-agent-speech also lets it speak to the user itself, through the
configured TTS backend, in its own voice beside the Spokesperson's. --spokesperson-voice then
chooses the Spokesperson's own voice. It speaks as close to --rate as it can, unless
--spokesperson-rate chooses its own speed. --spokesperson-options sets the rest of its
realtime session, as Berd's Advanced settings do, with a JSON object of model,
transcriptionModel, transcriptionLanguage, transcriptionPrompt, turnDetection
(server_vad|semantic_vad), eagerness, interruptResponse, createResponse,
vadThreshold, prefixPaddingMs, silenceDurationMs, idleTimeoutMs, noiseReduction
(off|near_field|far_field), reasoningEffort and maxOutputTokens. Saved settings
don't keep it, so pass it on each start."#;

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
        ["message-spokesperson"] => Some(MESSAGE_SPOKESPERSON_HELP),
        ["status"] => Some(STATUS_HELP),
        ["catch-up"] | ["wait-for-input"] => Some(POLL_INPUT_HELP),
        ["settings"] => Some(SETTINGS_HELP),
        ["stop"] => Some(STOP_HELP),
        ["session"] => Some(SESSION_HELP),
        ["plugin"] | ["plugin", "install" | "uninstall"] => Some(PLUGIN_HELP),
        ["hook"] => Some(HOOK_HELP),
        ["synthesize"] => Some(SYNTHESIZE_HELP),
        ["voices"] | ["voices", "list" | "download" | "preview"] => Some(VOICES_HELP),
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
