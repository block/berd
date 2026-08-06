#!/usr/bin/env bash
# Generate release notes from commits since the previous release tag.
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
if [[ -z "$RELEASE_REPOSITORY" && -f "$REPO_ROOT/scripts/release/public-channel.json" ]]; then
  RELEASE_REPOSITORY="$(jq -er .repository "$REPO_ROOT/scripts/release/public-channel.json")"
fi
if [[ -z "$RELEASE_REPOSITORY" ]]; then
  echo "BERD_REPO must be configured for release-note publishing." >&2
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

echo
echo "$NOTES"
echo >&2

# Publishing requires a real tag to target; a symbolic ref like HEAD has no
# corresponding GitHub release.
if [[ "$TO_REF" == "HEAD" ]]; then
  echo "to-ref is HEAD, not a release tag; skipping publish." >&2
  exit 0
fi

# Review gate: require explicit acceptance before publishing.
read -r -p "Accept these release notes and publish to the GitHub release ${TO_REF}? [y/N] " REPLY
if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
  echo "Rejected; not publishing." >&2
  exit 1
fi

echo "Publishing release notes for ${TO_REF}..." >&2

# The release body created by our automation (publish-release.sh) carries
# build metadata (Buildkite build URL, app commit, pinned backend commit).
# Editing the release replaces the whole body, so preserve the existing body
# by appending it after the new notes.
EXISTING_BODY="$(gh release view "$TO_REF" --repo "$RELEASE_REPOSITORY" --json body -q .body 2>/dev/null || true)"
if [[ -n "$EXISTING_BODY" ]]; then
  NOTES="${NOTES}

---

${EXISTING_BODY}"
fi

# Second goose run with the developer extension enabled so the agent can use
# the gh CLI to update the release.
goose run --quiet --no-session --no-profile --with-builtin developer --instructions - <<EOF
You are publishing release notes for the configured public repository (${RELEASE_REPOSITORY}).

Use the \`gh\` CLI to set the notes on the GitHub release for tag \`${TO_REF}\`:

1. Verify the release exists: \`gh release view ${TO_REF} --repo ${RELEASE_REPOSITORY}\`.
   If it does not exist, stop and report that — do not create a release.
2. Update only the release notes body, leaving title, tag, target, and assets
   unchanged. Write the notes below to a temp file and run:
   \`gh release edit ${TO_REF} --repo ${RELEASE_REPOSITORY} --notes-file <tempfile>\`.
3. Confirm the update succeeded and print the release URL.

Use the release notes below verbatim — do not edit, reformat, or summarize
them. They already include the build metadata from the existing release body
(Buildkite build, app commit, pinned backend commit) at the end; keep it.

---BEGIN RELEASE NOTES---
${NOTES}
---END RELEASE NOTES---
EOF
