#!/usr/bin/env bash
# Build the Berd macOS Tauri bundle for release. Leaves an unsigned
# .app at release/macos/ for the caller's signing and packaging flow.
#
# Inputs (uppercase environment variables supplied by the CI adapter):
#   - version:        semver for the release (e.g. 0.2.0)
#   - build_kind:     "official" (default) or "custom"; the custom pipeline
#                     sets BUILD_KIND=custom on the generated build step
#   - custom_name:    lowercase slug, required when build_kind=custom; suffixes
#                     the stamped version as <version>-<custom_name>
#   - custom_config:  JSON overrides blob deep-merged onto the committed
#                     src-tauri/resources/runtime-config.json for custom builds
#                     (default "{}"); validated before building
#   - custom_vite_env: JSON object of VITE_* build env overrides plus
#                     CUSTOM_BUNDLED_AGENTS and DISABLE_BLOCK_DOCTOR_CHECKS
#                     for custom builds (default
#                     "{}"); VITE_APP_VERSION and
#                     VITE_ENVIRONMENT are owned by the release script
#   - databricks_host: optional distribution-owned HTTPS origin injected into
#                     the databricks_v2 provider's endpointEnv
#   - fast_model_id:  optional distribution-owned served endpoint id injected as
#                     the databricks_v2 provider's fastModelId, which the app
#                     exports to `goose serve` as GOOSE_FAST_MODEL. Named
#                     fast_model_id, NOT goose_fast_model: the input must not
#                     collide with the runtime env name, or an ambient
#                     GOOSE_FAST_MODEL on the build agent would silently become
#                     the bundled value
#   - beta_linear_label_id: Linear label UUID for Beta reports; required when
#                     the bundled release catalog contains a beta channel
#   - disable_bb_cli: "true" to drop the bb CLI PATH install (adds the Cargo
#                     no-bb-cli-install feature); default "false"
#   - BERD_RELEASE_CHANNEL: public | internal | disabled (required legacy profile)
#   - BERD_UPDATER_PUBLIC_KEY / BERD_UPDATER_ENDPOINT: enabled legacy trust pair
#   - BERD_RELEASE_CHANNELS_FILE: optional reviewed Main/Beta catalog; when set,
#                     it replaces the legacy endpoint/key pair and keeps all
#                     trust roots build-bundled
#   - BERD_RELEASE_CHANNEL_ID: current binary channel ID inside that catalog
#
# Official builds enable BYO-key providers, add no release-only agents or
# version suffix, and ship the committed runtime-config.json as-is.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$REPO_ROOT"
activate_hermit

# resolve_release_version (lib.sh) validates the version, applies the custom
# build name suffix, and validates custom_name; official builds use VERSION
# unchanged.
RELEASE_VERSION="$(resolve_release_version)"

