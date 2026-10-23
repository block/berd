# Adaptive speech detection

Proposed direction, October 22, 2026. Independent static thresholds are implemented by PR 421. Adaptive tuning and audio profiles below are proposed until their implementation is validated.

A caller should be able to stop background noise holding replies without losing quiet speech. Listening and interruption each have a slider, visible current value, and an opt-in Dynamically adjust checkbox. Adjustments move one 0.01 tick at a time within 0.10 to 0.95. Manual values remain available across the full 0 to 1 range.

For the initial experimental macOS recognizer, local detections that settle without a nonempty transcript are evidence to increase the threshold. Nonempty transcripts without corresponding local detection provide evidence to decrease it. These are heuristics, not ground truth: recognizer failures, late or split results and playback leakage can mislead them. Ignore ambiguous observations across mute/reset, playback-mode and device changes; move one tick per qualifying outcome and expose evidence counters with current values. Other recognition backends require their own reliable outcome signals before enabling adaptive tuning.

Save independent values and dynamic choices by stable input/output device identity pair. AirPods input/output, another headset, and the built-in input/output pair retain separate profiles. Restoring a profile must discard old learning evidence so one setup cannot train another. No microphone recordings or transcript text are stored in these profiles.

The host owns device identity and persistence. The shared input runtime owns thresholds, and the host-facing session protocol carries updates and reports applied values. Existing settings files remain readable by older binaries. Prefer a separate bounded, atomically replaced profile file to changing their strict schema.

## Speech hold correction, October 22, 2026

Product direction: bound the agent speech hold while transcription is pending, without cancelling recognition when the hold expires. Valid late transcripts remain accepted. New speech reasserts the hold. Keep hold accounting distinct from unresolved recognition and ignore expired or ambiguous outcomes for detector tuning. The configurable idle hold defaults to five seconds, bounded between 250 and 30000 milliseconds. This supersedes using the idle timeout as a no-result/reset signal.

## Recognition health correction, October 23, 2026

An empty recognition result is diagnostic evidence only. It cannot raise either speech threshold because recognizer failures can produce the same result as noise. This supersedes the original no-result increase heuristic. Final transcripts remain positive speech evidence. Automatic candidate trials must retain the saved baseline until independent trial checks pass.
