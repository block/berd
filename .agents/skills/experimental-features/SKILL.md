---
name: experimental-features
description: Use when adding, reviewing, configuring, graduating, or removing Goose Internal experiments.
---

# Experimental Features

Use experiments for opt-in, user-local in-progress Goose UI or workflow behavior.
Do not use experiments for secrets, credentials, backend authority, packaged
policy, or app state that should survive graduation as a normal preference.

## When To Use Experiments

- An individual user opts into unstable UI or workflow behavior.
- Stable behavior can remain the default path.
- Config is small, non-sensitive, typed, and user-editable.
- The feature can be graduated or removed later.

## When To Use `distro.json`

Use `distro.json` for packaged build policy and startup defaults, especially
when the Tauri shell or sidecar needs bundled resources/config.

Good distro fits include `providerAllowlist`, `kgoose`,
`featureToggles.costTracking`, bundled `config.yaml`, `bin/`, `skills/`, and
`agents/`.

Do not use `distro.json` for normal app state, user preferences, dynamic runtime
switches, ACP-backed data, or per-user experiments.

## Registry Shape

Add experiments only in
`src/features/experiments/experimentDefinitions.ts`.

Each definition needs:

- `id`: stable kebab-case string
- `titleKey` and `descriptionKey`: settings i18n keys
- `defaultEnabled`: optional, default `false`
- `config`: optional typed controls

Supported config controls:

- `boolean`: switch with a boolean default
- `select`: fixed string options with a default
- `number`: default plus optional min/max/step
- `text`: default plus optional placeholder; never for secrets

Use `getExperiment(id)` or `useExperiment(id)` for callers. When an experiment is
disabled, keep config stored but gate behavior as disabled.

## Storage Contract

Experiment preferences live in `localStorage` under
`goose:experimental-features`:

```json
{
  "version": 1,
  "experiments": {
    "experiment-id": {
      "enabled": false,
      "config": {}
    }
  }
}
```

- Treat `version` as real schema state. On newer stored versions, abort writes
  instead of overwriting; on older versions, migrate explicitly or discard.
- Preserve unknown experiment ids when writing so branch switches do not erase
  local choices.
- Write only the touched experiment/key and re-read latest storage immediately
  before saving to reduce cross-window clobbering.
- Setters return `boolean`; callers must surface failed writes to users.
- Use `useSyncExternalStore` for React subscriptions. Memoize only the current
  raw storage value per registry/id; do not retain historical snapshot keys.

## Config UX

- Boolean controls use switches.
- Select controls use fixed options.
- Number controls keep a string draft while editing, commit on blur, treat empty
  input as no write, commit on Enter, and clamp to min/max on commit.
- Text controls are never for secrets.
- Config controls may stay editable in storage while disabled, but UI should make
  disabled/inert behavior clear when the experiment is off.

## Tauri Guardrails

Do not add Rust commands, capabilities, or permissions unless the experiment
needs backend authority. If backend access is required, add the smallest typed
command possible, validate all IPC input, return `Result`, and use async for
heavy work so the UI does not freeze.

When adding commands, update capabilities with least privilege. If backend state
is needed, use Tauri managed state deliberately and protect shared mutable state
correctly.

## Testing

Cover:

- default-off behavior
- enabled and disabled behavior for any gated caller
- invalid localStorage fallback
- unsupported storage version fallback or migration
- typed config validation
- number-control draft and clamp behavior
- same-window preference updates
- cross-window storage events
- read and write storage failures
- preserving unknown experiment ids when writing
- injected test registry UI behavior without shipping fake experiments

Run focused Vitest tests and `just check` for frontend changes.

## Graduation Cleanup

When graduating or removing an experiment, remove the registry entry, i18n keys,
settings UI tests, storage assumptions, and all gated code paths. Keep migrations
small and explicit if the final feature needs a real user preference.
