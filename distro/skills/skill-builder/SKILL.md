---
name: skill-builder
description: >-
  Create, edit, or inspect Goose skills stored as skill folders with SKILL.md
  files. Use when the user wants to build a new skill, update an existing skill,
  convert a workflow into a reusable skill, or decide whether instructions,
  scripts, references, or assets belong in a skill.
metadata:
  gooseInternalBundled: true
---

# Skill Builder

Use this skill when creating, editing, or inspecting Goose skills.

## What a Skill Is

A skill is a folder with a required `SKILL.md` file and optional supporting
resources:

```text
skill-name/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

Do not create `README.md`, `CHANGELOG.md`, or extra documentation files inside a
skill folder. Skill documentation belongs in `SKILL.md` or `references/`.

## Storage Decision

Skills can be global or project-local:

- Global: `~/.agents/skills/<skill-name>/SKILL.md`
- Project-local: `<project>/.agents/skills/<skill-name>/SKILL.md`

Default to global unless the user is clearly working in a project directory.

If a project directory is active and the user has not specified scope, ask
whether the skill should be saved for this project only or globally for all
projects.

Do not ask when intent is clear:

- Project-local: "this repo", "this project", "only here", "project skill"
- Global: "all projects", "global", "personal skill", "always available"

When editing an existing skill, keep it in its current location unless the user
explicitly asks to move it.

## Format

`SKILL.md` is UTF-8 Markdown with YAML frontmatter:

```md
---
name: skill-name
description: What the skill does. Use when the user asks to...
---

# Skill Title

Instructions the agent follows.
```

Required frontmatter keys are `name` and `description`. Preserve unknown
frontmatter keys when editing existing skills unless the user explicitly asks to
change them.

The `description` is the trigger surface. It must explain both what the skill
does and when to use it. Include concrete user phrases or task types. Keep it
specific enough to avoid triggering for unrelated work.

## Names

Skill names and folder names must match.

Use lowercase kebab-case:

- Allowed: `a-z`, `0-9`, and `-`
- Maximum: 64 characters
- Do not start or end with `-`
- Do not use spaces, underscores, slashes, or capitals

Normalize user-provided titles by lowercasing, replacing invalid character runs
with `-`, collapsing repeated separators when practical, trimming leading and
trailing `-`, and truncating to 64 characters. Fall back to `skill` if needed.

On create collisions, use `<skill-name>-2`, `<skill-name>-3`, etc.

## Authoring Workflow

1. Understand the skill with concrete examples.
   Ask for 2-3 example requests or workflows if the goal is vague. Do not ask
   when the user has already provided enough detail.
2. Decide the skill shape.
   Keep simple procedural guidance in `SKILL.md`. Add optional folders only when
   they earn their keep:
   - `scripts/` for deterministic or repeatedly rewritten code
   - `references/` for detailed docs loaded only when needed
   - `assets/` for templates, fonts, icons, or files used in outputs
3. Create or edit the skill folder.
   Prefer direct file edits over helper scripts unless the repo already has a
   relevant script.
4. Validate the result.
   Confirm the folder exists, `SKILL.md` exists with exact casing, frontmatter is
   valid YAML, required keys are present, the name matches the folder, and
   existing metadata was preserved.
5. Report the final path and a short summary of what the skill now does.

## Editing Existing Skills

Read the existing skill before editing. Resolve targets by exact path, then
frontmatter name, then folder name. Ask only if multiple matches remain.

Preserve supporting folders and unknown files unless the user explicitly asks to
remove them.

## Quality Checklist

Before finishing, check:

- The skill has a clear, narrow purpose.
- The description has likely trigger phrases and avoids vague claims.
- Critical instructions are near the top of the body.
- The body is concise; detailed material moves to `references/`.
- Any fragile or repetitive operation uses a script where practical.
- The skill can work alongside other skills without assuming it is the only
  active skill.

## Trigger Testing

When useful, suggest a tiny test set:

- Should trigger: obvious requests and paraphrases for the workflow.
- Should not trigger: unrelated tasks and adjacent workflows outside scope.

If a skill under-triggers, make the description more concrete. If it
over-triggers, narrow the description and add negative scope guidance.
