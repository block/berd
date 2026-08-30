# berd-voice

Berd-owned voice primitives, TTS, and speech recognition.

This crate owns the neutral PCM output contract and backend-neutral TTS stream
used by Berd, plus the April ONNX runtime and text chunking used by Berd's native
voice commands. It also owns the concrete Parakeet model loader and complete
16 kHz utterance recognizer, plus the OpenAI Realtime transcription websocket
client and macOS SpeechTranscriber engine used by Berd's existing native STT
workers. The concrete voice-input runtime accepts bounded 20 ms, 48 kHz mono
Float32 frames and owns Berd's adaptive VAD, resampling, utterance boundaries,
logical mute/reset epochs, recognition-pending state, stale-result rejection,
and bounded engine shutdown. Hosts retain capture devices, physical capture
suppression, engine configuration resolution, transcript storage and delivery,
and UI projection. OpenAI emits 24 kHz mono Float32 PCM. On macOS, the shared
Siri bridge emits normalized 48 kHz mono Float32 PCM without opening an audio
device; the existing Berd Siri player and the CLI use the same decoder.

`berd-voice session` exposes the development voice-session protocol documented
in [PROTOCOL.md](PROTOCOL.md). OpenAI remains the default backend:

```text
berd-voice session
berd-voice session --tts-backend siri --voice Aaron --language en-US --rate 1.0
berd-voice session --tts-backend pocket --model-dir /path/to/native-voice-v2 --voice george --rate 1.0
berd-voice session # macOS speech recognition is the default
berd-voice session --stt-backend parakeet --stt-model-dir /path/to/parakeet
berd-voice session --stt-backend openai
```

The host selects an optional output device in the protocol `hello`; the TTS
backend only produces PCM and does not own device persistence. Stdin is one
bounded framed stream containing JSON controls and exact 20 ms, 48 kHz mono
Float32 PCM frames. The shared runtime owns Berd's adaptive VAD,
recognition-pending state, final-token storage, admission, and barge-in; the
host still owns the capture device and sends normalized PCM. Omitting
`--stt-backend` selects macOS speech recognition.

Pocket's model path is the exact portable bundle directory, not a Berd cache
root. The CLI resolves an exact voice ID through the shared
`voices/<id>.wav` bundle layout and validates both model and voice before
`ready`; callers may point it at a Berd-downloaded bundle explicitly, but no
application-specific cache path is assumed.

## TTS benchmarks

`benchmark tts` exercises the same backend PCM source without opening an audio
device. It emits one JSON report on stdout and diagnostics on stderr:

```text
berd-voice benchmark tts --tts-backend siri --voice Aaron --language en-US \
  --prompt-manifest english-short-v1 --mode fresh-backend
berd-voice benchmark tts --tts-backend pocket \
  --model-dir /path/to/native-voice-v2 --voice mary \
  --prompt-manifest english-short-v1 --mode warm
```

The built-in `english-short-v1` manifest has one separate warm-up prompt and
five distinct, similarly sized measured prompts. `fresh-backend` constructs a
backend for each measured prompt. `warm` constructs one backend, synthesizes the
separate unmeasured prompt, then reuses that backend for the five measured
prompts. Neither mode promises a fresh process, provider daemon, native
framework, model-file cache, or operating-system cache. Warm OpenAI mode makes
one additional billable warm-up request.

An explicit `--text TEXT --runs COUNT` remains available for intentional
exact-prompt cache experiments. Reports label that scenario
`exact_prompt_repeat`; the manifest path is labeled
`distinct_prompt_manifest`. This distinction matters for Siri: exact repeats
have been observed to return decoded PCM within a few milliseconds, likely
benefiting from hot system or daemon state. That does not measure novel
synthesis or audible onset; the private sirittsd implementation does not let us
attribute the effect to a particular internal cache.

Each run reports initialization time when applicable, time to first nonempty
PCM, total synthesis time, mono PCM frame count and sample rate, finite and
nonfinite frame counts, peak amplitude, global RMS, PCM audio duration,
real-time factor (`synthesis duration / PCM audio duration`), and a structured
outcome or error stage. Completed output containing nonfinite PCM or no
sustained signal is an error. `playback_rate` is metadata only: benchmarks
measure generated PCM duration and never playback or output-device drain.

