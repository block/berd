#!/usr/bin/env bash
# Resolve the six renderer build gates to their matching Tauri Cargo features.
set -euo pipefail

base_features="${1:-}"
features=()
[[ -n "$base_features" ]] && IFS=',' read -r -a features <<< "$base_features"

for name in VITE_AGENT_TOOLS VITE_AUTOMATIONS VITE_BUILDERBOT VITE_FEEDBACK VITE_MANAGED_CONNECTIONS VITE_VOICE_DICTATION; do
  value="${!name:-0}"
  if [[ "$value" != "0" && "$value" != "1" ]]; then
    echo "$name must be 0 or 1 (got: $value)" >&2
    exit 2
  fi
done

[[ "${VITE_AGENT_TOOLS:-0}" == "1" ]] && features+=(block-agent-tools)
[[ "${VITE_AUTOMATIONS:-0}" == "1" ]] && features+=(block-automations)
[[ "${VITE_BUILDERBOT:-0}" == "1" ]] && features+=(block-builderbot)
[[ "${VITE_FEEDBACK:-0}" == "1" ]] && features+=(block-feedback)
[[ "${VITE_MANAGED_CONNECTIONS:-0}" == "1" ]] && features+=(block-managed-connections)
if [[ "${VITE_VOICE_DICTATION:-0}" == "1" ]]; then
  features+=(block-voice-dictation)
else
  features+=(no-voice-dictation)
fi

(IFS=,; echo "${features[*]}")
