# Offline VAD replay

This command evaluates continuous-recognition activity gates from normalized JSON fixtures and measures observed waiting from call capture event logs.

Run `berd-call vad-replay INPUT.json --candidates CANDIDATES.json`. It emits JSONL, one report for the recorded settings followed by each named candidate, without opening a microphone or reading/writing live profiles. Candidate settings must be static. Recorded settings may include dynamic values because each frame records the values actually applied; replay does not simulate recognizer-driven learning.

Input has `schema_version: 1`, `session_id`, `held_out`, `frames`, `labels` and `reply_waiting`. Frames contain `end_ms`, `epoch`, `confidence`, `mode` (listening/interruption), and `settings` using the existing DetectionSettings schema. Each frame represents 16 ms. Epoch changes are explicit live gate resets; missing frame intervals leave state unknown until a full onset/release run determines it again.

Labels contain `start_ms`, `end_ms`, `speech` and `provenance` (human_checked/inferred). Label intervals must be ordered and nonoverlapping. Silence must be labeled explicitly; unlabelled audio is not assumed silent. Reply-waiting intervals contain start_ms/end_ms, also ordered and nonoverlapping. All times share the fixture's audio timeline. Candidate files contain an array of `{name, settings}`; names must be unique.

Scores report human-checked speech missed and false activity durations at 16 ms resolution, silent activity overlapping a waiting reply, onset-delay samples, missed/excluded utterances and fragmentation. Inferred labels are counted but excluded from correctness scores. Full onset samples require uninterrupted known detector coverage over the annotation. Interruption detection samples use the recorded playback mode at speech onset. They measure gate detection, not audible agent stopping. Raw samples allow tail analysis without hiding misses in an average.

These reports do not estimate a changed conversation's playback schedule. In particular, original reply-ready intervals and modes are fixed evidence. Replaying a stronger gate might change later playback in reality. Compare candidates on held-out sessions, inspect missed speech alongside latency, and trial improvements live before promoting them. No candidate is promoted by this command.

Each input file is capped at 128 MiB and a comparison at 64 candidates. Split long recordings into fixtures with preserved context and epoch boundaries. Raw recordings and fixtures stay local unless separately shared.

Run `berd-call vad-replay events CAPTURE_DIR` to analyze a `berd-call-capture/1` directory's `events.jsonl`. It measures the union of outstanding prepare-request intervals, their overlaps with VAD and pending recognition (reported separately and together), and admitted-request delay samples. Pending/not-admitted outcomes end a request interval without a successful admission sample. Gaps and capture limits censor outstanding requests; the interval immediately before a gap is excluded because its events may be missing. Requests left open at file end are reported unresolved. It also reports, from the end of detected speech, the delay to each final transcript (`final_after_speech_us`) and to each recognition hold release (`hold_after_speech_us`). A final that arrives after its hold released shows where agent speech could start before the user's words were published. Logs must be ordered by monotonic microseconds; malformed/unknown-version input fails instead of producing a success score.

Request-wait overlap is observational. It includes preparation and other scheduling, so it is not proof of delay caused solely by VAD or recognition. The event analyzer uses the capture clock; normalized frame fixtures use the audio timeline. Converting the per-frame capture trace into candidate fixtures requires explicit sample/clock and epoch mapping. It must never infer timestamps by concatenating across muted/dropped input.

Pending recognition can hold replies after VAD clears. The Apple worker starts the pending-utterance timeout (five seconds by default) when VAD ends. A final releases every ended turn its audio range covers. If Apple's latest result is interim words rather than a final, the hold lasts up to `interim_words_wait_ms` (ten seconds by default) past the timeout, until their final arrives. Apple re-reports words a final leaves out, and interim results end where its audio does rather than at the last word, so the order of results decides this rather than their samples. When the hold expires, recognition keeps running, so late finals still reach the conversation. Captures record each final's coverage as `recognized`, the newest interim audio as `heard`, and Apple's finalization point as `settled`, all in recognizer samples. Gate replay cannot prove transcript preservation under changed reset policies. Those trials require original audio, repeated recognition runs against the current-policy baseline, and omission/duplicate/late-result evaluation.

## Captured detector frames

Run `berd-call vad-replay convert CAPTURE_DIR > fixture.json`, then compare `fixture.json` with the usual replay command. Conversion reads `manifest.json`, `vad.jsonl`, `events.jsonl`, `mic.wav` and a companion `labels.json`. It never changes capture files or live profiles. Only macOS continuous recognition is supported. Missing settings, missing detector rows, inconsistent decisions, unsupported backends and explicit capture gaps/pauses/limits fail before emitting a fixture. Use `vad-replay extract` to score captures containing gaps.

