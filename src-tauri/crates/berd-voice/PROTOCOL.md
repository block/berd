# berd-voice session protocol

`berd-voice session` is a development, full-authority voice session. The child
owns speech recognition, finalized-input order, confirmation, speak admission,
synthesis, source-frame delivery, playback lifecycle, and barge-in. The parent
owns capture and playback devices: it writes normalized microphone PCM on stdin
and consumes synthesized PCM from a dedicated inherited pipe. The child writes
flushed JSONL events to stdout. Diagnostics go only to stderr.

## Startup

The child selects closed TTS and STT backends at startup:

```text
berd-voice session --pcm-output-fd FD [--tts-backend siri] --voice NAME --language BCP47 [--rate 0.5..2.0]
berd-voice session --pcm-output-fd FD --tts-backend openai [--rate 0.75..2.0]
berd-voice session --pcm-output-fd FD --tts-backend pocket --model-dir ABS --voice ID [--rate 0.75..2.0]

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
initialization finish before `ready`. STT must report readiness within 60
seconds; otherwise the child emits a sanitized fatal event and performs bounded
runtime cleanup before exiting.

Siri startup preflight validates the exact case-sensitive installed name,
normalized BCP-47 language, and a responsive sirittsd availability query. It
does not guarantee that a later synthesis request cannot fail; those failures
remain terminal speech events.

`FD` must be an inherited writable descriptor at least 3. It is required and
has no device-owning or stdout-multiplexed fallback.

The first request must be `hello`. `input_during_tts` is the host's resolved
initial policy; a host-specific `auto` mode must be resolved before the request:

```json
{"type":"hello","id":1,"input_during_tts":"allow_barge_in"}
```

The response retains `protocol:2` as a fixed wire-integrity marker, not a
negotiated mode:

```json
{"type":"ready","id":1,"protocol":2,"session":{"tts":{"revision":1,"backend":"siri","voice":"Aaron","language":"en-US","rate":1.0},"input_during_tts":{"revision":1,"policy":"allow_barge_in"}}}
```

The `session.tts` object is the authoritative, sanitized TTS configuration.
OpenAI snapshots contain `model`, `voice`, and `rate`; Siri contains `voice`,
`language`, and `rate`; Pocket contains its public `model` identifier, `voice`,
and `rate`. Credentials, endpoints, and bundle paths never appear on stdout.
Detailed backend errors are diagnostics on stderr only; protocol rejection and
fatal messages are sanitized at the stdout boundary.
`session.input_during_tts` is the authoritative effective assistant-input
policy and has its own revision.

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

JSON controls and acknowledgements use an unbounded control path inside the
child. Microphone PCM uses a bounded nonblocking path; its first overflow is
fatal. A control remains ordered after every earlier accepted microphone frame,
but later PCM cannot block an urgent audio acknowledgement or cancellation.

## Dedicated PCM output pipe

The child is the sole writer of self-framed records on `--pcm-output-fd`. Each
record has an eight-byte header followed by exactly `length` bytes:

```text
0x42 0x41 0x02 kind length:u32-little-endian
```

Kinds and little-endian payloads are:

```text
1 Begin:  speech_id:u64 sample_rate:u32 playback_rate:f32
2 Chunk:  speech_id:u64 sequence:u64 samples:[f32]
3 End:    speech_id:u64 last_sequence:u64 total_frames:u64
4 Cancel: speech_id:u64
```

PCM is finite, unit-scale, mono Float32 at the Begin sample rate. The current
closed sample rates are 24 kHz and 48 kHz; playback rate is finite `0.5..2.0`.
Chunk sequence starts at 1 and is contiguous. A Chunk is nonempty and contains
at most 4096 source frames. Pipe writes, Begin acceptance, each Chunk acceptance,
credit release, and cancellation acknowledgement are each bounded to two
seconds. A partial record that cannot finish within the pipe deadline poisons
the transport; Cancel never overtakes bytes from an unfinished record.

The parent acknowledges on framed stdin:

```text
{"type":"audio_begin_accepted","speech_id":u64}
{"type":"audio_begin_failed","speech_id":u64,"played_frames":u64,"message":string}
{"type":"audio_chunk_accepted","speech_id":u64,"sequence":u64}
{"type":"audio_played","speech_id":u64,"played_frames":u64}
{"type":"audio_suspended","speech_id":u64,"played_frames":u64}
{"type":"audio_resumed","speech_id":u64,"played_frames":u64}
{"type":"audio_drained","speech_id":u64,"sequence":u64,"played_frames":u64}
{"type":"audio_failed","speech_id":u64,"played_frames":u64,"message":string}
{"type":"audio_cancelled","speech_id":u64,"played_frames":u64}
```

For provisional barge-in, the child writes one of these flushed JSONL commands on stdout:

```text
{"type":"audio_suspend","speech_id":u64}
{"type":"audio_resume","speech_id":u64}
```

Suspend and Resume are nonterminal controls for the same speech and the same host player. `audio_suspended` is an audible-quiescence barrier: the host has paused the player, included its bounded presentation latency, settled callbacks, retained already queued audio in place, and reports the cumulative unique source frames actually played. No callback or audible progress from the suspended generation may cross that barrier. `audio_resumed` confirms that the same retained player is ready to continue, with an unchanged cumulative `played_frames`, before the child releases more PCM. Both acknowledgements are bounded to two seconds. While fully suspended, the child blocks synthesis delivery without applying the normal two-second played-credit deadline; memory remains bounded by the existing backend and transport queues, and cancellation, shutdown, host failure, or EOF wakes the wait.

Stdout and the PCM pipe are independently observed. A host must therefore correlate a Suspend that arrives before Begin, acknowledge it at zero only after proving the route quiescent, and keep the later Begin paused until Resume. The child emits Suspend only for the active speech, emits no later Chunk or End while waiting for its acknowledgement, and does not emit Resume until both speaking and recognition-pending state have cleared without a final. If no-result settlement races the Suspend acknowledgement, Resume follows that exact barrier. A real final, targeted cancellation, host mute/reset of a provisional hold, pause, or shutdown suppresses Resume, waits any already-emitted Suspend or Resume acknowledgement, then serializes Cancel. End or Drained racing ahead of Suspend remains a provisional logical hold rather than publishing completion; no-result Resume releases exactly one completion, while terminal cancellation clears the held host state and publishes exactly one interruption. Stale, mismatched, regressed, post-barrier, or unsolicited suspension acknowledgements are fatal.

Begin must be accepted before the first Chunk. Only one Chunk may await
acceptance. Accepted-but-not-fully-played credit is measured in cumulative
source frames and is duration-derived to retain at least 400 ms of runway at
the Begin sample and playback rates. The child coalesces backend callbacks into
4096-frame records plus one final tail. The host nevertheless validates source
duration rather than assuming full records and also caps the queue at 64 records
(at most 1 MiB of Float32 PCM). Every individual record remains bounded to 4096
source frames.
The child flushes `output_ready_result(accepted)` before writing Begin, but
stdout and the PCM pipe are independently observed. The host may therefore
buffer one valid Begin for the single reserved speech for at most two seconds;
it must not acknowledge Begin until its session actor has applied `accepted`.
A second Begin, a speech mismatch, a stale result, or rendezvous expiry is
fatal.
`audio_played.played_frames` is cumulative, monotonic source-frame truth and may
legitimately lag newer accepted sequences. It cannot exceed accepted frames.
End follows the last accepted Chunk. Drained must name End's last sequence and
confirm every source frame played before completion is published. A device host
must include its bounded post-render route latency before stopping the engine
and sending Drained; node buffer consumption alone is insufficient. That grace
must remain within the child's two-second End-to-Drained deadline. Cancellation
or failure bypasses the grace and quiesces immediately.

Cancel is an ordered pipe record. `audio_cancelled` is a quiescence barrier and
its settled played count is the authoritative partial-delivery snapshot before
the child publishes interruption. A cancellation timeout or host failure
publishes `speech_failed`, not `speech_interrupted`. When cancellation overtakes
an already-written Begin, Chunk, or End, the exact in-flight acceptance,
progress, Drained, or Failed acknowledgement may settle before the pipe-ordered
Cancelled acknowledgement. Cancelled is then the quiescence barrier: failure
wins the speech outcome, otherwise cancellation wins. Callbacks after that
barrier are protocol-fatal. Outside this narrow race, Drained, Failed, and
Cancelled are terminal. Only an exact duplicate in-phase played count is
idempotent. Unknown or future speech IDs, sequence gaps or regressions,
impossible counts, and stale terminal
acknowledgements are fatal.
If a backend or pipe write fails and the child cannot obtain a quiescent cancel
barrier, it emits that speech's failure and terminates the session data plane;
it never admits a replacement while old host audio may still be active.

## Parent requests

```text
{"type":"hello","id":u64,"input_during_tts":"allow_barge_in"|"suppress_input"}
{"type":"set_paused","active":bool}
{"type":"set_input_muted","id":u64,"active":bool}
{"type":"set_tts_settings","id":u64,"expected_revision":u64,"settings":TtsSettings}
{"type":"set_input_during_tts","id":u64,"expected_revision":u64,"policy":"allow_barge_in"|"suppress_input"}
{"type":"reset_input","id":u64}
{"type":"prepare_speak","id":u64,"acknowledgement":u64|null,"text":string}
{"type":"output_ready","id":u64,"speech_id":u64}
audio acknowledgements listed above
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