# Remaining build-kind inputs are explicit environment values supplied by the
# caller. Optional values retain the existing defaults.
BUILD_KIND="$(release_build_kind)"
CUSTOM_CONFIG="$(release_input custom_config 2>/dev/null || true)"
[[ -n "$CUSTOM_CONFIG" ]] || CUSTOM_CONFIG="{}"
CUSTOM_BUILD_ENV="$(release_input custom_vite_env 2>/dev/null || true)"
[[ -n "$CUSTOM_BUILD_ENV" ]] || CUSTOM_BUILD_ENV="{}"
CUSTOM_BUNDLED_AGENTS_VALUE="${CUSTOM_BUNDLED_AGENTS:-$(default_bundled_agents "$BUILD_KIND")}"
DISABLE_BB_CLI="$(release_input disable_bb_cli 2>/dev/null || echo false)"
DATABRICKS_HOST_VALUE="$(release_input databricks_host 2>/dev/null || true)"
FAST_MODEL_ID_VALUE="$(release_input fast_model_id 2>/dev/null || true)"
BETA_LINEAR_LABEL_ID_VALUE="$(release_input beta_linear_label_id 2>/dev/null || true)"
if [[ -n "${BERD_RELEASE_CHANNELS_FILE:-}" ]] && jq -e '.channels[] | select(.id == "beta")' "$BERD_RELEASE_CHANNELS_FILE" >/dev/null; then
  [[ "$BETA_LINEAR_LABEL_ID_VALUE" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || {
    echo "beta_linear_label_id must be a Linear label UUID when the release catalog contains Beta" >&2
    exit 1
  }
fi

# Build kind controls product customization; updater channel is an independent,
# explicit trust contract. Distribution orchestration selects `internal`, the
# public GitHub workflow selects `public`, and custom/local builds select
# `disabled`. Never infer an enabled channel from the CI system or silently fall
# back between public and internal keys/endpoints.
BERD_RELEASE_CHANNEL="$(trim_whitespace "${BERD_RELEASE_CHANNEL:-}")"
validate_release_channel "$BERD_RELEASE_CHANNEL" || exit 1
if [[ "$BERD_RELEASE_CHANNEL" == "disabled" ]]; then
  UPDATER_ENABLED=false
else
  UPDATER_ENABLED=true
fi
if [[ "$BUILD_KIND" == "custom" && "$BERD_RELEASE_CHANNEL" != "disabled" ]]; then
  echo "custom builds require BERD_RELEASE_CHANNEL=disabled" >&2
  exit 1
fi
export BERD_RELEASE_CHANNEL

# Cargo feature list + VITE_* env applied to the build below. Keep official
# build defaults encoded here; custom_vite_env may override only non-release-
# owned keys via set_vite_env, without emitting duplicate env assignments.
CARGO_FEATURES="berdctl"
VITE_APP_VERSION_VALUE="$RELEASE_VERSION"
VITE_ENVIRONMENT_VALUE="production"
VITE_AUTH_GATE_VALUE="${VITE_AUTH_GATE:-0}"
VITE_AGENT_TOOLS_VALUE="${VITE_AGENT_TOOLS:-0}"
VITE_AUTOMATIONS_VALUE="${VITE_AUTOMATIONS:-0}"
VITE_BUILDERBOT_VALUE="${VITE_BUILDERBOT:-0}"
VITE_FEEDBACK_VALUE="${VITE_FEEDBACK:-0}"
VITE_MANAGED_CONNECTIONS_VALUE="${VITE_MANAGED_CONNECTIONS:-0}"
VITE_SKILL_DISCOVERY_VALUE="${VITE_SKILL_DISCOVERY:-0}"
# Managed internal distributions force telemetry consent ON and hide the
# settings toggle; public builds leave consent to the user (default OFF).
VITE_TELEMETRY_ENFORCED_VALUE="${VITE_TELEMETRY_ENFORCED:-0}"
VITE_VOICE_DICTATION_VALUE="${VITE_VOICE_DICTATION:-0}"
VITE_BYO_KEY_PROVIDERS_VALUE="${VITE_BYO_KEY_PROVIDERS:-1}"
# Public builds have no external security classifier. Internal distributions may
# opt in by supplying their implementation and setting VITE_SECURITY_ML=1.
VITE_SECURITY_ML_VALUE="${VITE_SECURITY_ML:-0}"
VITE_UPDATER_ENABLED_VALUE="$UPDATER_ENABLED"
VITE_BETA_LINEAR_LABEL_ID_VALUE="$BETA_LINEAR_LABEL_ID_VALUE"
VITE_EXTRA_ENV=()

RUNTIME_CONFIG="src-tauri/resources/runtime-config.json"

set_vite_env() {
  local key="$1"
  local value="$2"

  case "$key" in
    VITE_APP_VERSION|VITE_ENVIRONMENT|VITE_UPDATER_ENABLED|VITE_BETA_LINEAR_LABEL_ID)
      echo "custom_vite_env cannot override release-owned key: $key" >&2
      return 1
      ;;
    VITE_AUTH_GATE)
      VITE_AUTH_GATE_VALUE="$value"
      ;;
    VITE_AGENT_TOOLS)
      VITE_AGENT_TOOLS_VALUE="$value"
      ;;
    VITE_AUTOMATIONS)
      VITE_AUTOMATIONS_VALUE="$value"
      ;;
    VITE_BUILDERBOT)
      VITE_BUILDERBOT_VALUE="$value"
      ;;
    VITE_FEEDBACK)
      VITE_FEEDBACK_VALUE="$value"
      ;;
    VITE_MANAGED_CONNECTIONS)
      VITE_MANAGED_CONNECTIONS_VALUE="$value"
      ;;
    VITE_SKILL_DISCOVERY)
      VITE_SKILL_DISCOVERY_VALUE="$value"
      ;;
    VITE_TELEMETRY_ENFORCED)
      VITE_TELEMETRY_ENFORCED_VALUE="$value"
      ;;
    VITE_VOICE_DICTATION)
      VITE_VOICE_DICTATION_VALUE="$value"
      ;;
    VITE_BYO_KEY_PROVIDERS)
      VITE_BYO_KEY_PROVIDERS_VALUE="$value"
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
  if [[ ${#STAGED_CUSTOM_AGENTS[@]} -gt 0 ]]; then
    for file in "${STAGED_CUSTOM_AGENTS[@]}"; do
      if [[ -f "$file" ]]; then
        rm -f "$file"
      fi
    done
  fi
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
GOOSE_BUILD_PROFILE=release just setup

# A release distribution may supply its Databricks workspace and its fast model
# as narrow, validated inputs. Public builds leave both unset and ship the
# committed config unchanged — an editable provider host and no fast model, so
# Goose reuses the main model for its lightweight tasks; internal orchestration
# owns the Block values. The injector validates each value and re-parses the
# config, so one --strict-toggles pass afterwards covers both.
if [[ -n "$DATABRICKS_HOST_VALUE" || -n "$FAST_MODEL_ID_VALUE" ]]; then
  echo "+++ :wrench: Injecting distribution provider values"
  DISTRIBUTION_ARGS=()
  if [[ -n "$DATABRICKS_HOST_VALUE" ]]; then
    DISTRIBUTION_ARGS+=("--databricks-host=$DATABRICKS_HOST_VALUE")
  fi
  if [[ -n "$FAST_MODEL_ID_VALUE" ]]; then
    DISTRIBUTION_ARGS+=("--fast-model-id=$FAST_MODEL_ID_VALUE")
  fi
  pnpm exec tsx scripts/set-runtime-config-distribution.ts \
    "${DISTRIBUTION_ARGS[@]}" "$RUNTIME_CONFIG"
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

  # Preserve non-Block custom-build policies independently of the Block-service
  # positive opt-ins below. An explicit telemetry disable must take effect at
  # renderer build time, before runtime config is available.
  if [[ "$(jq -r '.featureToggles.telemetry == false' "$RUNTIME_CONFIG")" == "true" ]]; then
    set_vite_env VITE_TELEMETRY 0
  fi

  printf '%s' "$CUSTOM_BUILD_ENV" | jq -e '
    type == "object" and
    all(keys[];
      . == "CUSTOM_BUNDLED_AGENTS" or
      . == "DISABLE_BLOCK_DOCTOR_CHECKS" or
      test("^VITE_[A-Z0-9_]+$")
    ) and
    all(.[]; type == "string")
  ' >/dev/null || {
    echo "custom_vite_env must be a JSON object with string VITE_* keys/values, CUSTOM_BUNDLED_AGENTS, or DISABLE_BLOCK_DOCTOR_CHECKS: $CUSTOM_BUILD_ENV" >&2; exit 1;
  }

  while IFS=$'\t' read -r key value; do
    case "$key" in
      CUSTOM_BUNDLED_AGENTS)
        CUSTOM_BUNDLED_AGENTS_VALUE="$value"
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
    echo "+++ :wrench: Removing bundled distribution provider values for BYO key providers"
    # Strip every distribution-owned provider policy, not just the host: a
    # BYO-key build must use the user's own models and fast-task routing. This is
    # the release-time twin of clear_default_databricks_distribution_config in
    # Rust, which is cfg(debug_assertions) and therefore covers BYO dev only.
    tmp="$(mktemp)"
    jq '
      .goose.modelProviders |= map(
        if .id == "databricks_v2" then
          del(.fastModelId, .allowedModelIdPrefixes)
          | .endpointEnv |= del(.DATABRICKS_HOST)
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


# Resolve the paired renderer/native build gates into matching renderer
# and backend/package gates. Values are positive opt-ins: absent is
# public-off and no runtime config can revive a build-disabled family.
for value in "$VITE_AGENT_TOOLS_VALUE" "$VITE_AUTOMATIONS_VALUE" "$VITE_BUILDERBOT_VALUE" "$VITE_FEEDBACK_VALUE" "$VITE_MANAGED_CONNECTIONS_VALUE" "$VITE_SKILL_DISCOVERY_VALUE" "$VITE_TELEMETRY_ENFORCED_VALUE" "$VITE_VOICE_DICTATION_VALUE"; do
  [[ "$value" == "0" || "$value" == "1" ]] || { echo "Block-service feature gates must be 0 or 1" >&2; exit 1; }
done
[[ "$VITE_AGENT_TOOLS_VALUE" == "1" ]] && CARGO_FEATURES="$CARGO_FEATURES,block-agent-tools"
[[ "$VITE_AUTOMATIONS_VALUE" == "1" ]] && CARGO_FEATURES="$CARGO_FEATURES,block-automations"
[[ "$VITE_BUILDERBOT_VALUE" == "1" ]] && CARGO_FEATURES="$CARGO_FEATURES,block-builderbot"
[[ "$VITE_FEEDBACK_VALUE" == "1" ]] && CARGO_FEATURES="$CARGO_FEATURES,block-feedback"
[[ "$VITE_MANAGED_CONNECTIONS_VALUE" == "1" ]] && CARGO_FEATURES="$CARGO_FEATURES,block-managed-connections"
[[ "$VITE_SKILL_DISCOVERY_VALUE" == "1" ]] && CARGO_FEATURES="$CARGO_FEATURES,block-skill-discovery"
# The renderer flag and the Cargo feature must move together: the flag skips
# the user setting in Gate A and hides the toggle, the feature does the same
# for the native Gate B in export_otel_logs.
[[ "$VITE_TELEMETRY_ENFORCED_VALUE" == "1" ]] && CARGO_FEATURES="$CARGO_FEATURES,block-telemetry-enforced"
if [[ "$VITE_VOICE_DICTATION_VALUE" == "1" ]]; then
  CARGO_FEATURES="$CARGO_FEATURES,block-voice-dictation"
else
  CARGO_FEATURES="$CARGO_FEATURES,no-voice-dictation"
fi

# bb CLI PATH install has no runtime-config representation; the custom pipeline
# exposes a dedicated select that disables it via the Cargo feature.
if [[ "$BUILD_KIND" == "custom" && "$DISABLE_BB_CLI" == "true" ]]; then
  CARGO_FEATURES="$CARGO_FEATURES,no-bb-cli-install"
fi

# Stage explicitly selected release-only agents into distro/agents/ for the
# Tauri resource bundle. Berdy is already present in that directory.
stage_custom_bundled_agents

# Generate the channel-specific release overlay. The generator validates the
# endpoint/key pair together and emits no updater config for disabled builds.
echo "+++ :key: Generating tauri.release.conf.json"
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
GOOSE_BUILD_PROFILE=release ./scripts/prepare-goose-sidecar.sh
# ACP bridges are installed into the managed Node runtime on demand; they are
# no longer staged as build resources.
VITE_FEEDBACK="$VITE_FEEDBACK_VALUE" ./scripts/prepare-berdctl-sidecar.sh "$TARGET_TRIPLE"
if [[ "$VITE_AGENT_TOOLS_VALUE" == "1" ]]; then
  ./scripts/prepare-bb-cli-resource.sh "$TARGET_TRIPLE"
  tmp="$(mktemp)"
  jq '.bundle.resources["../resources/bb"] = "bb"' src-tauri/tauri.release.conf.json > "$tmp" \
    && mv "$tmp" src-tauri/tauri.release.conf.json
fi
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
  VITE_AGENT_TOOLS="$VITE_AGENT_TOOLS_VALUE" \
  VITE_AUTOMATIONS="$VITE_AUTOMATIONS_VALUE" \
  VITE_BUILDERBOT="$VITE_BUILDERBOT_VALUE" \
  VITE_FEEDBACK="$VITE_FEEDBACK_VALUE" \
  VITE_MANAGED_CONNECTIONS="$VITE_MANAGED_CONNECTIONS_VALUE" \
  VITE_SKILL_DISCOVERY="$VITE_SKILL_DISCOVERY_VALUE" \
  VITE_TELEMETRY_ENFORCED="$VITE_TELEMETRY_ENFORCED_VALUE" \
  VITE_VOICE_DICTATION="$VITE_VOICE_DICTATION_VALUE" \
  VITE_BYO_KEY_PROVIDERS="$VITE_BYO_KEY_PROVIDERS_VALUE" \
  VITE_SECURITY_ML="$VITE_SECURITY_ML_VALUE" \
  VITE_UPDATER_ENABLED="$VITE_UPDATER_ENABLED_VALUE" \
  VITE_BETA_LINEAR_LABEL_ID="$VITE_BETA_LINEAR_LABEL_ID_VALUE" \
  ${VITE_EXTRA_ENV[@]+"${VITE_EXTRA_ENV[@]}"} \
  pnpm tauri build --no-sign --target "$TARGET_TRIPLE" --features "$CARGO_FEATURES" \
    --config src-tauri/tauri.release.conf.json

TAURI_TARGET_DIR="$(
  cd src-tauri
  cargo metadata --no-deps --format-version 1 | jq -er '.target_directory | select(length > 0)'
)"
UNSIGNED_APP="$TAURI_TARGET_DIR/${TARGET_TRIPLE}/release/bundle/macos/${APP_BUNDLE_NAME}.app"
[[ -d "$UNSIGNED_APP" ]] || { echo "Missing $UNSIGNED_APP" >&2; exit 1; }

echo "+++ :package: Staging unsigned .app for apple-codesign"
mkdir -p release/macos
echo "+++ :key: Staging macOS entitlements"
cp src-tauri/entitlements.plist release/macos/entitlements.plist
rm -rf "release/macos/${APP_BUNDLE_NAME}.app"
# ditto preserves bundle metadata and extended attributes cp would drop.
ditto "$UNSIGNED_APP" "release/macos/${APP_BUNDLE_NAME}.app"

ls -lh release/macos
