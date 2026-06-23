# Goose bundled app defaults

`distro/` contains generic resources and defaults that ship with the single Goose Internal app build. It is not a customer/org profile system.

## Supported files

- `distro.json` — minimal bundled manifest for app-level defaults that still need to be available before runtime config owns them
- `config.yaml` — optional Goose config passed to `goose serve`
- `bin/` — optional executables or helper scripts prepended to `PATH` for `goose serve`
- `skills/` — bundled skills seeded into the user's global skills directory
- `agents/` — bundled agents seeded into the user's global agents directory

## Discovery

The Tauri app resolves bundled defaults in this order:

1. `GOOSE_DISTRO_DIR`, if set
2. bundled Tauri resource dir at `resource_dir()/distro`

In development, `just dev` exports `GOOSE_DISTRO_DIR` to this repository's `distro/` directory when it exists.

## Manifest shape

Current `distro.json` example:

```json
{
  "kgoose": {
    "baseUrl": "https://kgoose.sqprod.co/",
    "path": "cash-app/goose"
  }
}
```

### Fields

- `appVersion?: string`
  - optional app version tag supplied by bundled defaults
- `kgoose?: { baseUrl?: string, path?: string }`
  - generic default KGoose endpoint used by KGoose-backed features until runtime config owns this source
  - `baseUrl` must use `http` or `https`
  - environment variables `GOOSE_INTERNAL_KGOOSE_BASE_URL` and `GOOSE_INTERNAL_KGOOSE_PATH` override these values for local testing

## Runtime effects

When bundled defaults are present, the Tauri shell:

- prepends `distro/bin` to `PATH` when present
- adds `distro/config.yaml` to `GOOSE_ADDITIONAL_CONFIG_FILES` when present
- sets `GOOSE_DISTRO_DIR` to the resolved distro root
- uses `kgoose` as the generic default endpoint for KGoose-backed features
- installs `distro/skills/<name>/` entries into `~/.agents/skills/<name>/`
- installs `distro/agents/<name>.md` entries into `~/.agents/agents/<name>.md`
- warms installed bundled agent `app-avatar:` media when network access is available

Bundled skills reinstall existing copies only when the installed `SKILL.md` frontmatter has `metadata.gooseInternalBundled: true`. Existing unmarked user skills are left untouched.

Bundled agents use the same `metadata.gooseInternalBundled: true` convention. The app records which bundled agent files were seeded so deleted starter agents do not reappear on later launches. Existing unmarked user agents are left untouched.

## Scope guidance

Use bundled app defaults for generic packaged-app resources and shell-level startup defaults only.

Good fits:

- bundled skills
- bundled agents
- app-local Goose `config.yaml`
- bundled `bin/`
- temporary generic app defaults that cannot yet move to runtime config

Do not use bundled app defaults for customer/org/workspace policy, customer-specific package identities, provider allowlists, feedback policy, doctor policy, runtime feature toggles, normal app state, user preferences, ACP-backed data, or per-user experiments. Customer/org/workspace behavior should come from auth and runtime/server config.