Signal onset uses 20 ms RMS windows with a 10 ms hop and requires three
consecutive windows at or above `max(1e-6, peak_window_rms * 0.01)`. Reports
include the threshold, the source-timeline offset of the first qualifying
window, and the callback time that supplied that source frame. They also
simulate immediate zero-device-latency PCM playout, stalling the source timeline
when a callback arrives too late, as
`estimated_earliest_realtime_signal_ms`. This is a device-free PCM scheduling
estimate, not actual or audible onset: it excludes player buffering, operating
system scheduling, output devices, transducers, volume, and hearing.
Every run identifies its prompt ID, UTF-8 byte count, and SHA-256 without
printing the prompt itself. Manifest reports include its stable ID, language,
and pinned content hash. Prompts are distinct within a manifest invocation, but
`prior_cache_state` remains explicitly uncontrolled because provider and system
caches can survive earlier processes. `planned_workload` includes the warm-up
when present; individual results show what actually ran. OpenAI reports whether
its endpoint came from the built-in default or the `OPENAI_BASE_URL`
environment, but never includes the URL.

OpenAI benchmarking is disabled unless the command includes
`--allow-paid-openai`. The CLI preflights the full workload, including the warm
mode's extra request, and rejects more than 20 requests or 65,536 total prompt
bytes before constructing the backend. A missing `OPENAI_API_KEY` still fails as
a structured initialization error without making a request.

## STT benchmarks

`benchmark stt` feeds a small, immutable LibriSpeech `test-clean` fixture pack
through the same `VoiceInputRuntime` used by Berd and the voice session. It does
not open an input device:

```text
berd-voice benchmark stt --stt-backend macos --runs 1 --mode cold
berd-voice benchmark stt --stt-backend parakeet \
  --stt-model-dir /path/to/parakeet --runs 3 --mode warm
```

The checked-in pack contains three unmodified 16 kHz mono FLAC utterances from
OpenSLR SLR12. Its manifest records the official archive URL and MD5, CC BY 4.0
license, exact transcripts, decoded stream metadata, and per-file SHA-256.
Benchmark startup verifies those hashes and metadata, decodes the audio, and
uses deterministic linear interpolation to convert it to the runtime's 48 kHz
mono Float32 contract. The report records that conversion and embeds the full
fixture attribution notice, so standalone binaries and packaged applications
retain the notice. Rust sources remain Apache 2.0; the embedded corpus files are
CC BY 4.0, as reflected by the crate's aggregate package-license metadata.

Input is paced in real time as exact 960-sample frames every 20 ms. Each clip
has one second of leading silence and 6.5 seconds of trailing silence. The long
tail deliberately keeps continuous recognizers supplied with capture-like PCM
through VAD settlement and the runtime's five-second live no-result bound; it
is included in the reported workload. A final transcript is validated and
stored in its per-utterance result before its storage receipt is acknowledged,
and the next clip does not begin until authoritative speaking and
recognition-pending state are both idle.

Cold mode creates a fresh `VoiceInputRuntime` for each measured run. It does not
start a fresh process, so operating-system, provider, and model-file caches may
remain warm. Warm mode creates one runtime, records one unmeasured fixture-pack
warm-up, then reuses that resident runtime for the measured runs.

Reports contain fixture provenance, sanitized engine/environment metadata,
planned recognition commits and streamed duration, initialization and turn
timings, hypotheses, and aggregate word error rate. WER normalization retains
ASCII letters, digits, and apostrophes, converts them to uppercase, maps other
punctuation to whitespace, and reports substitutions, deletions, and insertions
alongside the aggregate rate.

OpenAI STT benchmarking requires `--allow-paid-openai` and reads its key only
from `OPENAI_API_KEY`. Before resolving credentials or connecting, the CLI
rejects a warmup-inclusive workload above 20 recognition commits or 120 seconds
of streamed PCM. Endpoint and model overrides use the same environment variables
as the session; reports record only which source supplied them and never include
the key or endpoint value.
