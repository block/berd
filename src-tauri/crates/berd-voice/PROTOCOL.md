# berd-voice session protocol

`berd-voice session` is a development, full-authority voice session. The child
owns speech recognition, finalized-input order, confirmation, speak admission,
synthesis, playback lifecycle, and barge-in. The parent owns capture devices and
writes normalized microphone PCM; the child writes flushed JSONL events to
stdout. Diagnostics go only to stderr.

## Startup

The child selects closed TTS and STT backends at startup:

```text
berd-voice session [--tts-backend siri] --voice NAME --language BCP47 [--rate 0.5..2.0]
berd-voice session --tts-backend openai [--rate 0.75..2.0]
berd-voice session --tts-backend pocket --model-dir ABS --voice ID [--rate 0.75..2.0]

berd-voice session [--stt-backend macos]
berd-voice session --stt-backend parakeet --stt-model-dir ABS
berd-voice session --stt-backend openai
```

Siri TTS and macOS STT are the defaults. Siri selection is exact and requires
an installed sirittsd voice; omitting its voice or language fails startup with
setup guidance. There is no fallback to OpenAI or another cloud engine. Pocket
requires an explicit self-contained bundle
containing its ONNX/tokenizer assets and `voices/<id>.wav`; it never searches a
Berd cache. macOS STT uses the current locale and requires its model to be
installed before startup; an unavailable model fails startup with installation
guidance. Parakeet requires an explicit self-contained bundle.
OpenAI credentials and optional endpoint/model configuration come only from the
child environment, never arguments or wire messages. TTS and STT validation and
initialization finish before `ready`.

Siri startup preflight validates the exact case-sensitive installed name,
normalized BCP-47 language, and a responsive sirittsd availability query. It
does not guarantee that a later synthesis request cannot fail; those failures
remain terminal speech events.

The first request must be `hello`. Its optional `output_device` is an exact
CoreAudio output name selected by the parent:

```json
{"type":"hello","id":1,"output_device":null}
```

The response retains `protocol:2` as a fixed wire-integrity marker, not a
negotiated mode:

```json
{"type":"ready","id":1,"protocol":2,"session":{"tts":{"revision":1,"backend":"siri","voice":"Aaron","language":"en-US","rate":1.0}}}
```

The `session.tts` object is the authoritative, sanitized TTS configuration.
OpenAI snapshots contain `model`, `voice`, and `rate`; Siri contains `voice`,
`language`, and `rate`; Pocket contains its public `model` identifier, `voice`,
and `rate`. Credentials, endpoints, and bundle paths never appear on stdout.
Detailed backend errors are diagnostics on stderr only; protocol rejection and
fatal messages are sanitized at the stdout boundary.

## Stdin framing

Every stdin message is an eight-byte header followed by exactly `length` bytes:

```text
0x42 0x56 0x02 kind length:u32-little-endian
```

`0x02` is a fixed framing marker. Kind `1` is one UTF-8 JSON request, bounded to
1 MiB. Kind `2` is exactly 3840 bytes: one 20 ms frame of 960 little-endian,
finite Float32 mono samples at 48 kHz. Wrong magic, marker, kind, length, JSON,
PCM shape, or non-finite PCM is fatal. Frames are processed in order and bounded
before payload allocation. Stdout remains unframed, flushed JSONL.

## Parent requests

```text
{"type":"hello","id":u64,"output_device":string|null}
{"type":"set_paused","active":bool}
{"type":"set_input_muted","id":u64,"active":bool}
{"type":"set_tts_settings","id":u64,"expected_revision":u64,"settings":TtsSettings}
{"type":"reset_input","id":u64}
{"type":"prepare_speak","id":u64,"acknowledgement":u64|null,"text":string}
{"type":"output_ready","id":u64,"speech_id":u64}
{"type":"query_state","id":u64,"after":u64}
{"type":"cancel","id":u64}
{"type":"shutdown"}
```

Unknown fields are rejected. IDs are positive. Speak text is at most 16 KiB.
The parent cannot author speaking state or finalized input; those are derived
only from PCM by the child runtime.

`set_tts_settings` accepts the same tagged public object projected by `ready`,
without `revision`. It changes settings only for the already-active backend:

```text
{"backend":"openai","model":string,"voice":string,"rate":0.75..2.0}
{"backend":"siri","voice":string,"language":string,"rate":0.5..2.0}
{"backend":"pocket","model":string,"voice":string,"rate":0.75..2.0}
```

