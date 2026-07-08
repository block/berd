#!/usr/bin/env bash
# Stage the Catch sidecar for Tauri's externalBin bundling.
#
# Catch is https://github.com/block/catch. Goose bundles it to implement the
# macOS Global shortcut experiment.
#
# Tauri expects external binaries to be present at build time with the target
# triple appended to the configured stem. For config
#   "externalBin": ["binaries/catch"]
# this script creates:
#   src-tauri/binaries/catch-<triple>

set -euo pipefail

CATCH_VERSION="${CATCH_VERSION:-0.5.0}"
CATCH_TARBALL_SHA256="${CATCH_TARBALL_SHA256:-a14aed082cc3ed695a94ad6ce62e1a09f18f0dbc81aa8c77485c7b200fe6130f}"

usage() {
  cat <<'USAGE'
Usage: scripts/prepare-catch-sidecar.sh [target-triple]

Stages the Catch sidecar into src-tauri/binaries with the target triple suffix
required by Tauri. The triple defaults to the rustc host.

For macOS targets, this downloads (or uses CATCH_TARBALL) for the release
asset catch-v$CATCH_VERSION-macos-universal.tar.gz and verifies its SHA-256.
Set CATCH_BIN to copy a local Catch binary instead.

For non-macOS targets, this stages a small unsupported-platform stub so
cross-platform Goose builds can still satisfy Tauri externalBin resolution.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

TRIPLE="${1:-${CATCH_TRIPLE:-}}"
if [[ -z "$TRIPLE" ]]; then
  TRIPLE="$(rustc -vV | sed -n 's|host: ||p')"
  if [[ -z "$TRIPLE" ]]; then
    echo "Could not determine rust host target." >&2
    exit 1
  fi
fi

OUT_DIR="src-tauri/binaries"
OUT="$OUT_DIR/catch-$TRIPLE"
mkdir -p "$OUT_DIR"

macos_target_arch() {
  case "$TRIPLE" in
    aarch64-apple-darwin) echo "arm64" ;;
    x86_64-apple-darwin) echo "x86_64" ;;
    *)
      echo "Unsupported macOS Catch target triple: $TRIPLE" >&2
      return 1
      ;;
  esac
}

stage_macos_binary() {
  local source="$1"
  local arch
  arch="$(macos_target_arch)" || return 1

  if ! command -v lipo >/dev/null 2>&1; then
    echo "lipo is required to stage the macOS Catch sidecar." >&2
    return 1
  fi
  if ! command -v codesign >/dev/null 2>&1; then
    echo "codesign is required to stage the macOS Catch sidecar." >&2
    return 1
  fi

  # The upstream Catch macOS asset is universal, and v0.5.0 contains an
  # unsigned x86_64 slice. Release CI builds an arm64 app, so thin universal
  # inputs to the exact target architecture before Tauri bundles them. Local
  # CATCH_BIN overrides may already be thin target-arch binaries, so copy those
  # through unchanged. Normalize the staged result with an ad-hoc signature so
  # the outer app signing pass can verify it.
  local lipo_info
  lipo_info="$(lipo -info "$source")"
  if [[ "$lipo_info" == Non-fat\ file:* ]]; then
    if [[ "$lipo_info" != *" is architecture: $arch" ]]; then
      echo "Catch binary architecture does not match $TRIPLE: $lipo_info" >&2
      return 1
    fi
    if [[ "$source" != "$OUT" ]]; then
      cp "$source" "$OUT"
    fi
  else
    lipo "$source" -thin "$arch" -output "$OUT"
  fi
  chmod +x "$OUT"
  codesign --force --sign - "$OUT"
}

if [[ "$TRIPLE" != *"apple-darwin" ]]; then
  cat >"$OUT" <<'STUB'
#!/usr/bin/env sh
echo "The Catch sidecar is only supported on macOS." >&2
exit 1
STUB
  chmod +x "$OUT"
  echo "Staged unsupported-platform Catch sidecar stub: $OUT"
  exit 0
fi

if [[ -n "${CATCH_BIN:-}" ]]; then
  if [[ ! -x "$CATCH_BIN" ]]; then
    echo "Catch binary is not executable: $CATCH_BIN" >&2
    exit 1
  fi
  stage_macos_binary "$CATCH_BIN"
  echo "Staged local Catch sidecar: $OUT"
  exit 0
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/goose-catch-sidecar.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

ASSET="catch-v${CATCH_VERSION#v}-macos-universal.tar.gz"
TARBALL="${CATCH_TARBALL:-}"

if [[ -z "$TARBALL" ]]; then
  TARBALL="$WORK_DIR/$ASSET"
  DOWNLOAD_URL="https://github.com/block/catch/releases/download/v${CATCH_VERSION#v}/$ASSET"
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is not available to download Catch sidecar." >&2
    exit 1
  fi
  curl -fsSL "$DOWNLOAD_URL" -o "$TARBALL"
fi

if [[ ! -f "$TARBALL" ]]; then
  echo "Catch sidecar tarball not found: $TARBALL" >&2
  exit 1
fi

ACTUAL_SHA256="$(python3 - "$TARBALL" <<'PY'
import hashlib
import sys

path = sys.argv[1]
digest = hashlib.sha256()
with open(path, "rb") as file:
    for chunk in iter(lambda: file.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
)"

if [[ "$ACTUAL_SHA256" != "$CATCH_TARBALL_SHA256" ]]; then
  echo "Catch sidecar digest mismatch for $TARBALL" >&2
  echo "Expected: $CATCH_TARBALL_SHA256" >&2
  echo "Actual:   $ACTUAL_SHA256" >&2
  exit 1
fi

tar -C "$WORK_DIR" -xzf "$TARBALL"
if [[ ! -x "$WORK_DIR/catch" ]]; then
  echo "Catch sidecar tarball did not contain an executable 'catch' binary." >&2
  exit 1
fi

stage_macos_binary "$WORK_DIR/catch"
echo "Staged Catch sidecar: $OUT"
