---
name: experimental-features
description: Use when adding, reviewing, configuring, graduating, or removing Berd experiments.
---

# Experimental Features

Use experiments for opt-in, user-local in-progress Berd UI or workflow behavior.
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
- `config`: optional typed controls

Experiments without a manual per-experiment override follow the global
`autoEnable` preference. That preference defaults on in dev builds and off in
production builds. Users can force an experiment on/off or reset it back to auto
from settings.

Config entries under an experiment are settings for that experiment, not nested
experiments or independent feature flags. Keep them stored with the parent
experiment and gate their runtime effect on the parent experiment being enabled.

Supported config controls:

- `boolean`: switch with a boolean default
- `select`: fixed string options with a default
- `number`: default plus optional min/max/step
- `text`: default plus optional placeholder; never for secrets

Use `getExperiment(id)` or `useExperiment(id)` for callers. When an experiment is
disabled, keep config stored but gate behavior as disabled.

## Internal-Only Experiments

Internal-only experiments need build gates at every layer they touch:

- Add a `BuildFeature` resolved from a positive-opt-in `VITE_*` variable in
  `src/shared/profile/buildProfile.ts`, and declare the variable in
  `src/env.d.ts`.
- Map the experiment id to that feature in `BUILD_FEATURE_GATED_EXPERIMENTS`.
- If the experiment has backing Tauri commands, gate them behind a matching
  `block-*` Cargo feature and map the `VITE_*` variable in
  `scripts/block-feature-gates.sh`; drift-guard tests in
  `scripts/release/tests/release-scripts.test.mjs` enforce this.
- Set the gate to `0` in the public env in `.github/workflows/release.yml`.

Registry-level hiding stops stale per-user `localStorage` overrides from
re-enabling internal surfaces in consumer builds (issue 168).

## Storage Contract

Experiment preferences live in `localStorage` under
`goose:experimental-features`:

```json
{
  "version": 2,
  "autoEnable": false,
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
- Store `autoEnable` as the global default provider. Store `enabled` only for
  explicit per-experiment overrides; clearing `enabled` returns that experiment
  to auto behavior and must preserve `config`.
- Keep `config` under the parent experiment. Do not migrate config keys into
  separate experiment ids or apply auto-enable behavior to individual settings.
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

- dev default-on and production default-off behavior
- global auto-enable overrides and per-experiment explicit override precedence
- resetting an explicit override back to auto while preserving config
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
