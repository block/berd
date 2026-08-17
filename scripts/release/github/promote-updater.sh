#!/usr/bin/env bash
# Promote complete staged macOS, Windows, and Linux updater payloads atomically.
set -euo pipefail
if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <v-prefixed-tag> <source-sha> <output-summary-path>" >&2
  exit 2
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../lib.sh"
TAG="$1"
SOURCE_SHA="$2"
SUMMARY_PATH="$3"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${BERD_UPDATER_PUBLIC_KEY:?BERD_UPDATER_PUBLIC_KEY is required}"
validate_release_tag "$TAG" || exit 1
validate_source_sha "$SOURCE_SHA" || exit 1
VERSION="${TAG#v}"
load_release_channel "${BERD_RELEASE_CHANNEL_CONFIG:-}"
REPOSITORY="$RELEASE_REPOSITORY"
ROLLING_TAG="$RELEASE_ROLLING_TAG"
if [[ "${GITHUB_REPOSITORY:-$REPOSITORY}" != "$REPOSITORY" ]]; then
  release_error "workflow repository mismatch"
  exit 1
fi

WORK_DIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/berd-promote.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

archive_path() {
  local platform="$1"
  printf '%s/%s' "$WORK_DIR" "$(release_archive_name "$VERSION" "$platform")"
}

archive_url() {
  local platform="$1"
  printf 'https://github.com/%s/releases/download/%s/%s' \
    "$REPOSITORY" \
    "$ROLLING_TAG" \
    "$(release_archive_name "$VERSION" "$platform")"
}

LATEST_MACOS_DMG_NAME="Berd-latest-darwin-aarch64.dmg"
LATEST_MACOS_DMG_PATH="$WORK_DIR/$LATEST_MACOS_DMG_NAME"
LATEST_MACOS_DMG_URL="https://github.com/${REPOSITORY}/releases/download/${ROLLING_TAG}/${LATEST_MACOS_DMG_NAME}"
LATEST_MACOS_DMG_DIGEST=""

staged_digest() {
  local platform="$1"
  awk 'NR == 1 {print $1}' "$(archive_path "$platform").sha256"
}

MANIFEST_ARGS=(
  "$VERSION"
  "Berd v$VERSION. Windows and Linux payloads lack native code signatures; their updater archives are minisign-authenticated."
)
SUMMARY_LINES=()
for PLATFORM in "${RELEASE_PLATFORMS[@]}"; do
  ARCHIVE_NAME="$(release_archive_name "$VERSION" "$PLATFORM")"
  gh release download "$TAG" --repo "$REPOSITORY" --dir "$WORK_DIR" \
    --pattern "$ARCHIVE_NAME" --pattern "$ARCHIVE_NAME.sig" --pattern "$ARCHIVE_NAME.sha256"
  for suffix in "" .sig .sha256; do
    if [[ ! -s "$WORK_DIR/$ARCHIVE_NAME$suffix" ]]; then
      release_error "missing or empty staged input: $ARCHIVE_NAME$suffix"
      exit 1
    fi
  done
  EXPECTED_DIGEST="$(staged_digest "$PLATFORM")"
  ACTUAL_DIGEST="$(shasum -a 256 "$WORK_DIR/$ARCHIVE_NAME" | awk '{print $1}')"
  if [[ ! "$EXPECTED_DIGEST" =~ ^[0-9a-f]{64}$ || "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]]; then
    release_error "staged updater digest mismatch: $PLATFORM"
    exit 1
  fi
  "$REPO_ROOT/scripts/release/verify-updater-signature.sh" "$WORK_DIR/$ARCHIVE_NAME" "$WORK_DIR/$ARCHIVE_NAME.sig" "$BERD_UPDATER_PUBLIC_KEY"
  case "$PLATFORM" in
    darwin-*)
      tar -tzf "$WORK_DIR/$ARCHIVE_NAME" | grep -Fxq 'Berd.app/'
      ;;
    windows-*)
      unzip -Z1 "$WORK_DIR/$ARCHIVE_NAME" \
        | grep -Fxq "$(release_installer_name "$VERSION" "$PLATFORM")"
      ;;
    linux-*)
      [[ "$(tar -tzf "$WORK_DIR/$ARCHIVE_NAME" | wc -l | tr -d ' ')" -eq 1 ]]
      tar -tzf "$WORK_DIR/$ARCHIVE_NAME" \
        | grep -Fxq "$(release_installer_name "$VERSION" "$PLATFORM")"
      ;;
  esac
  ARCHIVE_URL="$(archive_url "$PLATFORM")"
  MANIFEST_ARGS+=("$PLATFORM" "$WORK_DIR/$ARCHIVE_NAME.sig" "$ARCHIVE_URL")
  SUMMARY_LINES+=("- $PLATFORM updater SHA-256: \`$EXPECTED_DIGEST\`" "- $PLATFORM updater URL: $ARCHIVE_URL")
  if [[ "$PLATFORM" == "darwin-aarch64" ]]; then
    VERSIONED_DMG_NAME="Berd_${VERSION}_${PLATFORM}.dmg"
    gh release download "$TAG" --repo "$REPOSITORY" --dir "$WORK_DIR" \
      --pattern "$VERSIONED_DMG_NAME"
    if [[ ! -s "$WORK_DIR/$VERSIONED_DMG_NAME" ]]; then
      release_error "missing or empty staged input: $VERSIONED_DMG_NAME"
      exit 1
    fi
    mv "$WORK_DIR/$VERSIONED_DMG_NAME" "$LATEST_MACOS_DMG_PATH"
    LATEST_MACOS_DMG_DIGEST="$(shasum -a 256 "$LATEST_MACOS_DMG_PATH" | awk '{print $1}')"
    SUMMARY_LINES+=("- macOS installer SHA-256: \`$LATEST_MACOS_DMG_DIGEST\`" "- macOS installer URL: $LATEST_MACOS_DMG_URL")
  fi
