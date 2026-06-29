#!/usr/bin/env bash
# Render a macOS entitlements template for raw codesign consumers.
#
# Xcode can expand AppIdentifierPrefix-style build settings, but `codesign
# --entitlements` embeds the plist it is given. This script resolves the
# checked-in $(AppIdentifierPrefix) placeholder to the concrete prefix expected
# by keychain-access-groups.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <template.plist> <output.plist>" >&2
  exit 1
fi

template="$1"
output="$2"

if [[ ! -f "$template" ]]; then
  echo "entitlements template not found: $template" >&2
  exit 1
fi

prefix="${APP_IDENTIFIER_PREFIX:-}"
if [[ -n "$prefix" ]]; then
  if [[ ! "$prefix" =~ ^[A-Za-z0-9]+[.]?$ ]]; then
    echo "invalid app identifier prefix: $prefix" >&2
    exit 1
  fi
else
  if [[ ! "${APPLE_TEAM_ID:-}" =~ ^[A-Za-z0-9]+$ ]]; then
    echo "invalid Apple team id: ${APPLE_TEAM_ID:-}" >&2
    exit 1
  fi
  prefix="$APPLE_TEAM_ID"
fi

if [[ "$prefix" != *. ]]; then
  prefix="${prefix}."
fi

mkdir -p "$(dirname "$output")"
sed \
  -e "s|[$](AppIdentifierPrefix)|$prefix|g" \
  -e "s|__APP_IDENTIFIER_PREFIX__|$prefix|g" \
  "$template" > "$output"

if grep -Eq '__APP_IDENTIFIER_PREFIX__|\$\(AppIdentifierPrefix\)' "$output"; then
  echo "failed to replace app identifier prefix in $output" >&2
  exit 1
fi
