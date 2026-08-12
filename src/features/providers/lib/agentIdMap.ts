// Map between this app's agent provider IDs and the doctor crate's check IDs.
//
// The doctor crate uses `ai-agent-<short>` (e.g. `ai-agent-claude`). The
// frontend uses the provider catalog's IDs (`claude-acp`, `cursor-agent`,
// `goose`, etc.). Keeping the translation here lets the rest of the codebase
// stay on the catalog IDs.

const CRATE_TO_PROVIDER: Record<string, string> = {
  "ai-agent-goose": "goose",
  "ai-agent-claude": "claude-acp",
  "ai-agent-codex": "codex-acp",
  "ai-agent-amp": "amp-acp",
  "ai-agent-copilot": "copilot-acp",
  "ai-agent-pi": "pi-acp",
  "ai-agent-cursor": "cursor-agent",
};

export function crateCheckIdToProviderId(checkId: string): string | null {
  return CRATE_TO_PROVIDER[checkId] ?? null;
}
