#!/usr/bin/env bash
# Upload Berd's auto-updater payload to Artifactory so internal installs
# poll it and self-update. Running Berd reads `BERD_UPDATER_ENDPOINT`
# from its compiled-in config, which for internal builds points at
# `.../mdx/goose-internal/latest.json` served by this script.
#
# Expected inputs on disk (prepared by publish-updater.sh above: signed +
# notarized + stapled .app re-tarred, archive minisign-signed with
# GOOSE2_TAURI_SIGNING_PRIVATE_KEY):
#
#   $RELEASE_DIR/macos/Berd_<version>_darwin-aarch64.app.tar.gz
#   $RELEASE_DIR/macos/Berd_<version>_darwin-aarch64.app.tar.gz.sig
#   $RELEASE_DIR/macos/Berd_<version>_darwin-aarch64.app.tar.gz.sha256
#
# Uploads:
#   mdx/goose-internal/v<version>/Berd_<version>_darwin-aarch64.app.tar.gz
#   mdx/goose-internal/v<version>/Berd_<version>_darwin-aarch64.app.tar.gz.sig
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
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../../release/lib.sh"

RELEASE_VERSION="$(release_input_version)"
: "${MOBUILD_ARTIFACTORY_UPLOAD_TOKEN:?MOBUILD_ARTIFACTORY_UPLOAD_TOKEN is required}"

# Reads on mdx/ are unauthenticated, so a running Berd install can poll the
# manifest without Block credentials. Writes require the `mobuild` service
# account via the upload token above.
ARTIFACTORY_BASE="${ARTIFACTORY_BASE:-https://global.block-artifacts.com/artifactory/mdx/goose-internal}"
ARTIFACTORY_USER="${ARTIFACTORY_USER:-mobuild}"

VERSION_PATH="v$RELEASE_VERSION"
PLATFORM="darwin-aarch64"
validate_release_platform "$PLATFORM"
ARCHIVE_NAME="$(release_archive_name "$RELEASE_VERSION" "$PLATFORM")"
ARCHIVE_SRC="$RELEASE_DIR/macos/$ARCHIVE_NAME"
SIGNATURE_SRC="$ARCHIVE_SRC.sig"
DIGEST_SRC="$ARCHIVE_SRC.sha256"
[[ -f "$ARCHIVE_SRC" ]] || { echo "Missing $ARCHIVE_SRC" >&2; exit 1; }
[[ -f "$SIGNATURE_SRC" ]] || { echo "Missing $SIGNATURE_SRC" >&2; exit 1; }
[[ -f "$DIGEST_SRC" ]] || { echo "Missing $DIGEST_SRC" >&2; exit 1; }

ARCHIVE_URL="$ARTIFACTORY_BASE/$VERSION_PATH/$ARCHIVE_NAME"
SIGNATURE_URL="$ARCHIVE_URL.sig"
DIGEST_URL="$ARCHIVE_URL.sha256"
MANIFEST_URL="$ARTIFACTORY_BASE/latest.json"

echo "+++ :memo: Assembling latest.json"
MANIFEST="$(mktemp)"
trap 'rm -f "$MANIFEST"' EXIT

"$REPO_ROOT/scripts/release/generate-latest-json.sh" \
  "$RELEASE_VERSION" \
  "$PLATFORM" \
  "$SIGNATURE_SRC" \
  "$ARCHIVE_URL" \
  "Berd v$RELEASE_VERSION internal build." > "$MANIFEST"

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
upload "$DIGEST_SRC" "$DIGEST_URL"

# latest.json is the stable URL every install polls. Overwriting it is what
# triggers auto-update, so the pipeline's input step gates this.
PUBLISH_LATEST="$(release_input publish_latest)"
if [[ "$PUBLISH_LATEST" == "true" ]]; then
  upload "$MANIFEST" "$MANIFEST_URL"
  echo "+++ :white_check_mark: Published updater to $MANIFEST_URL"
else
  echo "+++ :pause_button: Skipping latest.json (publish_latest=$PUBLISH_LATEST) - existing installs stay on their current version"
  echo "+++ :package: Archive still available at $ARCHIVE_URL for manual download"
fi
