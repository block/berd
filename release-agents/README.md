# Custom bundled agents

This directory holds agent Markdown files available to Berd release builds.
Selected files are staged into `distro/agents/` only for the duration of the
build. Official and custom builds do not select any release-only agents by
default. The starter agents are always bundled from `distro/agents/`.

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
  berdBundledSource: support-bot
---

Your agent instructions go here.
```

Requirements:

- `name` and `description` are required strings.
- `avatar` must be an `app-avatar:<pack>-<id>` reference so the avatar cache
  is warmed at startup.
- `metadata.berdBundled` must be `true`.
- `metadata.berdBundledSource` must be a unique lowercase source ID. It must
  not reuse the reserved `berdy`, `tinker`, or `wildcard` IDs.
- The filename must be a lowercase slug matching `^[a-z0-9][a-z0-9-]*$`.

## Selecting bundled agents

Release builds select no agents from this directory by default. Either build
kind can opt into agents by setting `CUSTOM_BUNDLED_AGENTS`. Provide a
comma-separated list of basenames without the `.md` extension.

```json
{"CUSTOM_BUNDLED_AGENTS":"support-bot,oncall-captain"}
```

Selected files are copied into `distro/agents/` before the Tauri build and
removed afterward. Agents not selected are never bundled.
