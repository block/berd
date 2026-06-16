---
name: goosectl-new-command
description: Use when adding, extending, modifying, or removing goosectl commands, verbs, nouns, schemas, help text, or any of the goosectl surface.
---

# goosectl command changes

One command is one renderer module. Descriptors are the source for zod
validation, TS input types, CLI help, and generated contract JSON. Background:
`docs/goosectl-architecture.md`.

## Rules

- Verbs must be reversible and UI-visible. Delete, bulk, silent, or invisible
  work requires auth/confirmation design review.
- Put bounds in zod; clap mirrors them.
- Keep descriptors import-pure. Import stores, Tauri APIs, navigation,
  providers, and caches only inside `execute`/`precheck`.
- Do not hand-edit generated contract JSON.
- Keep the broker command-agnostic; normal command changes do not touch
  `src-tauri/plugins/goosectl/`.
- Breaking wire reshapes bump both discovery.rs constants and the contract
  mirror. New commands and optional fields are not reshapes.

## Workflow

- Add commands with `just new-command <noun> <verb>`.
- Implement `src/features/goosectl/commands/impl/<verbNoun>.ts` with:
  `.strict()` schema, `.describe()` on every field, `summary`, `description`,
  `helpFooter`, safety metadata, optional `precheck`, and `execute`.
- Update inventories only when needed: `registry.ts` group `cli.about`,
  top-level help pins in `tree.rs`, and `distro/skills/goosectl/SKILL.md` for
  overview changes.
- Run `pnpm generate:goosectl-contract`,
  `pnpm vitest run src/features/goosectl`, and `cargo test -p goosectl` from
  `src-tauri/`.
- Before review, confirm the verb is reversible/UI-visible, help is complete,
  error messages name the fixing command, artifacts are regenerated, and tests
  cover the behavior.

Keep CLI shapes expressible by the generated field walker. If a requested
operation needs an explicit null or another shape that generic flags cannot
represent safely, model it as a separate command action instead of adding
command-specific Rust mapping. Example: use `session move --project-id <id>`
for moving into a project and `session clear-project` for moving out.
