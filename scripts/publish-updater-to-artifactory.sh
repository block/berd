#!/usr/bin/env bash
# Upload Goose's auto-updater payload to Artifactory so internal installs
# poll it and self-update. Running Goose reads `GOOSE2_UPDATER_ENDPOINT`
# from its compiled-in config, which for internal builds points at
# `.../mdx/goose-internal/latest.json` served by this script.
#
# Expected inputs on disk (prepared by publish-updater.sh above: signed +
# notarized + stapled .app re-tarred, archive minisign-signed with
# GOOSE2_TAURI_SIGNING_PRIVATE_KEY):
#
#   $RELEASE_DIR/macos/Goose.app.tar.gz        Updater archive of the signed .app
#   $RELEASE_DIR/macos/Goose.app.tar.gz.sig    Minisign signature of the archive
#
# Uploads:
#   mdx/goose-internal/v<version>/Goose.app.tar.gz      Versioned archive
#   mdx/goose-internal/v<version>/Goose.app.tar.gz.sig  Versioned signature
#   mdx/goose-internal/latest.json                      Stable manifest installs poll
#
# The final manifest upload is gated on the pipeline's publish_latest input so
# one-off or test builds don't silently cut every install over to an
# experimental version.
#
# Required env:
#   MOBUILD_ARTIFACTORY_UPLOAD_TOKEN   Artifactory write auth (mobuild token)
#   version + publish_latest           via Buildkite meta-data or env override
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/buildkite/release/lib.sh"

RELEASE_VERSION="$(meta version)"
: "${MOBUILD_ARTIFACTORY_UPLOAD_TOKEN:?MOBUILD_ARTIFACTORY_UPLOAD_TOKEN is required}"

# Reads on mdx/ are unauthenticated, so a running Goose install can poll the
# manifest without Block credentials. Writes require the `mobuild` service
# account via the upload token above.
ARTIFACTORY_BASE="${ARTIFACTORY_BASE:-https://global.block-artifacts.com/artifactory/mdx/goose-internal}"
ARTIFACTORY_USER="${ARTIFACTORY_USER:-mobuild}"

VERSION_PATH="v$RELEASE_VERSION"
ARCHIVE_SRC="$RELEASE_DIR/macos/${APP_BUNDLE_NAME}.app.tar.gz"
SIGNATURE_SRC="$ARCHIVE_SRC.sig"
[[ -f "$ARCHIVE_SRC" ]] || { echo "Missing $ARCHIVE_SRC" >&2; exit 1; }
[[ -f "$SIGNATURE_SRC" ]] || { echo "Missing $SIGNATURE_SRC" >&2; exit 1; }

ARCHIVE_URL="$ARTIFACTORY_BASE/$VERSION_PATH/${APP_BUNDLE_NAME}.app.tar.gz"
SIGNATURE_URL="$ARCHIVE_URL.sig"
MANIFEST_URL="$ARTIFACTORY_BASE/latest.json"

echo "+++ :memo: Assembling latest.json"
MANIFEST="$(mktemp)"
trap 'rm -f "$MANIFEST"' EXIT

# The signature field is the raw contents of the tauri-generated .sig file,
# which is already a single-line base64 blob. jq only escapes it as a JSON
# string.
jq -n \
  --arg version   "$RELEASE_VERSION" \
  --arg notes     "Goose v$RELEASE_VERSION internal build." \
  --arg pub_date  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg signature "$(cat "$SIGNATURE_SRC")" \
  --arg url       "$ARCHIVE_URL" \
  '{
    version: $version,
    notes: $notes,
    pub_date: $pub_date,
    platforms: {
      "darwin-aarch64": {
        signature: $signature,
        url: $url
      }
    }
  }' > "$MANIFEST"

jq -e '
  (.platforms["darwin-aarch64"].url | test("^https://")) and
  (.platforms["darwin-aarch64"].signature | length > 0)
' "$MANIFEST" >/dev/null

upload() {
  local src="$1"
  local url="$2"
  echo "Uploading $(basename "$src") -> $url"
  # -f fails on HTTP errors so we don't silently publish a manifest pointing
  # at an archive that failed to upload.
  curl -fSs \
    -u "$ARTIFACTORY_USER:$MOBUILD_ARTIFACTORY_UPLOAD_TOKEN" \
    -T "$src" \
    "$url"
  echo
}

# Order matters: publish the versioned archive + signature first so that by
# the time the stable manifest URL advertises them, they're already fetchable.
# A transient failure before the manifest upload leaves the previous manifest
# in place, and running installs keep polling the prior version.
upload "$ARCHIVE_SRC" "$ARCHIVE_URL"
upload "$SIGNATURE_SRC" "$SIGNATURE_URL"

# latest.json is the stable URL every install polls. Overwriting it is what
# triggers auto-update, so the pipeline's input step gates this.
PUBLISH_LATEST="$(meta publish_latest)"
if [[ "$PUBLISH_LATEST" == "true" ]]; then
  upload "$MANIFEST" "$MANIFEST_URL"
  echo "+++ :white_check_mark: Published updater to $MANIFEST_URL"
else
  echo "+++ :pause_button: Skipping latest.json (publish_latest=$PUBLISH_LATEST) - existing installs stay on their current version"
  echo "+++ :package: Archive still available at $ARCHIVE_URL for manual download"
fi
