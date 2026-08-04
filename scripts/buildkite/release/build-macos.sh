#!/usr/bin/env bash
# Build the Berd macOS Tauri bundle for release. Leaves an unsigned
# .app at release/macos/ for the squareup/apple-codesign plugin to sign,
# notarize, staple, and package in its post-command hook.
#
# Inputs (Buildkite meta-data, or uppercase env var override for local runs):
#   - version:        semver for the release (e.g. 0.2.0)
#   - build_kind:     "official" (default) or "custom"; the custom pipeline
#                     sets BUILD_KIND=custom on the generated build step
#   - custom_name:    lowercase slug, required when build_kind=custom; suffixes
#                     the stamped version as <version>-<custom_name>
#   - custom_config:  JSON overrides blob deep-merged onto the committed
#                     src-tauri/resources/runtime-config.json for custom builds
#                     (default "{}"); validated before building
#   - custom_vite_env: JSON object of VITE_* build env overrides plus
#                     CUSTOM_BUNDLED_AGENTS, DISABLE_BLOCK_NPM_REGISTRY, and
#                     DISABLE_BLOCK_DOCTOR_CHECKS for custom builds (default
#                     "{}"); VITE_APP_VERSION and
#                     VITE_ENVIRONMENT are owned by the release script
#   - databricks_host: optional distribution-owned HTTPS origin injected into
#                     the databricks_v2 provider's endpointEnv
#   - disable_bb_cli: "true" to drop the bb CLI PATH install (adds the Cargo
#                     no-bb-cli-install feature); default "false"
#
# An official build — the default, with all of the above unset — is byte-for-
# byte the build this script ran before custom builds existed: features =
# berdctl, no extra VITE_* overrides, no version suffix, and the committed
# runtime-config.json shipped as-is.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/buildkite/release/lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$REPO_ROOT"
activate_hermit

# resolve_release_version (lib.sh) validates the version, applies the custom
# build name suffix, and validates custom_name; official builds get `meta
# version` unchanged.
RELEASE_VERSION="$(resolve_release_version)"

# Remaining build-kind inputs. meta() falls back to the uppercased env var for
# local runs (BUILD_KIND / CUSTOM_CONFIG / DISABLE_BB_CLI).
BUILD_KIND="$(release_build_kind)"
CUSTOM_CONFIG="$(meta custom_config 2>/dev/null || true)"
[[ -n "$CUSTOM_CONFIG" ]] || CUSTOM_CONFIG="{}"
CUSTOM_BUILD_ENV="$(meta custom_vite_env 2>/dev/null || true)"
[[ -n "$CUSTOM_BUILD_ENV" ]] || CUSTOM_BUILD_ENV="{}"
CUSTOM_BUNDLED_AGENTS_VALUE="${CUSTOM_BUNDLED_AGENTS:-$(default_bundled_agents "$BUILD_KIND")}"
DISABLE_BB_CLI="$(meta disable_bb_cli 2>/dev/null || echo false)"
# Buildkite meta-data is the public pipeline input. Distribution orchestrators
# may instead pass the same narrow value directly in the environment.
DATABRICKS_HOST_VALUE="${DATABRICKS_HOST:-$(meta databricks_host 2>/dev/null || true)}"

# In-app updates are an official-build-only feature. A custom build that embeds
# the official updater pubkey/endpoint would poll the official feed and, because
# a custom version sorts below official in semver (X.Y.Z-<name> < X.Y.Z),
# silently download-and-install the official release over itself — undoing every
# custom feature gate. So disable the updater for all custom builds, at both
# layers: VITE_UPDATER_ENABLED gates the renderer (no startup/6h poll, the
# Settings "Check for Updates" control disabled), and GOOSE2_UPDATER_DISABLED
# tells the release-config generator to omit plugins.updater so lib.rs never
# registers the plugin and the binary carries no key/endpoint at all. The
# trigger is BUILD_KIND alone — there is no scenario where a custom build should
# consume the official feed, so this needs no separate input or toggle.
if [[ "$BUILD_KIND" == "custom" ]]; then
  UPDATER_ENABLED=false
  export GOOSE2_UPDATER_DISABLED=1
else
  UPDATER_ENABLED=true
fi

