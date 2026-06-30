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
DISABLE_BB_CLI="$(meta disable_bb_cli 2>/dev/null || echo false)"

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

# Cargo feature list + extra VITE_* env overrides applied to the build below.
# Official keeps exactly today's invocation (features = berdctl, no extra
# VITE_*); custom appends disable-features and VITE_* derived from the merged
# config in the build-kind block after `just setup`.
CARGO_FEATURES="berdctl"
VITE_OVERRIDES=()

RUNTIME_CONFIG="src-tauri/resources/runtime-config.json"

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
    VITE_OVERRIDES+=("VITE_VOICE_DICTATION=0")
  fi
  if [[ "$(jq -r '.featureToggles.telemetry == false' "$RUNTIME_CONFIG")" == "true" ]]; then
    VITE_OVERRIDES+=("VITE_TELEMETRY=0")
  fi
  # kgoose-backed "Company-managed" connections tab. Purely a renderer gate:
  # flipping the VITE_* build feature hides the tab and skips the kgoose query.
  # The Rust `list_connections` command stays registered (no backend feature) —
  # a gated renderer just never calls it.
  if [[ "$(jq -r '.featureToggles.kgooseConnections == false' "$RUNTIME_CONFIG")" == "true" ]]; then
    VITE_OVERRIDES+=("VITE_KGOOSE_CONNECTIONS=0")
  fi
fi

# bb CLI PATH install has no runtime-config representation; the custom pipeline
# exposes a dedicated select that disables it via the Cargo feature.
if [[ "$BUILD_KIND" == "custom" && "$DISABLE_BB_CLI" == "true" ]]; then
  CARGO_FEATURES="$CARGO_FEATURES,no-bb-cli-install"
fi

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
# Pass the build-time env via `env`, not as shell assignment-prefix words.
# VITE_OVERRIDES (custom only) is expanded from an array, and bash classifies
# `VITE_*=…` assignment prefixes at parse time — it never re-classifies words
# produced by a later expansion, so the array's first element would be taken as
# the command name and fail (`VITE_VOICE_DICTATION=0: command not found`),
# before `pnpm tauri build` ever runs. `env` applies every name=value argument
# at runtime, so both the literal and expanded assignments take effect. The
# guarded expansion contributes nothing for official builds (empty array under
# `set -u`), so the official invocation stays exactly features=berdctl with no
# extra VITE_* vars.
env \
  VITE_APP_VERSION="$RELEASE_VERSION" \
  VITE_ENVIRONMENT=production \
  VITE_AUTH_GATE=0 \
  VITE_UPDATER_ENABLED="$UPDATER_ENABLED" \
  ${VITE_OVERRIDES[@]+"${VITE_OVERRIDES[@]}"} \
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
