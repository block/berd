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
and bounded engine shutdown. Hosts retain capture devices, optional physical
mute effects, engine configuration resolution, transcript storage and delivery,
and UI projection. Logical host mute and assistant input suppression compose
inside the shared runtime. OpenAI emits 24 kHz mono Float32 PCM. On macOS, the shared
Siri bridge emits normalized 48 kHz mono Float32 PCM without opening an audio
device; the existing Berd Siri player and the CLI use the same decoder.

`berd-voice session` exposes the development voice-session protocol documented
in [PROTOCOL.md](PROTOCOL.md). Siri TTS and macOS speech recognition are the
defaults:

```text
berd-voice session --voice Aaron --language en-US --rate 1.0
berd-voice session --tts-backend openai --rate 1.0
berd-voice session --tts-backend pocket --model-dir /path/to/native-voice-v2 --voice george --rate 1.0
berd-voice session --stt-backend parakeet --stt-model-dir /path/to/parakeet
berd-voice session --stt-backend openai
```

The default Siri backend still requires an exact installed voice name and
language. Missing or unavailable Siri voice configuration and an unavailable
current-locale macOS speech model fail startup with setup guidance. The session
never silently falls back to OpenAI or another cloud engine.
Siri preflight validates the exact case-sensitive installed name, normalized
BCP-47 language, and a responsive sirittsd availability query; later synthesis
can still fail and is reported through the normal terminal speech lifecycle.

## Synthesize to WAV

`synthesize` renders through the same TTS backends without opening an audio device. It writes mono signed 16-bit little-endian PCM WAV to a new file:

```sh
berd-voice synthesize --tts-backend siri --voice Aaron --language en-US \
  --rate 1.0 --text "Hello" --output hello.wav
berd-voice synthesize --tts-backend pocket \
  --model-dir /absolute/path/to/native-voice-v2 --voice mary --rate 1.0 \
  --text "Hello" --output hello.wav
berd-voice synthesize --tts-backend openai --model gpt-4o-mini-tts \
  --voice marin --rate 1.0 --allow-paid-openai \
  --text "Hello" --output hello.wav
```

The command rejects an existing output before constructing the backend, writes to a same-directory temporary file, synchronizes the completed WAV, and publishes it without clobbering a target that appears concurrently. Failure leaves no partial target. Input text is nonempty and at most 16 KiB; output is bounded to ten minutes of finite source PCM in `[-1, 1]`. Backend cancellation, empty or invalid PCM, and a non-1x PCM playback specification fail rather than publishing a misleading file.

Pocket rendering supports only rate `1.0`: its other rates are a host playback time-stretch policy and are not encoded into synthesized PCM. Siri applies its rate during native synthesis. OpenAI requires an explicit model, voice, and `--allow-paid-openai`; one invocation makes at most one request and reads the credential only from `OPENAI_API_KEY` after output preflight.

Success emits one schema-version-one JSON line with the public backend identity, requested rate, and WAV encoding, sample rate, channels, bit depth, source frames, duration, and byte count. It never serializes the prompt, credential, endpoint, Pocket bundle path, or temporary path. Operation failure emits one sanitized error line and exits 1; usage failure emits no JSON and exits 2. Stdout is reserved for this machine-readable terminal record, not audio data.

The public `berd_voice::siri` management API is also the single native boundary
used by Berd for Siri catalog discovery, represented languages, exact installed
voice validation, and download. A voice identity is its case-sensitive catalog
name plus a normalized BCP-47 language tag; private Apple identifiers are never
persisted or exposed. Download is a blocking terminal success/error operation
with a validated availability-polling bound and no invented byte progress.
Native validation and subscription have separate bounded waits before that
polling deadline. Berd continues to own persisted selection, fallback policy,
settings/UI events, and management preview playback. There is intentionally no
host settings or fallback policy in the standalone management commands.

## Voice and model management

The standalone commands are thin projections of the same shared management
APIs used by Berd:

```sh
berd-voice voices list
berd-voice voices list --language en-US
berd-voice voices download --voice Aaron --language en-US
berd-voice voices download --voice Aaron --language en-US \
  --availability-wait-seconds 300
berd-voice models macos status
berd-voice models macos install
berd-voice models pocket status --store-root /absolute/portable-store
berd-voice models pocket install --store-root /absolute/portable-store
berd-voice models pocket voices
berd-voice models parakeet status --store-root /absolute/portable-store
berd-voice models parakeet install --store-root /absolute/portable-store
```

The Siri language filter is an exact normalized BCP-47 language, not a prefix.
Download identifies a voice by its exact case-sensitive catalog name plus that
language. Its optional `1..1800` second bound applies only to the final native
availability poll; validation and subscription retain their separate bounded
waits. Siri download reports no invented byte progress.

