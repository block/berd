#!/usr/bin/env bash
# Draft release notes from commits since the previous release tag.
#
# Usage:
#   ./scripts/generate-release-notes.sh [from-ref] [to-ref]
#   FROM_REF=v0.4.0 TO_REF=HEAD ./scripts/generate-release-notes.sh
#
# Defaults: from-ref = latest v* tag, to-ref = HEAD.
#
# Formatting guidelines live in scripts/release-notes-prompt.md; the prompt
# and the commit log are fed to `goose run` to produce the notes on stdout.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMPT_FILE="$REPO_ROOT/scripts/release-notes-prompt.md"
RELEASE_REPOSITORY="${BERD_REPO:-${GITHUB_REPOSITORY:-}}"
if [[ -z "$RELEASE_REPOSITORY" && -f "$REPO_ROOT/scripts/release/release-channel.json" ]]; then
  RELEASE_REPOSITORY="$(jq -er .repository "$REPO_ROOT/scripts/release/release-channel.json")"
fi
if [[ -z "$RELEASE_REPOSITORY" ]]; then
  echo "BERD_REPO must be configured for release-note generation." >&2
  exit 1
fi

[[ -f "$PROMPT_FILE" ]] || { echo "Missing prompt file: $PROMPT_FILE" >&2; exit 1; }

FROM_REF="${1:-${FROM_REF:-}}"
TO_REF="${2:-${TO_REF:-HEAD}}"

if [[ -z "$FROM_REF" ]]; then
  FROM_REF="$(git -C "$REPO_ROOT" describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
fi

if [[ -z "$FROM_REF" ]]; then
  echo "No previous v* tag found; pass an explicit from-ref." >&2
  exit 1
fi

COMMITS="$(git -C "$REPO_ROOT" log --no-merges --format='- %s%n%b%n---' "${FROM_REF}..${TO_REF}")"

if [[ -z "$COMMITS" ]]; then
  echo "No commits between ${FROM_REF} and ${TO_REF}." >&2
  exit 1
fi

echo "Generating release notes for ${FROM_REF}..${TO_REF}" >&2
echo "Using default goose provider and model" >&2

# --no-session: don't persist a session for this one-shot run
# --no-profile: only the developer extension, so the agent can inspect commits
# --output-format json: even with --quiet, goose echoes tool calls/output to
# stdout; json gives a structured transcript so we can extract only the final
# assistant message with jq
GOOSE_LOG="$(mktemp)"
trap 'rm -f "$GOOSE_LOG"' EXIT
if ! TRANSCRIPT="$(goose run --quiet --no-session --no-profile --with-builtin developer --output-format json --instructions - 2>"$GOOSE_LOG" <<EOF
$(cat "$PROMPT_FILE")

## Commits (${FROM_REF}..${TO_REF})

${COMMITS}
EOF
)"; then
  echo "goose run failed; output:" >&2
  cat "$GOOSE_LOG" >&2
  exit 1
fi

NOTES="$(jq -r '[.messages[] | select(.role=="assistant") | .content[] | select(.type=="text") | .text] | last' <<<"$TRANSCRIPT")"

if [[ -z "$NOTES" || "$NOTES" == "null" ]]; then
  echo "Could not extract release notes from goose output." >&2
  exit 1
fi

# Append the GitHub compare link. Resolve symbolic refs like HEAD to a sha so
# the link stays stable.
COMPARE_TO="$TO_REF"
if [[ "$TO_REF" == "HEAD" ]]; then
  COMPARE_TO="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
fi
NOTES="${NOTES}

**Full Changelog**: https://github.com/${RELEASE_REPOSITORY}/compare/${FROM_REF}...${COMPARE_TO}"

printf '\n%s\n' "$NOTES"
echo "Draft only; review these notes before release preparation." >&2
