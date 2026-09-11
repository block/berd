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