`set_input_during_tts` changes the policy for later admissions. Its expected
revision must be positive. The correlated result is always authoritative:

```text
{"type":"input_during_tts_result","id":u64,"outcome":"applied"|"rejected","snapshot":{"revision":u64,"policy":"allow_barge_in"|"suppress_input"}}
```

A stale revision is rejected nonfatally with no mutation. Each speech leases
the current policy when it is admitted; a held prepare leases only when it is
eventually admitted. Updating the policy never changes an already-admitted
utterance.

`set_input_muted` controls the host-mute reason. Assistant suppression is a
separate guard-owned reason, so clearing either reason cannot clear the other.
The effective input-mute epoch advances only when the composed state changes.
`set_input_muted` and `reset_input` return exact correlated acknowledgements:

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

It does not begin synthesis. The parent replies with the originating prepare
ID and speech ID when it is ready to accept output:

```text
{"type":"output_ready","id":u64,"speech_id":u64}
{"type":"output_ready_result","id":u64,"speech_id":u64,"outcome":"accepted"|"stale"}
```

Before emitting `accepted`, the child installs the admitted speech's leased
assistant-activity guard. `suppress_input` stops PCM admission so user input
cannot interrupt the speech; `allow_barge_in` continues PCM admission with the
assistant-sensitive VAD threshold. `accepted` transfers output authority. The
child then writes Begin and waits for `audio_begin_accepted` before delivering
PCM. Readiness is bounded to two seconds; expiry emits `speech_failed` with zero output. With `allow_barge_in`, speaking or recognition pending provisionally suspends started output. If both clear without a final, the same speech and player resume. A final, targeted cancellation, host mute/reset while provisionally suspended, pause, or shutdown discards the hold and interrupts exactly once.
Accepted output owns exactly one assistant-activity guard. The child removes
that guard before emitting completion, interruption, or failure, including
cancellation and shutdown terminals.

