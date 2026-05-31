/**
 * Persona handoff for non-goose harnesses.
 *
 * Goose delivers a persona's system prompt through the goose-only ACP
 * extension `_goose/unstable/session/system-prompt/set`. External ACP agents
 * (Claude Code, Codex, Copilot, Amp, Cursor, ...) do not implement that method,
 * and the ACP protocol exposes no system-prompt channel on `session/new` or
 * `session/prompt`. So the persona instructions never reach those models.
 *
 * Instead we treat *entering an agent* as a handoff -- mirroring the backend
 * conversation-history handoff (`build_handoff_context_memo`). On the first
 * prompt sent under a given (session, provider, persona) we inject the persona
 * instructions once as an assistant-audience content block. Switching the
 * session to a different agent (or a different persona) is a new handoff and
 * re-injects.
 */

const GOOSE_PROVIDER_ID = "goose";

/**
 * Tracks which persona handoffs have already been delivered, keyed by
 * session + provider + a fingerprint of the persona/system prompt. Re-keying
 * on the provider means switching agents mid-session re-triggers the handoff.
 */
const deliveredHandoffs = new Set<string>();

function handoffKey(
  sessionId: string,
  providerId: string,
  systemPrompt: string,
): string {
  return `${sessionId}\u0000${providerId}\u0000${fingerprint(systemPrompt)}`;
}

/**
 * Cheap, stable fingerprint of the persona text so editing a persona's prompt
 * counts as a new handoff without storing the full prompt in the key.
 */
function fingerprint(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `${text.length}:${hash >>> 0}`;
}

/**
 * Whether a provider is an external agent harness (anything other than goose).
 * Goose owns prompt assembly and uses the real system-prompt ext method, so it
 * never needs the handoff.
 */
export function isExternalAgentProvider(
  providerId: string | undefined,
): boolean {
  return Boolean(providerId) && providerId !== GOOSE_PROVIDER_ID;
}

/** Frame the persona instructions as a handoff preamble for the agent. */
export function buildPersonaHandoffPreamble(systemPrompt: string): string {
  return [
    "You are operating under the following persona and instructions for this " +
      "session. Adopt them as your system prompt for the remainder of the " +
      "conversation, even though they arrive in-band:",
    "",
    systemPrompt.trim(),
    "",
    "Follow the persona and instructions above for all subsequent turns. Do " +
      "not mention this handoff unless it is relevant to the user's request.",
  ].join("\n");
}

/**
 * Resolve the persona handoff for a send. Returns the preamble text to inject
 * as an assistant-audience block, or `null` when no handoff is needed (goose
 * provider, empty persona prompt, or already delivered for this handoff).
 *
 * Marks the handoff as delivered as a side effect, so callers must only invoke
 * this once per send when they intend to inject.
 */
export function claimPersonaHandoff(
  sessionId: string,
  providerId: string | undefined,
  systemPrompt: string | undefined,
): string | null {
  const trimmed = systemPrompt?.trim();
  if (!trimmed || !isExternalAgentProvider(providerId)) {
    return null;
  }

  const key = handoffKey(sessionId, providerId as string, trimmed);
  if (deliveredHandoffs.has(key)) {
    return null;
  }
  deliveredHandoffs.add(key);
  return buildPersonaHandoffPreamble(trimmed);
}

/**
 * Forget any delivered handoffs for a session so the next send re-injects.
 * Use when a session is reset/forked or its history is cleared.
 */
export function resetPersonaHandoff(sessionId: string): void {
  const prefix = `${sessionId}\u0000`;
  for (const key of deliveredHandoffs) {
    if (key.startsWith(prefix)) {
      deliveredHandoffs.delete(key);
    }
  }
}

/** Test-only: clear all tracked handoffs. */
export function __resetAllPersonaHandoffs(): void {
  deliveredHandoffs.clear();
}