Create `labels.json` with an explicit session identity and held-out membership:

```json
{"schema_version":1,"session_id":"desk-2026-10-22","held_out":true,"labels":[{"start_sample":0,"end_sample":48000,"speech":true,"provenance":"human_checked"}]}
```

Label bounds are start-inclusive, end-exclusive indices in the mono 48 kHz `mic.wav`, aligned to whole milliseconds (48 samples). Do not mark inferred labels as human checked. Empty labels are allowed and produce unlabelled coverage rather than correctness scores. The converter checks trace and label bounds against the WAV header. It does not verify every audio sample or establish that the recording contains the original microphone signal.

Detector `mic_sample` is the end-exclusive source sample index. Conversion floors it to milliseconds, losing less than one millisecond of alignment precision. Processing `us` is validated separately and is never substituted for audio time. Effective settings revisions rebuild each frame; changes to either mute epoch or recognizer generation create a replay reset. For known gate states, recorded `active` must agree with the reconstructed baseline. Resampler history crossing resets remains part of the recorded probabilities.

Converted fixtures deliberately contain no `reply_waiting` intervals. Use `vad-replay events` for observed protocol waiting on the processing clock. Its intervals cannot be projected onto source samples without measuring input buffering and worker latency; a zero `silent_reply_held_ms` from a converted fixture therefore does not establish an absence of waiting. Counterfactual recognition-policy trials against original audio remain separate work.

The resampler may produce a leading detector frame whose audio ends before sample 768 (for example, sample 513). Replay retains its full gate observation, but clamps its scored interval to recording time zero. The detector frame includes padding; correctness and coverage totals include only its recorded audio span. Subsequent frames remain 16 ms apart or have explicitly missing coverage.

## Failure fixtures

Run `berd-call vad-replay extract CAPTURE_DIR OUT_DIR --partition train|held-out` to cut a capture into short fixtures around likely detection failures. The partition has no default. When `labels.json` exists, its `held_out` must match it; without one, fixtures carry no labels. Every fixture inherits the partition and a `source_session` of `capture-<manifest started_unix_ms>`, which stays the same across recuts and later labelling. Evaluation must group fixtures by source session, so one capture can never supply both training and held-out evidence.

Findings are hints for review, never labels:

- `fragment`: the recorded gate released and became active again within one second.
- `interruption`: the gate became active while the agent was speaking.
- `reply_held`: a `prepare_speak` request waited at least a second. It is located by the capture's frame count when each message was processed, so its audio position is approximate.
- `missed_speech` and `false_activity`: the recorded gate disagrees with a human-checked label.

Each finding gets up to three seconds of context on each side, and overlapping clips merge. A clip may reach back up to six seconds for a reproducible start, and a `reply_held` clip spans the whole wait.

**Gaps.** Clips never touch a gap or limit record, frames lost from `mic.wav`, missing detector rows, or trace beyond `mic.wav`.

- A pause splits the capture where it occurs, and the detector frame containing it is dropped.
- Records dropped behind a full capture queue cut everything up to 1025 mic frames (20.5 s) after the marker, because the lost records follow it.
- Gap and limit intervals are listed as `excluded`. Missing detector rows only split the capture.
- None of these intervals is ever scored.

**Clip starts.** A clip may start only where a fresh replay gate equals the live one. `provenance.start` records which kind of start was used:

- `capture_start`.
- `gate_reset`: a recognizer generation or mute epoch boundary. This is exact for any candidate, given the recorded reset schedule.
- `quiet`: the recorded gate was inactive, and the preceding second of frames was undetected with probability at most 0.1. This is exact only for settings whose listening and interruption thresholds are both at least `max_probability` and whose `release_ms` is at most `ms`.

A finding without such a start in its context window is excluded rather than cut from an unknown state. Speech labels that begin before their clip are dropped from it (and reported), because truncating them would score a false onset. Other labels are clipped with their provenance unchanged. `missed_speech` is reported only where detector frames cover the whole label.

**Output.** Each `OUT_DIR/<session_id>/` directory contains:

- `fixture.json`: provenance (including `held_out` and `audio_setup`) and findings. `audio_setup` holds the clip's input and output device UIDs and their `basis`, described below.
- `input.json`: a replay input on the clip's own timeline, for the replay command above.
- `mic.wav`: begins at `provenance.source_sample_offset`, which is a multiple of 48 samples, so clip milliseconds are source milliseconds minus `offset / 48`.
- `vad.jsonl` and `events.jsonl`: verbatim source lines, still on the source sample and processing clocks. `vad.jsonl` is preceded by the settings records it references.