## State, cancellation, and output events

```text
{"type":"pending","id":u64,"utterances":[{"token":u64,"text":string}]}
{"type":"not_admitted","id":u64,"reason":"paused"|"in_progress"|"cancelled"|"empty_text"}
{"type":"state","id":u64,"confirmed_token":u64,"utterances_after":[{"token":u64,"text":string}]}
{"type":"cancel_result","id":u64,"outcome":"cancelled"|"stale","speech_id":u64|null}
{"type":"speech_started","id":u64,"speech_id":u64}
{"type":"speech_completed","id":u64,"speech_id":u64}
{"type":"speech_interrupted","id":u64,"speech_id":u64,"spoken_through_utf8":u64}
{"type":"speech_failed","id":u64,"speech_id":u64,"message":string}
{"type":"fatal","message":string}
```

`query_state.after` is an exclusive token cutoff; `0` requests all. `cancel.id`
targets the originating `prepare_speak.id`. `cancel_result` is emitted first. A
live held target then emits `not_admitted(cancelled)`; a live admitted target
then emits `speech_interrupted`. `spoken_through_utf8` is Berd Voice's conservative UTF-8 byte boundary through the last fully played word; hosts may use it to distinguish the estimated spoken prefix from the unspoken suffix without recreating delivery policy. Repeated or unknown cancellation is stale.
Every speech event carries the originating prepare ID. `speech_started` appears
only after the first PCM Chunk is accepted by the host, and exactly one terminal
message follows every admission.

On `shutdown`, all complete earlier frames are processed in order. The parent
keeps stdin open while the child cancels and drains output. The child then
finishes the input runtime while continuing to drain events and storage
receipts, flushes, and exits. EOF, malformed framing, fatal
input failure, or process death cancels both authorities without transparent
restart. A fatal error is flushed exactly once and followed by no protocol
output.
