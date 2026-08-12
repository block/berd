# Automations

An automation is a saved, re-runnable task with its own builder, run
history, and detail view — distinct from a one-off chat. It's built
conversationally (an automation builder session drafts and revises the
automation, then the user approves it into a real, savable tile) rather than
configured through a plain form. Source lives in
`src/features/automations/`; verify current capabilities and tile types
there (`resources/creatable-tile-types.json` governs what kinds of
automations can be created) rather than assuming.

A creation failure can come from two different places, and they have
different likely causes:

- **While drafting/revising in the builder session** — this runs on a
  provider/model like any other chat, so a provider issue (see
  `references/ai-providers.md`) can block it.
- **While approving or saving the tile** — this is more likely an
  automations/product issue (e.g. an unsupported tile type) than a provider
  issue. Ask which phase failed before assuming the cause.
