# berdctl

`berdctl` is the CLI agents use to drive the visible app — it only exposes
verbs that map to something the user can also see happen in the UI. It is
organized as `berdctl <noun> <verb>` (for example `berdctl session list`,
`berdctl project create --name demo`).

- Discover what exists by asking the tool, not by reciting a memorized list:
  run `berdctl --help` for the noun tree, then `berdctl <noun> --help` for
  its verbs.
- Treat `berdctl <noun> <verb> --help` as the authoritative reference for
  that command's flags, bounds, and behavior — flags and bounds can change,
  and this skill does not restate them.
- Add `--json` to any command for machine-readable output, useful when you
  need to parse the result rather than read it.
- Prefer `berdctl` over describing a click path when the user wants
  something done now, when the task is repetitive, or when precision matters
  more than a screenshot-friendly walkthrough. Prefer describing the click
  path when the user is trying to learn the UI itself.
- Every `berdctl` verb corresponds to something visible in the app — if a
  command claims to do something the user can't also see reflected in the
  UI, that's a signal to double check with `--help` rather than trust
  recall.

Use `berdctl session send` for an ordinary message from another session. Use `berdctl session notify` for an automated event such as a monitor update; it appears as a collapsed activity entry and still reaches the agent as context. Both commands support queueing, steering, source attribution, and idempotent delivery.

## Child sessions with Auto routing

Discover configured Goose Auto modes with
`berdctl info models --harness-id goose --json`. The Goose entry's `auto_modes`
array contains each mode's `id`, display `name`, and `is_default`; these ids are
not concrete `models[].model_id` values.

Create a child/sub-session with an explicit configured mode:

```sh
berdctl session create --prompt "Investigate this task" --harness-id goose \
  --auto-mode-id <configured-mode-id> --json
```

For Auto Balanced, use the id of the configured Balanced mode, not its display
name. Auto selects a model for each fresh prompt, rather than pinning one model
for the whole child session. Do not combine `--auto-mode-id` with `--model-id`
or a non-Goose harness. `--agent-id` may supply persona instructions while Auto
selects the model. Creation and session metadata report `auto_mode_id`.

There is no automatic inference from the parent or active UI session. Without
`--auto-mode-id`, existing creation behavior is unchanged: the configured Auto
default applies only when harness, model, and agent are all omitted. Pass the
mode explicitly when delegating so the child's intended routing is unambiguous.