The child constructs and validates a replacement without blocking input or
playback processing, then atomically commits it only if `expected_revision`
still matches. It responds with:

```text
{"type":"tts_settings_result","id":u64,"outcome":"applied","snapshot":TtsConfigurationSnapshot}
{"type":"tts_settings_result","id":u64,"outcome":"rejected","snapshot":TtsConfigurationSnapshot,"message":string}
```

The snapshot is authoritative in both outcomes. Invalid, stale, cross-backend,
concurrent, timed-out, or shutdown-interrupted updates are nonfatal and leave
the prior configuration active. The applied response is the client-visible
linearization point. A speech reservation holds a configuration lease: speech
admitted before the response retains its old backend/settings, while later
admission receives the new revision. Pocket's public model identifier cannot be
changed without selecting and validating another bundle at process startup.

`set_input_muted` and `reset_input` apply the runtime's logical input epochs and
return exact correlated acknowledgements:

```text
{"type":"input_mute_applied","id":u64,"active":bool}
{"type":"input_reset_applied","id":u64}
```

## Authoritative input

The child emits:

```text
{"type":"input_speaking","active":bool}
{"type":"recognition_pending","active":bool}
{"type":"user_final","token":u64,"text":string}
```

For every final, the child allocates a strictly increasing token, stores it in
`SessionCore`, acknowledges the runtime storage receipt, emits `user_final`, and
only then interrupts reserved or playing assistant output. Final text is at
most 64 KiB.

## Confirmation and admission

`acknowledgement` is a request-local causal cutoff. `null` uses the stored
confirmed cursor. `0` is the exact zero cutoff. Any existing token is the exact
cutoff, even when older than the stored cursor. Naming an existing token advances
the stored cursor monotonically but never moves it backward. A missing or future
token falls back to the stored cursor. Finals after the request-local cutoff
produce `pending`.

Prepare evaluation order is fixed: reject empty text; while input is speaking or
recognition is pending, hold one prepare indefinitely without applying its
acknowledgement; then apply the cutoff and return pending finals; then reject
paused; then reject an in-progress speech; otherwise reserve. A second prepare
while one is held returns `in_progress` without mutation.

Reservation emits:

```text
{"type":"admitted","id":u64,"speech_id":u64,"confirmed_token":u64}
```

It does not begin synthesis. The parent first suppresses capture and replies
with the originating prepare ID and speech ID:

```text
{"type":"output_ready","id":u64,"speech_id":u64}
{"type":"output_ready_result","id":u64,"speech_id":u64,"outcome":"accepted"|"stale"}
```

`accepted` transfers output authority. Readiness is bounded to two seconds;
expiry emits `speech_failed` with zero output. Speaking, recognition pending, a
final, pause, or targeted cancellation interrupts waiting or playing speech.
Accepted output owns a balanced assistant-activity guard until its terminal
event.

## State, cancellation, and output events

```text
{"type":"pending","id":u64,"utterances":[{"token":u64,"text":string}]}
{"type":"not_admitted","id":u64,"reason":"paused"|"in_progress"|"cancelled"|"empty_text"}
{"type":"state","id":u64,"confirmed_token":u64,"utterances_after":[{"token":u64,"text":string}]}
{"type":"cancel_result","id":u64,"outcome":"cancelled"|"stale","speech_id":u64|null}
{"type":"speech_started","id":u64,"speech_id":u64}
{"type":"speech_completed","id":u64,"speech_id":u64}
{"type":"speech_interrupted","id":u64,"speech_id":u64}
{"type":"speech_failed","id":u64,"speech_id":u64,"message":string}
{"type":"fatal","message":string}
```

`query_state.after` is an exclusive token cutoff; `0` requests all. `cancel.id`
targets the originating `prepare_speak.id`. `cancel_result` is emitted first. A
live held target then emits `not_admitted(cancelled)`; a live admitted target
then emits `speech_interrupted`. Repeated or unknown cancellation is stale.
Every speech event carries the originating prepare ID. `speech_started` appears
only after PCM is accepted by the output, and exactly one terminal message
follows every admission.

On `shutdown`, all complete earlier frames are processed in order. The child
cancels and drains output, finishes the input runtime while continuing to drain
events and storage receipts, flushes, then exits. EOF, malformed framing, fatal
input failure, or process death cancels both authorities without transparent
restart. A fatal error is flushed exactly once and followed by no protocol
output.