Extraction refuses to overwrite an existing fixture directory, checking every destination before it writes any. It prints a summary including every exclusion and its reason.

**Audio setup.** On macOS the host sends `audio_route` requests, which the session ignores and a capture records in `events.jsonl` in order with the microphone frames around them. Each carries `observed_us` on the host's monotonic clock and one observation:

- `input_opened`: a microphone stream is built and playing on `input_uid`. The host sends it before forwarding any of that stream's frames, and closes the stream before the `reset_input` that precedes any other device. A failed open sends nothing.
- `output`: the default output's `output_uid` and `changes`, the number of default-output change notifications CoreAudio had delivered. The host sends one before the first microphone frame, whenever either value changes at its 500 ms poll, and at least every 5 seconds. CoreAudio delivers the notifications on the main run loop, so a host started with `--no-menu-bar` sends none, and its clips are excluded.

In a capture with route records, a clip gets `basis: "observed_route"` only when:

- it lies within one input stream, from its `input_opened` to the next `reset_input` or possible record loss (a `capture_dropped` gap or `limit`);
- output observations at or before its start and at or after its end, and every one between, agree on `output_uid` and `changes`;
- no possible record loss overlaps the span from the earlier of the stream's opening and the first of those observations to the later of the clip's end and the last. Records dropped behind a full queue may follow their marker by up to a queue of records, so that whole span counts as loss.

Otherwise its findings are excluded. The input is then exact. The output is only observed: notification delivery has no established bound, and playback follows the system default rather than a device the host selects, so no observation establishes the device that played agent audio during the clip.

Captures without route records keep the setup read when the session started, with `basis: "session_start"`, or null when the session could not read both UIDs, including older captures that recorded only device names.

## Loading fixtures for evaluation

`learning_corpus::load` reads fixture directories into one corpus per input and output device UID pair. Each corpus holds index-aligned `inputs`, `source_sessions` and `starts` for `evaluate_grouped`, sorted by source session and offset, plus each fixture's provenance and findings for audit. Loading checks each fixture's own consistency, not its clip start, which only re-running extraction on the source capture can verify.

A fixture is rejected, with its directory and reason, when:

- its schema, `input.json` or provenance fields are invalid or unknown;
- its `session_id` or partition disagrees with its provenance, or its source session is not a canonical `capture-<ms>`;
- its interval is empty or not 48-sample aligned, or its frames, labels or reply waits extend past its audio;
- its `quiet` start has a probability bound outside 0 to 1 or a zero duration;
- its `mic.wav` is not mono 48 kHz PCM16, or its decoded samples (not its header length) differ from the provenance interval;
- its capture recorded no device UIDs, or an empty one.

A source session is rejected entirely when its fixtures overlap (including a recut under another policy), span both partitions, mix setup bases, or disagree on a session-start setup. Observed routes may change within a source, whose fixtures then join each setup's corpus. Fixture files must be regular files. `fixture.json`, `input.json`, the fixture count and the total bytes read are all bounded; exceeding the count or total fails the whole load.

Every corpus is currently diagnostic only, and lists why in `trial_ineligible`:

- `session_start`: the host can switch detection profiles when devices change during a call, so a setup read at session start does not establish the devices behind each clip.
- `observed_route`: the input is exact, but the output is an observed default. A corpus can authorize a live profile trial only once playback reports the device it actually rendered each utterance on (including engine configuration changes mid-utterance), or default-output changes gain a defensible continuity mechanism.

## Grouped evaluation

Run `berd-call vad-replay evaluate BASELINE.json FIXTURE_DIR...` with a serialized `DetectionSettings` baseline and extracted fixture directories. The command writes one `berd-call-evaluation/1` JSON document containing grouped comparisons, source/start metadata, fixture provenance, rejected fixtures and trial eligibility. It uses the default acceptance policy and changes no saved profiles. A successful command means the report was produced; inspect `trial_eligible` and rejection reasons to determine the outcome. Neither setup basis yet makes a corpus trial-eligible, even if replay accepts a candidate.

Automatic callers use `learning_evaluation::evaluate_corpus` and its `eligible_candidate()` accessor. The returned `EligibleCandidate` binds settings and the original baseline to the corpus device UIDs, and has no public constructor or deserializer. Replay acceptance without eligible device evidence cannot produce it. Dynamic baselines remain diagnostic because replay evaluates static thresholds. The accessor authorizes only a monitored trial; persistence must still check the current device and baseline and retain rollback settings. Current extracted corpora remain ineligible for the provenance reasons above.
