# Custom bundled agents

This directory holds agent Markdown files available to Berd release builds.
Selected files are staged into `distro/agents/` only for the duration of the
build. Official builds default to `block,builderbot`; custom builds default to
the public-safe `builderbot` selection.

## Adding an agent

Create a file named `<slug>.md` in this directory with a valid agent header,
for example:

```yaml
---
name: Support bot
description: Answers questions from a custom support runbook.
avatar: app-avatar:<pack>-<id>
metadata:
  berdBundled: true
---

Your agent instructions go here.
```

Requirements:

- `name` and `description` are required strings.
- `avatar` must be an `app-avatar:<pack>-<id>` reference so the avatar cache
  is warmed at startup.
- `metadata.berdBundled` must be `true`. This makes the runtime treat the file
  as bundled, so it gets refreshed when the bundled source changes.
- The filename must be a lowercase slug matching `^[a-z0-9][a-z0-9-]*$`.

## Selecting bundled agents

Official release builds bundle `block,builderbot` by default. Custom release
builds bundle only `builderbot`, keeping the Block-internal `block.md` agent out
of public and customer distributions. Either build kind can override its
default by setting `CUSTOM_BUNDLED_AGENTS`. In the custom pipeline, put it in
the **Custom build env overrides** JSON field in
`.buildkite/custom-release.yml`. Provide a comma-separated list of basenames
without the `.md` extension. For local runs, set the environment variable
directly.

```json
{"CUSTOM_BUNDLED_AGENTS":"support-bot,oncall-captain"}
```

Selected files are copied into `distro/agents/` before the Tauri build and
removed afterward. Agents not selected are never bundled.
