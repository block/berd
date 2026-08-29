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
  --text "The quick brown fox jumps over the lazy dog." --runs 3 --mode cold
berd-voice benchmark tts --tts-backend pocket \
  --model-dir /path/to/native-voice-v2 --voice mary \
  --text "The quick brown fox jumps over the lazy dog." --runs 3 --mode warm
```

Cold mode constructs a backend for every measured run. Warm mode constructs
one backend, records one unmeasured warm-up synthesis, then reuses it for the
requested measured runs. “Cold” is scoped to the backend instance in the
current process; provider, native-framework, model-file, and operating-system
caches may remain warm. In particular, warm OpenAI mode performs one additional
billable warm-up request.

Each run reports initialization time when applicable, time to first nonempty
PCM, total synthesis time, mono PCM frame count and sample rate, PCM audio
duration, real-time factor (`synthesis duration / PCM audio duration`), and a
structured outcome or error stage. `playback_rate` is metadata only: benchmarks
measure generated PCM duration and never playback or output-device drain.
Reports identify the exact input with its UTF-8 byte count and SHA-256 without
printing the prompt itself. `planned_workload` includes the warm-up when present;
individual results show what actually ran.

OpenAI benchmarking is disabled unless the command includes
`--allow-paid-openai`. The CLI preflights the full workload, including the warm
mode's extra request, and rejects more than 20 requests or 65,536 total prompt
bytes before constructing the backend. A missing `OPENAI_API_KEY` still fails as
a structured initialization error without making a request.
