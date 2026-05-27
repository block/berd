---
name: goose-help
description: >-
  Help users understand, use, or troubleshoot Goose Internal. Use when the user
  asks how to do something in the app, configure agents, skills, providers,
  extensions, projects, avatars, automations, settings, updates, connections,
  models, sessions, or Doctor, or when Goose Internal appears broken, stuck, or
  confusing.
metadata:
  gooseInternalBundled: true
---

# Goose Help

Use this skill to help users operate and troubleshoot Goose Internal from a
normal chat.

## First Principles

- Before giving exact product instructions, try to verify the behavior from
  available evidence. If source code is available, inspect it first. If source
  code is not available, use visible app state, screenshots, error messages, or
  Doctor output.
- Do not invent UI paths, menu names, frontmatter fields, feature existence, or
  fallback workflows. If you cannot verify the exact path, say that and ask for
  a screenshot, selected project/source access, or the specific screen the user
  is on.
- Treat the current app behavior as the source of truth. Prefer evidence from
  visible UI, runtime state, error messages, Doctor output, local files, and
  available source over memory or stale documentation.
- Give practical steps the user can try now. Keep the answer short unless the
  problem needs a deeper diagnosis.
- Do not claim access to private GitHub source unless it is actually available
  in the current environment.

## What To Check

For how-to questions:

- Identify the feature area: agents, skills, projects, providers, extensions,
  connections, settings, automations, sessions, avatars, updates, or Doctor.
- If source is available, search for the feature's UI, command, hook, tests, or
  i18n strings before answering. For example, avatar behavior may live in agent
  builder UI and avatar library code; export behavior may live in session
  history UI and ACP export helpers.
- Use the app's current state when available: selected agent, project, model,
  provider, active session, attached files, visible errors, or screenshots.
- Explain the shortest path to the action, then mention important constraints or
  gotchas.

For troubleshooting:

- Ask for the exact error, screenshot, provider/model, project path, or Doctor
  result when the symptoms are ambiguous.
- Suggest low-risk checks first: rerun, reconnect, verify settings, check
  selected model/provider, restart the app, or run Doctor when relevant.
- Separate likely causes from confirmed causes.

## Working With Bundled Builder Skills

- If the user wants to create, edit, or inspect an agent/persona, use or
  recommend the `agent-builder` skill.
- If the user wants to create, edit, or inspect a reusable skill, use or
  recommend the `skill-builder` skill.
- Do not duplicate those workflows inside this skill. This skill helps users
  understand and troubleshoot the app around them.

## Source Of Truth

When source code is available, use it to verify behavior. Good places to inspect
include UI feature folders, Tauri commands, distro bundled skills, settings
views, and tests. If source code is not available, rely on current app context
and be transparent about uncertainty.