Management stdout is machine-first JSONL. Every line contains
`schemaVersion: 1`, an `operation`, and an `event`. Read-only commands and Siri
download emit exactly one terminal `result`; macOS model installation may emit
native `progress` fractions followed by exactly one terminal `result` or
`error`. Operation failures emit a sanitized structured `error` on stdout and
diagnostic detail on stderr. Usage errors emit no JSON and exit 2; operation or
unsupported-mutation failures exit 1; successful read-only status on an
unsupported platform still exits 0 with `supported: false`. These blocking
commands have no cancellation protocol, and interruption by a process signal
does not promise a terminal JSON line. None opens an audio device, starts a
voice session, applies host settings, chooses fallbacks, or emits Tauri events.

Pocket and Parakeet require an explicit absolute coordination root; there is no
default and no coupling to Berd's app cache. The CLI derives the closed portable
layout `<store-root>/native-voice-v2`, with Parakeet nested at `stt`. Status does
not create a missing store. Install is per engine, is idempotent when that
engine is already Ready, and preserves the other Ready engine through the
shared transaction. Progress reports only the shared phase, downloaded bytes,
and total download bytes. A successful result identifies `alreadyReady` or
`installed`, verified bytes, and whether cleanup remains; any retained recovery
path is diagnostic stderr data, never JSON.

The public `pocket_assets` and `parakeet_assets` modules define the immutable
asset catalogs used by Berd and inspect an explicit portable bundle root as
`Missing`, `Invalid`, or `Ready { verified_bytes }`. Verification opens each
file, checks that it is a regular file with the pinned size, and streams its
SHA-256 through a bounded buffer. Pocket exposes its model files and twelve
voice descriptors; Parakeet has its own model identity and pins the runtime
model, tokens, and exact attribution/license file. These modules do not choose
a default voice, cache root, removal policy, or UI representation. Their
concrete installers accept an explicit closed Pocket/Parakeet root layout,
download only pinned HTTPS assets with bounded streaming size and checksum
verification, extract only exact Parakeet manifest entries, and publish a fully
verified combined tree. A short cross-process transaction lock coordinates
publication with model-loading readers and host-owned removal; interrupted
publication is recovered from one unambiguous verified backup, while ambiguous
or failed rollback state is returned with recovery paths. Downloads and archive
preparation remain outside that lock. Progress describes concrete phases plus
monotonic downloaded bytes; it does not invent extraction progress. Berd keeps
root selection, Tauri queue/revisions/events, settings and fallback policy,
live-stop policy, and removal UI.

Once the new combined tree passes final verification it is authoritative. If
deleting the retired backup then fails, installation still returns success with
`cleanup_pending`; Berd logs the retained path and the next locked preflight
retries cleanup. This avoids reporting a failed install after the model has
already been applied.

`voices.list` returns `backend`, normalized `languageFilter`,
`availableLanguages`, and exact voice records. `voices.download` returns the
canonical voice, `installed: true`, and `availabilityWaitSeconds`; a missing
exact catalog identity fails with `voice_not_found` before any native download
request. macOS status and install results contain `supported`, `locale`,
`localeSupported`, `modelStatus`, and `ready`. Install progress records contain
the native finite fraction clamped to `0...1`; nonfinite callbacks are omitted.
`models.pocket.voices` is a separate immutable catalog because Pocket installs
one pinned all-voices bundle rather than managing OS voices one at a time. It
returns only public model/license IDs and `{id,name}` records—no paths, hashes,
or source URLs. Pocket and Parakeet status return `missing|invalid|ready`,
nullable verified bytes, and the pinned total download bytes. Their install
progress uses schema-version-one JSONL envelopes with lowercase phases and
monotonic byte counts.

The session host owns both physical devices. Stdin is one framed stream
containing JSON controls and exact 20 ms, 48 kHz mono Float32 microphone frames;
controls are priority-routed while PCM forwarding remains strictly bounded. A
required inherited `--pcm-output-fd` carries independently framed synthesized
PCM records so device backpressure cannot block stdout lifecycle events or
stdin cancellation. The child retains source-frame delivery, drain, partial
delivery, and terminal authority through correlated acceptance, played,
drained, failed, and cancelled acknowledgements. The shared runtime owns Berd's
adaptive VAD, recognition-pending state, final-token storage, admission, and
barge-in. Omitting `--stt-backend` selects macOS speech recognition.

The session's `ready` event projects a sanitized, revisioned TTS snapshot.
Same-backend voice, language/model, and normalized rate updates validate off the
session loop, commit atomically, and apply to the next admitted utterance.
Already-admitted speech retains its configuration lease. Failed or stale
updates keep the prior configuration, and private credentials, endpoints, and
bundle paths never enter the snapshot.

The session also projects a separately revisioned `input_during_tts` snapshot.
`allow_barge_in` keeps PCM flowing through assistant-sensitive VAD, while
`suppress_input` drops PCM at the shared runtime for the admitted utterance.
Live policy updates apply to the next admission; host mute remains an
independent reason, so neither state can accidentally clear the other.

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