done

if [[ -n "${BERD_RELEASE_CHANNEL_ID:-}" ]]; then
  DIGESTS='{}'
  SIGNATURES='{}'
  for PLATFORM in "${RELEASE_PLATFORMS[@]}"; do
    ARCHIVE_NAME="$(release_archive_name "$VERSION" "$PLATFORM")"
    DIGEST="$(staged_digest "$PLATFORM")"
    SIGNATURE="$(
      "$REPO_ROOT/scripts/release/sign-compatibility-descriptor.sh" \
        "$VERSION" \
        "$BERD_RELEASE_CHANNEL_ID" \
        "$DIGEST"
    )"
    DIGESTS="$(
      jq -c \
        --arg platform "$PLATFORM" \
        --arg digest "$DIGEST" \
        '. + {($platform): $digest}' \
        <<< "$DIGESTS"
    )"
    SIGNATURES="$(
      jq -c \
        --arg platform "$PLATFORM" \
        --arg signature "$SIGNATURE" \
        '. + {($platform): $signature}' \
        <<< "$SIGNATURES"
    )"
  done
  export BERD_ARTIFACT_SHA256_BY_PLATFORM="$DIGESTS"
  export BERD_COMPATIBILITY_SIGNATURES_BY_PLATFORM="$SIGNATURES"
fi
"$REPO_ROOT/scripts/release/generate-latest-json.sh" "${MANIFEST_ARGS[@]}" > "$WORK_DIR/latest.json"
[[ "$(jq '.platforms | length' "$WORK_DIR/latest.json")" -eq "${#RELEASE_PLATFORMS[@]}" ]]
MANIFEST_URL="https://github.com/${REPOSITORY}/releases/download/${ROLLING_TAG}/latest.json"
fetch_manifest() {
  local destination="$1"
  local url="$2"
  local phase="$3"
  local http_status
  rm -f "$destination"
  if ! http_status="$(
    curl \
      --silent \
      --show-error \
      --location \
      --retry 2 \
      --retry-all-errors \
      -H 'Cache-Control: no-cache' \
      -o "$destination" \
      --write-out '%{http_code}' \
      "$url"
  )"; then
    echo "failed to fetch updater manifest during $phase" >&2
    return 1
  fi
  case "$http_status" in
    200)
      MANIFEST_FETCH_EXISTS=true
      ;;
    404)
      MANIFEST_FETCH_EXISTS=false
      rm -f "$destination"
      ;;
    *)
      echo "updater manifest fetch returned HTTP $http_status during $phase" >&2
      rm -f "$destination"
      return 1
      ;;
  esac
}
CURRENT_MANIFEST="$WORK_DIR/current-latest.json"
fetch_manifest "$CURRENT_MANIFEST" "${MANIFEST_URL}?run=${GITHUB_RUN_ID:-manual}-preflight" preflight
CURRENT_MANIFEST_EXISTS="$MANIFEST_FETCH_EXISTS"
if [[ "$CURRENT_MANIFEST_EXISTS" == true ]]; then
  node "$REPO_ROOT/scripts/release/validate-manifest-promotion.mjs" "$WORK_DIR/latest.json" "$CURRENT_MANIFEST"
fi

if ! gh release view "$ROLLING_TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
  gh release create "$ROLLING_TAG" --repo "$REPOSITORY" --target "$SOURCE_SHA" --prerelease --latest=false \
    --title "Berd Desktop Auto-Update" --notes "Rolling release for the Tauri auto-updater. Use versioned releases for manual downloads."
fi
UPLOADS=()
for PLATFORM in "${RELEASE_PLATFORMS[@]}"; do
  ARCHIVE_NAME="$(release_archive_name "$VERSION" "$PLATFORM")"
  UPLOADS+=("$WORK_DIR/$ARCHIVE_NAME" "$WORK_DIR/$ARCHIVE_NAME.sig" "$WORK_DIR/$ARCHIVE_NAME.sha256")
done
if [[ -n "$LATEST_MACOS_DMG_DIGEST" ]]; then
  UPLOADS+=("$LATEST_MACOS_DMG_PATH")