# Cargo feature list + VITE_* env applied to the build below. Keep official
# build defaults encoded here; custom_vite_env may override only non-release-
# owned keys via set_vite_env, without emitting duplicate env assignments.
CARGO_FEATURES="berdctl"
VITE_APP_VERSION_VALUE="$RELEASE_VERSION"
VITE_ENVIRONMENT_VALUE="production"
VITE_AUTH_GATE_VALUE=0
VITE_BYO_KEY_PROVIDERS_VALUE=0
VITE_SECURITY_ML_VALUE=1
VITE_UPDATER_ENABLED_VALUE="$UPDATER_ENABLED"
VITE_EXTRA_ENV=()

RUNTIME_CONFIG="src-tauri/resources/runtime-config.json"

set_vite_env() {
  local key="$1"
  local value="$2"

  case "$key" in
    VITE_APP_VERSION|VITE_ENVIRONMENT)
      echo "custom_vite_env cannot override release-owned key: $key" >&2
      return 1
      ;;
    VITE_AUTH_GATE)
      VITE_AUTH_GATE_VALUE="$value"
      ;;
    VITE_BYO_KEY_PROVIDERS)
      VITE_BYO_KEY_PROVIDERS_VALUE="$value"
      ;;
    VITE_UPDATER_ENABLED)
      VITE_UPDATER_ENABLED_VALUE="$value"
      ;;
    VITE_SECURITY_ML)
      VITE_SECURITY_ML_VALUE="$value"
      ;;
    VITE_*)
      local next=()
      local pair
      if [[ ${#VITE_EXTRA_ENV[@]} -gt 0 ]]; then
        for pair in "${VITE_EXTRA_ENV[@]}"; do
          [[ "$pair" == "$key="* ]] || next+=("$pair")
        done
      fi
      next+=("$key=$value")
      VITE_EXTRA_ENV=("${next[@]}")
      ;;
    *)
      echo "custom_vite_env key must start with VITE_: $key" >&2
      return 1
      ;;
  esac
}

# Copy selected agents from release-agents/ into distro/agents/ so Tauri bundles
# them. The list is a comma-separated set of basenames without the .md
# extension. Each file is validated before being copied.
stage_custom_bundled_agents() {
  local raw
  raw="$(trim_whitespace "$CUSTOM_BUNDLED_AGENTS_VALUE")"

  if [[ -z "$raw" ]]; then
    return 0
  fi

  local src_dir="$REPO_ROOT/release-agents"
  local dest_dir="$REPO_ROOT/distro/agents"

  if [[ ! -d "$src_dir" ]]; then
    echo "custom agents source directory missing: $src_dir" >&2
    return 1
  fi

  mkdir -p "$dest_dir"

  local name
  local -a files=()
  while IFS= read -r name; do
    name="$(trim_whitespace "$name")"
    [[ -n "$name" ]] || continue

    if [[ "$name" == *"/"* ]]; then
      echo "custom_bundled_agents entries must be basenames, not paths: $name" >&2
      return 1
    fi

    if [[ ! "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
      echo "custom_bundled_agents entries must be lowercase slugs ([a-z0-9][a-z0-9-]*): $name" >&2
      return 1
    fi

    local source_file="$src_dir/${name}.md"
    if [[ ! -f "$source_file" ]]; then
      echo "custom bundled agent not found: $source_file" >&2
      return 1
    fi

    if [[ -f "$dest_dir/${name}.md" ]]; then
      echo "custom bundled agent name collides with an existing agent: ${name}.md" >&2
      return 1
    fi

    files+=("$source_file")
  done < <(tr ',' '\n' <<<"$raw")

  if [[ ${#files[@]} -eq 0 ]]; then
    return 0
  fi

  echo "+++ :robot: Staging custom bundled agents: $raw"
  pnpm exec tsx scripts/validate-bundled-agents.ts "${files[@]}"

  local file
  for file in "${files[@]}"; do
    cp "$file" "$dest_dir/"
    STAGED_CUSTOM_AGENTS+=("$dest_dir/$(basename "$file")")
  done
}

# Remove any agent files we staged in distro/agents/ so a later local run
# against the same working tree doesn't accidentally include them.
cleanup_custom_bundled_agents() {
  local file
  for file in "${STAGED_CUSTOM_AGENTS[@]}"; do
    if [[ -f "$file" ]]; then
      rm -f "$file"
    fi
  done
}

typeset -a STAGED_CUSTOM_AGENTS=()
trap cleanup_custom_bundled_agents EXIT INT TERM

echo "+++ :package: Stamping version -> $RELEASE_VERSION"
tmp="$(mktemp)"
jq --arg v "$RELEASE_VERSION" '.version = $v' package.json > "$tmp" && mv "$tmp" package.json
jq --arg v "$RELEASE_VERSION" '.version = $v' src-tauri/tauri.conf.json > "$tmp" && mv "$tmp" src-tauri/tauri.conf.json
# Only rewrite the version line inside [package]. Dependency versions live in
# [dependencies] / [dev-dependencies] and must stay untouched.
awk -v v="$RELEASE_VERSION" '
  /^\[package\]/ { in_pkg = 1; print; next }
  /^\[/          { in_pkg = 0; print; next }
  in_pkg && /^version[[:space:]]*=/ { print "version = \"" v "\""; next }
                 { print }
' src-tauri/Cargo.toml > "$tmp" && mv "$tmp" src-tauri/Cargo.toml

# just setup: pnpm install, build @aaif/goose-sdk, build the pinned goose
# backend binary via scripts/ensure-local-goose.sh.
echo "+++ :hammer: just setup"
just setup

# A release distribution may supply its Databricks workspace as a narrow,
# validated input. Public builds leave it unset and retain an editable provider
# host; internal orchestration owns the Block value.
if [[ -n "$DATABRICKS_HOST_VALUE" ]]; then
  echo "+++ :wrench: Injecting distribution Databricks host"
  pnpm exec tsx scripts/set-runtime-config-databricks-host.ts \
    "$RUNTIME_CONFIG" "$DATABRICKS_HOST_VALUE"
  pnpm exec tsx scripts/validate-runtime-config.ts --strict-toggles "$RUNTIME_CONFIG"
fi

# Custom builds: deep-merge the operator's one-off overrides onto the committed
# base runtime-config.json, validate the result, write it transiently over the
# bundled resource (nothing is committed — the same transient working-tree
# mutation as the version stamp above), and derive build-time reinforcement
# from the merged toggles. The runtime-config layer alone can't kill the
# telemetry launch event (it fires before runtime config loads) or the realtime
# client secret request, so a disabled voiceDictation/telemetry toggle also
# flips the matching VITE_* / Cargo lever. Runs after `just setup` so tsx (the
# validator) is installed. An empty "{}" blob leaves the base config unchanged.
if [[ "$BUILD_KIND" == "custom" ]]; then
  echo "+++ :wrench: Applying custom build config"

  printf '%s' "$CUSTOM_CONFIG" | jq empty 2>/dev/null || {
    echo "custom_config is not valid JSON: $CUSTOM_CONFIG" >&2; exit 1;
  }

  overrides="$(mktemp)"
  merged="$(mktemp)"
  printf '%s' "$CUSTOM_CONFIG" > "$overrides"
  # Keep custom builds to feature-level policy. Provider/model/endpoint identity
  # stays committed-owned; otherwise a signed custom build could replace the
  # default provider while still passing schema validation.
  validate_custom_config_override "$overrides"

  # Base first, overrides second. The override shape above limits this merge to
  # feature/runtime sections (`featureToggles`, `doctor`, `feedback`), so the
  # committed provider config stays the source of truth.
  jq -s '.[0] * .[1]' "$RUNTIME_CONFIG" "$overrides" > "$merged" || {
    echo "failed to merge custom_config onto $RUNTIME_CONFIG" >&2; exit 1;
  }

  # Validate against the shared runtimeConfigSchema (mirrors the Rust
  # deny_unknown_fields struct) so a typo'd/unknown key hard-fails here rather
  # than mid-build. `--strict-toggles` additionally rejects an unrecognized
  # featureToggles KEY: featureToggles is a free-form record, so a misspelled
  # toggle (e.g. `voiceDictaton`) would otherwise validate, then no-op at
  # runtime (capability defaults ON) and silently ship an unrestricted build —
  # the exact failure this custom path exists to prevent.
  pnpm exec tsx scripts/validate-runtime-config.ts --strict-toggles "$merged" || {
    echo "merged runtime-config failed validation" >&2; exit 1;
  }

  mv "$merged" "$RUNTIME_CONFIG"
  rm -f "$overrides"

  # `== false` matches only an explicitly-disabled toggle; an absent toggle
  # (null) stays enabled. (Do NOT use `// true` here — jq's alternative
  # operator treats an explicit `false` as absent and would mask the disable.)
  if [[ "$(jq -r '.featureToggles.voiceDictation == false' "$RUNTIME_CONFIG")" == "true" ]]; then
    CARGO_FEATURES="$CARGO_FEATURES,no-voice-dictation"
    set_vite_env VITE_VOICE_DICTATION 0
  fi
  if [[ "$(jq -r '.featureToggles.telemetry == false' "$RUNTIME_CONFIG")" == "true" ]]; then
    set_vite_env VITE_TELEMETRY 0
  fi
  # kgoose-backed "Company-managed" connections tab. Purely a renderer gate:
  # flipping the VITE_* build feature hides the tab and skips the kgoose query.
  # The Rust `list_connections` command stays registered (no backend feature) —
  # a gated renderer just never calls it.
  if [[ "$(jq -r '.featureToggles.kgooseConnections == false' "$RUNTIME_CONFIG")" == "true" ]]; then
    set_vite_env VITE_KGOOSE_CONNECTIONS 0
  fi

  printf '%s' "$CUSTOM_BUILD_ENV" | jq -e '
    type == "object" and
    all(keys[];
      . == "CUSTOM_BUNDLED_AGENTS" or
      . == "DISABLE_BLOCK_NPM_REGISTRY" or
      . == "DISABLE_BLOCK_DOCTOR_CHECKS" or
      test("^VITE_[A-Z0-9_]+$")
    ) and
    all(.[]; type == "string")
  ' >/dev/null || {
    echo "custom_vite_env must be a JSON object with string VITE_* keys/values, CUSTOM_BUNDLED_AGENTS, DISABLE_BLOCK_NPM_REGISTRY, or DISABLE_BLOCK_DOCTOR_CHECKS: $CUSTOM_BUILD_ENV" >&2; exit 1;
  }

  while IFS=$'\t' read -r key value; do
    case "$key" in
      CUSTOM_BUNDLED_AGENTS)
        CUSTOM_BUNDLED_AGENTS_VALUE="$value"
        ;;
      DISABLE_BLOCK_NPM_REGISTRY)
        if [[ "$value" == "1" ]]; then
          CARGO_FEATURES="$CARGO_FEATURES,no-block-npm-registry"
        elif [[ "$value" != "0" ]]; then
          echo "DISABLE_BLOCK_NPM_REGISTRY must be \"0\" or \"1\"" >&2
          exit 1
        fi
        ;;
      DISABLE_BLOCK_DOCTOR_CHECKS)
        if [[ "$value" == "1" ]]; then
          CARGO_FEATURES="$CARGO_FEATURES,no-block-doctor-checks"
        elif [[ "$value" != "0" ]]; then
          echo "DISABLE_BLOCK_DOCTOR_CHECKS must be \"0\" or \"1\"" >&2
          exit 1
        fi
        ;;
      *)
        set_vite_env "$key" "$value"
        ;;
    esac
  done < <(printf '%s' "$CUSTOM_BUILD_ENV" | jq -r 'to_entries[] | [.key, .value] | @tsv')

  if [[ "$VITE_BYO_KEY_PROVIDERS_VALUE" == "1" ]]; then
    echo "+++ :wrench: Removing bundled Databricks host for BYO key providers"
    tmp="$(mktemp)"
    jq '
      .goose.modelProviders |= map(
        if .id == "databricks_v2" then
          .endpointEnv |= del(.DATABRICKS_HOST)
          | if (.endpointEnv | length) == 0 then del(.endpointEnv) else . end
        else
          .
        end
      )
    ' "$RUNTIME_CONFIG" > "$tmp" && mv "$tmp" "$RUNTIME_CONFIG"
    pnpm exec tsx scripts/validate-runtime-config.ts --strict-toggles "$RUNTIME_CONFIG" || {
      echo "BYO runtime-config failed validation" >&2; exit 1;
    }
  fi
fi

# bb CLI PATH install has no runtime-config representation; the custom pipeline
# exposes a dedicated select that disables it via the Cargo feature.
if [[ "$BUILD_KIND" == "custom" && "$DISABLE_BB_CLI" == "true" ]]; then
  CARGO_FEATURES="$CARGO_FEATURES,no-bb-cli-install"
fi

if [[ "$BUILD_KIND" == "custom" && "$VITE_SECURITY_ML_VALUE" == "0" ]]; then
  CARGO_FEATURES="$CARGO_FEATURES,no-security-ml"
fi

# Stage the selected bundled agents into distro/agents/ for the Tauri resource
# bundle. Official builds use block,builderbot; custom builds default to the
# public-safe builderbot-only selection.
stage_custom_bundled_agents

# Generate release config. For official builds this bakes the updater endpoint
# and public key into the binary; the apple-codesign plugin handles signing, and
# publish-updater.sh creates updater artifacts after notarization. Custom builds
# set GOOSE2_UPDATER_DISABLED above, so the generator writes an empty overlay and
# the key/endpoint secrets aren't needed — only require them for official.
echo "+++ :key: Generating tauri.release.conf.json"
if [[ "$UPDATER_ENABLED" == "true" ]]; then
  : "${GOOSE2_UPDATER_PUBLIC_KEY:?GOOSE2_UPDATER_PUBLIC_KEY is required}"
  : "${GOOSE2_UPDATER_ENDPOINT:?GOOSE2_UPDATER_ENDPOINT is required}"
fi
pnpm run tauri:release:config

echo "+++ :hammer: Patching release config for signing flow"
# Defensive strip: if a future base tauri.conf.json ever pins a signingIdentity,
# Tauri would merge it back in at build time and try to sign against a cert that
# isn't in the agent keychain. The apple-codesign plugin owns signing
# post-build, so we want the build itself unsigned.
# createUpdaterArtifacts is intentionally NOT set by the release config either —
# we re-tar + minisign in the publish-updater step after the plugin has signed
# and stapled the .app.
tmp="$(mktemp)"
jq 'del(.bundle.macOS.signingIdentity)' src-tauri/tauri.conf.json > "$tmp" \
  && mv "$tmp" src-tauri/tauri.conf.json
jq 'del(.bundle.macOS.signingIdentity) | del(.bundle.createUpdaterArtifacts)' \
  src-tauri/tauri.release.conf.json > "$tmp" \
  && mv "$tmp" src-tauri/tauri.release.conf.json

# Stage the goose backend and CLIs as Tauri resources/sidecars, then build for
# an explicit aarch64 target so output paths are stable regardless of agent
# architecture. The berdctl staged name must carry that same triple.
# Production telemetry is an explicit release opt-in; generic builds default to
# development. No TAURI_SIGNING_PRIVATE_KEY needed — signing happens in
# publish-updater.sh.
TARGET_TRIPLE="aarch64-apple-darwin"
echo "+++ :hammer: pnpm tauri build (unsigned)"
./scripts/prepare-goose-sidecar.sh
./scripts/prepare-berdctl-sidecar.sh "$TARGET_TRIPLE"
./scripts/prepare-bb-cli-resource.sh "$TARGET_TRIPLE"
./scripts/prepare-catch-sidecar.sh "$TARGET_TRIPLE"
# Pass the build-time env via `env`, not as shell assignment-prefix words.
# Custom-only extra VITE_* values are expanded from an array, and bash
# classifies `VITE_*=…` assignment prefixes at parse time — it never
# re-classifies words produced by a later expansion, so an array element would
# be taken as the command name and fail (`VITE_VOICE_DICTATION=0: command not
# found`) before `pnpm tauri build` ever runs. `env` applies every name=value
# argument at runtime. The guarded expansion contributes nothing for official
# builds (empty array under `set -u`).
env \
  VITE_APP_VERSION="$VITE_APP_VERSION_VALUE" \
  VITE_ENVIRONMENT="$VITE_ENVIRONMENT_VALUE" \
  VITE_AUTH_GATE="$VITE_AUTH_GATE_VALUE" \
  VITE_BYO_KEY_PROVIDERS="$VITE_BYO_KEY_PROVIDERS_VALUE" \
  VITE_SECURITY_ML="$VITE_SECURITY_ML_VALUE" \
  VITE_UPDATER_ENABLED="$VITE_UPDATER_ENABLED_VALUE" \
  ${VITE_EXTRA_ENV[@]+"${VITE_EXTRA_ENV[@]}"} \
  pnpm tauri build --no-sign --target "$TARGET_TRIPLE" --features "$CARGO_FEATURES" \
    --config src-tauri/tauri.release.conf.json

UNSIGNED_APP="src-tauri/target/${TARGET_TRIPLE}/release/bundle/macos/${APP_BUNDLE_NAME}.app"
[[ -d "$UNSIGNED_APP" ]] || { echo "Missing $UNSIGNED_APP" >&2; exit 1; }

echo "+++ :package: Staging unsigned .app for apple-codesign"
mkdir -p release/macos
echo "+++ :key: Staging macOS entitlements"
cp src-tauri/entitlements.plist release/macos/entitlements.plist
rm -rf "release/macos/${APP_BUNDLE_NAME}.app"
# ditto preserves bundle metadata and extended attributes cp would drop.
ditto "$UNSIGNED_APP" "release/macos/${APP_BUNDLE_NAME}.app"

ls -lh release/macos
