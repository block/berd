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
