---
name: agent-builder
description: >-
  Create, edit, or inspect Berd agents/personas stored as Agent Markdown files with YAML frontmatter under ~/.agents/agents. Use when user needs to manage Berd agents or personas.
metadata:
  berdBundled: true
---

# Agent Builder

Use this skill when managing Berd agents/personas in Agent Markdown format.

## Storage

Agents are UTF-8 Markdown files with YAML frontmatter:

- Global: `~/.agents/agents/<slug>.md`
- Project-local: `<project>/.agents/agents/<slug>.md`

Default to global unless the user asks for project-local.
Use platform path APIs or shell-safe home expansion.

## Format

Each agent is one `.md` file:

```md
---
name: Agent Name
description: Agent
provider: optional-provider
model: optional-model
avatar: optional-avatar
---

Agent instructions here.
```
Required frontmatter keys are name and description. Preserve all other frontmatter keys when editing existing agents unless the user explicitly changes them. The Markdown body is the agent’s system prompt/persona instructions.

When writing or generating a description or body, do not assign the agent a gender or gendered pronouns unless the user asked for one — use they/them or no pronouns, for the agent and for any people the instructions describe. Preserve pronouns the user chose, in either direction.

## Names and Slugs

For create/rename, require a trimmed name that is non-empty, ≤80 characters, and contains no `/` or `\`.

Derive `<slug>` from the name by lowercasing, replacing each non-ASCII alphanumeric run with `-`, collapsing/trimming `-`, truncating to 64 characters, and falling back to `agent`.

Write `<slug>.md`; on create collisions, use `<slug>-2.md`, `<slug>-3.md`, etc.

## Workflow
When editing, read the existing file first. Resolve targets by exact path, frontmatter name, then slug filename. Ask only if multiple matches remain.

Prefer direct file edits over helper scripts. Do not require Python, Node, or another runtime unless the current repo already requires it.

After writing, verify that the file exists, frontmatter is valid, required keys are present, and preserved metadata was not removed. Report the final path.
