---
name: berdctl-new-command
description: Use when adding, extending, modifying, or removing berdctl commands, verbs, nouns, schemas, help text, or any of the berdctl surface.
---

# berdctl command changes

One command is one renderer module. Descriptors are the source for zod
validation, TS input types, CLI help, and generated contract JSON. Background:
`docs/berdctl-architecture.md`.

## Rules

- Verbs must be UI-visible. Prefer reversible mutations, but one-way visible
  product actions like creating a session or sending a prompt are allowed.
  Delete, bulk, silent, invisible, or broadly destructive work requires
  auth/confirmation design review.
- Put bounds in zod; clap mirrors them.
- Keep descriptors import-pure. Import stores, Tauri APIs, navigation,
  providers, and caches only inside `execute`/`precheck`.
- Do not hand-edit generated contract JSON.
- Keep the broker command-agnostic; normal command changes do not touch
  `src-tauri/plugins/berdctl/`.
- Breaking wire reshapes bump both discovery.rs constants and the contract
  mirror. New commands and optional fields are not reshapes.

## Workflow

- Add commands with `just new-command <noun> <verb>`.
- Implement `src/features/berdctl/commands/impl/<verbNoun>.ts` with:
  `.strict()` schema, `.describe()` on every field, `summary`, `description`,
  `helpFooter`, safety metadata, optional `precheck`, and `execute`.
- Update inventories only when needed: `registry.ts` group `cli.about`,
  top-level help pins in `tree.rs`, and `distro/skills/berdctl/SKILL.md` for
  overview changes.
- Run `pnpm generate:berdctl-contract`,
  `pnpm vitest run src/features/berdctl`, and `cargo test -p berdctl` from
  `src-tauri/`.
- Before review, confirm the verb is UI-visible and either reversible or a
  direct visible product action, help is complete, error messages name the
  fixing command, artifacts are regenerated, and tests cover the behavior.

Keep CLI shapes expressible by the generated field walker. If a requested
operation needs an explicit null or another shape that generic flags cannot
represent safely, model it as a separate command action instead of adding
command-specific Rust mapping. Example: use `session move --project-id <id>`
for moving into a project and `session clear-project` for moving out.
