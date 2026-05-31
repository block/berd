# Goose distro bundles

A Goose distro bundle is an optional app-specific package of configuration and policy that the Tauri shell loads at startup.

## What a distro bundle is

A distro bundle lives under `distro/` in development, and is bundled into the packaged app as a Tauri resource in production.

Current supported files:

- `distro.json` — distro manifest
- `config.yaml` — optional Goose config passed to `goose serve`
- `bin/` — optional executables or helper scripts prepended to `PATH` for `goose serve`
- `skills/` — optional bundled skills seeded into the user's global skills directory
- `agents/` — optional bundled agents seeded into the user's global agents directory

## How it is discovered

The Tauri app resolves the distro bundle in this order:

1. `GOOSE_DISTRO_DIR`, if set
2. bundled Tauri resource dir at `resource_dir()/distro`

In development, `just dev` and `just dev-debug` automatically export `GOOSE_DISTRO_DIR` to `distro` when that directory exists.

## Manifest shape

Example:

```json
{
  "appVersion": "development",
  "featureToggles": {
    "costTracking": false
  },
  "kgoose": {
    "baseUrl": "https://kgoose.sqprod.co/",
    "path": "cash-app/goose"
  },
  "providerAllowlist": "databricks"
}
```

### Fields

- `appVersion?: string`
  - optional app version tag supplied by the distro

- `featureToggles?: Record<string, boolean>`
  - optional UI/product flags controlled by the distro
  - currently supported:
    - `costTracking`
      - `false` hides cost UI in the token/context usage surfaces
      - omitted behaves as enabled

- `providerAllowlist?: string`
  - comma-separated provider ids
  - suggests which model providers to show in Settings
  - suggests which Goose model options to show in the chat model picker

- `extensionAllowlist?: string`
  - comma-separated extension ids
  - reserved for future UI suggestions

- `kgoose?: { baseUrl?: string, path?: string }`
  - default kgoose endpoint used by KGoose-backed features
  - `baseUrl` must use `http` or `https`
  - environment variables `GOOSE_INTERNAL_KGOOSE_BASE_URL` and
    `GOOSE_INTERNAL_KGOOSE_PATH` override these values for local testing

## Runtime effects

When a distro bundle is present, Goose does two kinds of things with it.

### Frontend behavior

The frontend loads `get_distro_bundle` during app startup and stores the manifest in Zustand.

Today it uses that manifest to:

- filter model providers shown in provider settings via `providerAllowlist`
- filter Goose model options shown in the chat input model picker via `providerAllowlist`
- hide cost UI when `featureToggles.costTracking === false`

These allowlists are UI suggestions only. They do not enforce backend access control and do not invalidate existing sessions or saved model choices.

### Backend / shell behavior

When the Tauri shell launches the long-lived `goose serve` process, it applies the distro bundle like this:

- prepends `distro/bin` to `PATH` when present
- adds `distro/config.yaml` to `GOOSE_ADDITIONAL_CONFIG_FILES` when present
- sets `GOOSE_DISTRO_DIR` to the resolved distro root
- uses `kgoose` as the default endpoint for KGoose-backed features
- installs `distro/skills/<name>/` entries into `~/.agents/skills/<name>/`
- installs `distro/agents/<name>.md` entries into `~/.agents/agents/<name>.md`
- warms installed bundled agent `app-avatar:` media when network access is available

This is shell-level behavior, so it is implemented as Tauri-side setup rather than an ACP method.

Bundled skills reinstall existing copies only when the installed `SKILL.md`
frontmatter has `metadata.gooseInternalBundled: true`. Existing unmarked user
skills are left untouched.

Bundled agents use the same `metadata.gooseInternalBundled: true` convention.
The app records which bundled agent files were seeded so deleted starter agents
do not reappear on later launches. Existing unmarked user agents are left
untouched. During pre-launch iteration, existing seeded agents that still carry
the bundled marker are refreshed when the bundled source file changes, so updates
to starter-agent instructions can reach internal installs before launch.

## Development notes

- packaged apps discover distro content from bundled Tauri resources
- local development uses `GOOSE_DISTRO_DIR`
- after changing `distro.json`, restart `just dev` so startup reloads the manifest

## Scope guidance

Use distro bundles for packaged-app policy and shell-level defaults.

Good fits:

- feature flags for Goose UI behavior
- allowlists that suggest visible product choices
- config or helper binaries that should be present when `goose serve` starts

Avoid using distro bundles as a replacement for normal app state, user settings, or ACP-backed domain data.
