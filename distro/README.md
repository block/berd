# Berd bundled app defaults

`distro/` contains generic resources and defaults that ship with the single Berd app build. It is not a customer/org profile system.

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

`distro.json` is optional. The public-shaped build does not commit a Block
route manifest; an internal build may stage one into the packaged distro root.
For local testing, a manifest can supply generic `http`/`https` values:

```json
{
  "kgoose": {
    "baseUrl": "https://kgoose.example.test/",
    "path": "example/goose"
  },
  "marketplace": {
    "skillUrlTemplate": "https://marketplace.example.test/skills/{skillId}"
  }
}
```

### Fields

- `appVersion?: string`
  - optional app version tag supplied by bundled defaults
- `marketplace?: { skillUrlTemplate: string }`
  - optional URL template used to open a skill in the distribution's marketplace
  - must use HTTPS, include a host, and contain exactly one `{skillId}` placeholder
  - `{skillId}` may appear in the path or query, but not in the URL authority (userinfo, host, or port)
  - must not include credentials or a fragment
- `kgoose?: { baseUrl?: string, path?: string }`
  - generic default KGoose endpoint used by KGoose-backed features until runtime config owns this source
  - `baseUrl` must use `http` or `https`
  - environment variables `KGOOSE_BASE_URL` and `KGOOSE_SERVICE_PATH` override these values for local testing

## Runtime effects

When bundled defaults are present, the Tauri shell:

- prepends `distro/bin` to `PATH` when present
- adds `distro/config.yaml` to `GOOSE_ADDITIONAL_CONFIG_FILES` when present
- sets `GOOSE_DISTRO_DIR` to the resolved distro root
- uses `kgoose` as the generic default endpoint for KGoose-backed features
- installs Berd-owned `distro/skills/<name>/` entries into the platform app-data `skills/<name>/` directory; Personal skills remain in `~/.agents/skills`
- installs `distro/agents/<name>.md` entries into `~/.agents/agents/<name>.md`
- warms installed bundled agent `app-avatar:` media when network access is available

Bundled skills reinstall existing copies only when the installed `SKILL.md` frontmatter has the `metadata.berdBundled: true` marker. For existing installs, the app still recognizes the legacy `metadata.gooseInternalBundled: true` marker. After the new Berd-owned copy is verified, marker-owned legacy copies under `~/.agents/skills` move to the platform app-data `recovery/skills-migration-v1` directory; existing recovery data and all unmarked Personal skills are left untouched.

Bundled agents use the `metadata.berdBundled: true` marker. The app records seeded files in `.berd-bundled-agents.json` so deleted starter agents do not reappear on later launches, and migrates the legacy `.goose-internal-bundled-agents.json` marker when present. Existing unmarked user agents are left untouched. This starter set is guaranteed for clean installs; this release does not retrofit filename collisions or customized bundled files on existing installations.

## Scope guidance

Use bundled app defaults for generic packaged-app resources and shell-level startup defaults only.

Good fits:

- bundled skills
- bundled agents
- app-local Goose `config.yaml`
- bundled `bin/`
- temporary generic app defaults that cannot yet move to runtime config

Do not use bundled app defaults for customer/org/workspace policy, customer-specific package identities, provider allowlists, feedback policy, doctor policy, runtime feature toggles, normal app state, user preferences, ACP-backed data, or per-user experiments. Customer/org/workspace behavior should come from auth and runtime/server config.