fi
gh release upload "$ROLLING_TAG" --repo "$REPOSITORY" --clobber "${UPLOADS[@]}"

# Confirm every updater payload is anonymously available before mutating the feed.
for PLATFORM in "${RELEASE_PLATFORMS[@]}"; do
  ARCHIVE_NAME="$(release_archive_name "$VERSION" "$PLATFORM")"
  EXPECTED_DIGEST="$(staged_digest "$PLATFORM")"
  ARCHIVE_URL="$(archive_url "$PLATFORM")"
  accessible=false
  for attempt in 1 2 3 4 5; do
    if curl \
      --fail \
      --location \
      --retry 2 \
      --retry-all-errors \
      -H 'Cache-Control: no-cache' \
      -o "$WORK_DIR/public-$ARCHIVE_NAME" \
      "${ARCHIVE_URL}?run=${GITHUB_RUN_ID:-manual}-${attempt}" \
      && [[ "$(shasum -a 256 "$WORK_DIR/public-$ARCHIVE_NAME" | awk '{print $1}')" == "$EXPECTED_DIGEST" ]]; then
      accessible=true
      break
    fi
    sleep "${BERD_PROMOTION_RETRY_DELAY_SECONDS:-10}"
  done
  if [[ "$accessible" != true ]]; then
    release_error "rolling archive was not publicly accessible: $ARCHIVE_URL"
    exit 1
  fi
done

if [[ -n "$LATEST_MACOS_DMG_DIGEST" ]]; then
  accessible=false
  for attempt in 1 2 3 4 5; do
    if curl \
      --fail \
      --location \
      --retry 2 \
      --retry-all-errors \
      -H 'Cache-Control: no-cache' \
      -o "$WORK_DIR/public-$LATEST_MACOS_DMG_NAME" \
      "${LATEST_MACOS_DMG_URL}?run=${GITHUB_RUN_ID:-manual}-${attempt}" \
      && [[ "$(shasum -a 256 "$WORK_DIR/public-$LATEST_MACOS_DMG_NAME" | awk '{print $1}')" == "$LATEST_MACOS_DMG_DIGEST" ]]; then
      accessible=true
      break
    fi
    sleep "${BERD_PROMOTION_RETRY_DELAY_SECONDS:-10}"
  done
  if [[ "$accessible" != true ]]; then
    release_error "rolling macOS installer was not publicly accessible: $LATEST_MACOS_DMG_URL"
    exit 1
  fi
fi

RECHECK_MANIFEST="$WORK_DIR/rechecked-latest.json"
fetch_manifest "$RECHECK_MANIFEST" "${MANIFEST_URL}?run=${GITHUB_RUN_ID:-manual}-recheck" recheck
RECHECK_MANIFEST_EXISTS="$MANIFEST_FETCH_EXISTS"
if [[ "$RECHECK_MANIFEST_EXISTS" == true ]]; then
  if [[ "$CURRENT_MANIFEST_EXISTS" != true ]]; then
    release_error "updater manifest appeared during promotion"
    exit 1
  fi
  if ! cmp -s "$CURRENT_MANIFEST" "$RECHECK_MANIFEST"; then
    release_error "updater manifest changed during promotion"
    exit 1
  fi
elif [[ "$CURRENT_MANIFEST_EXISTS" == true ]]; then
  echo "updater manifest disappeared during promotion" >&2
  exit 1
fi
if [[ "$CURRENT_MANIFEST_EXISTS" == true ]]; then
  node "$REPO_ROOT/scripts/release/validate-manifest-promotion.mjs" "$WORK_DIR/latest.json" "$RECHECK_MANIFEST"
fi
gh release upload "$ROLLING_TAG" --repo "$REPOSITORY" --clobber "$WORK_DIR/latest.json"
manifest_verified=false
for attempt in 1 2 3 4 5; do
  if curl \
    --fail \
    --location \
    --retry 2 \
    --retry-all-errors \
    -H 'Cache-Control: no-cache' \
    -o "$WORK_DIR/published-latest.json" \
    "${MANIFEST_URL}?run=${GITHUB_RUN_ID:-manual}-${attempt}" \
    && cmp -s "$WORK_DIR/latest.json" "$WORK_DIR/published-latest.json"; then
    manifest_verified=true
    break
  fi
  sleep "${BERD_PROMOTION_RETRY_DELAY_SECONDS:-10}"
done
if [[ "$manifest_verified" != true ]]; then
  release_error "published latest.json could not be verified: $MANIFEST_URL"
  exit 1
fi
{
  echo "- Promoted version: \`$VERSION\`"
  echo "- Source commit: \`$SOURCE_SHA\`"
  echo "- Windows Authenticode posture: installer unsigned; updater minisign mandatory."
  printf '%s\n' "${SUMMARY_LINES[@]}"
  echo "- Manifest URL: $MANIFEST_URL"
} > "$SUMMARY_PATH"
