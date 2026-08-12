#!/usr/bin/env bash
# Fail a macOS release if the signing service dropped Berd's required entitlements.

set -euo pipefail
[[ $# -eq 1 ]] || { echo "Usage: $0 <path-to-Berd.app>" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_PATH="$1"
INFO_PLIST="$APP_PATH/Contents/Info.plist"
[[ -d "$APP_PATH" ]] || { echo "missing app bundle: $APP_PATH" >&2; exit 1; }
[[ -f "$INFO_PLIST" ]] || { echo "missing app Info.plist: $INFO_PLIST" >&2; exit 1; }

EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$INFO_PLIST")"
EXECUTABLE_PATH="$APP_PATH/Contents/MacOS/$EXECUTABLE_NAME"
[[ -f "$EXECUTABLE_PATH" ]] || { echo "missing app executable: $EXECUTABLE_PATH" >&2; exit 1; }

ENTITLEMENTS="$(mktemp -t berd-entitlements)"
trap 'rm -f "$ENTITLEMENTS"' EXIT
codesign --display --entitlements "$ENTITLEMENTS" --xml "$EXECUTABLE_PATH" 2>/dev/null
[[ -s "$ENTITLEMENTS" ]] || { echo "signed app has no embedded entitlements" >&2; exit 1; }

while IFS= read -r entitlement; do
  [[ -n "$entitlement" ]] || continue
  value="$(/usr/libexec/PlistBuddy -c "Print :$entitlement" "$ENTITLEMENTS" 2>/dev/null || true)"
  [[ "$value" == "true" ]] || {
    echo "signed app is missing required entitlement: $entitlement" >&2
    exit 1
  }
done < <(/usr/libexec/PlistBuddy -c 'Print' "$REPO_ROOT/src-tauri/entitlements.plist" 2>/dev/null \
  | sed -n 's/^[[:space:]]*\([^=[:space:]][^=]*\) = true[[:space:]]*$/\1/p')

echo "verified required macOS entitlements on $EXECUTABLE_PATH"
