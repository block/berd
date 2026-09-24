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
 * prompt sent under a given (session, provider) we inject the combined app
 * context and persona as an assistant-audience content block. Changes from
 * that provider's latest delivered context trigger a new handoff, including
 * transitions back to previously delivered context.
 */

import { getDefaultGooseModelProviderId } from "@/features/runtime-config/defaults";
import { getCatalogEntry } from "@/features/providers/providerCatalog";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";

export const GOOSE_PROVIDER_ID = "goose";

/**
 * Translate a UI provider id into the value sent to the backend. Only the
 * `"goose"` agent sentinel is rewritten to the concrete default model provider;
 * every real provider id (`claude-acp`, `codex-acp`, `databricks_v2`, ...)
 * passes through unchanged.
 */
export function toWireProviderId(providerId: string): string {
  if (providerId !== GOOSE_PROVIDER_ID) {
    return providerId;
  }

  const readiness = useDefaultProviderReadinessStore.getState().readiness;
  return readiness?.status === "ready"
    ? readiness.providerId
    : (getDefaultGooseModelProviderId() ?? providerId);
}

/**
 * Latest delivered combined preamble per session/provider. Historical states
 * must be delivered again after a transition (especially memory turning off).
 */
const deliveredHandoffs = new Map<string, string>();

function handoffKey(sessionId: string, providerId: string): string {
  return `${sessionId}\u0000${providerId}`;
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
 * Goose owns prompt assembly for the Goose agent and Goose model providers.
 * Those sessions use the real system-prompt ext method, so they never need the
 * in-band persona handoff.
 */
export function isGooseManagedProvider(
  providerId: string | undefined,
): boolean {
  if (!providerId) {
    return false;
  }
  if (providerId === GOOSE_PROVIDER_ID) {
    return true;
  }
  return getCatalogEntry(providerId)?.category === "model";
}

/**
 * Whether a provider is an external agent harness. External agents do not
 * implement Goose's system-prompt ext method.
 */
export function isExternalAgentProvider(
  providerId: string | undefined,
): boolean {
  return providerId ? !isGooseManagedProvider(providerId) : false;
}

/**
 * Frame the handed-off content (app context, persona instructions, or both)
 * as a preamble for the agent.
 */
export function buildPersonaHandoffPreamble(systemPrompt: string): string {
  return [
    "You are operating under the following context and instructions for this " +
      "session. Adopt them as your system prompt for the remainder of the " +
      "conversation, even though they arrive in-band:",
    "",
    systemPrompt.trim(),
    "",
    "Follow the context and instructions above for all subsequent turns. Do " +
      "not mention this handoff unless it is relevant to the user's request.",
  ].join("\n");
}

/**
 * Resolve the persona handoff for a send. Returns the preamble text to inject
 * as an assistant-audience block, or `null` when no handoff is needed (goose
 * provider, nothing to deliver, or already delivered for this handoff).
 *
 * Preparing does not change delivered state. Call markDelivered only after
 * dispatch ownership checks succeed; abandoned or failed claims remain retryable.
 */
export interface PersonaHandoffClaim {
  preamble: string;
  markDelivered: () => void;
}

export function preparePersonaHandoff(
  sessionId: string,
  providerId: string | undefined,
  systemPrompt: string | undefined,
  appPreamble?: string | null,
): PersonaHandoffClaim | null {
  if (!isExternalAgentProvider(providerId)) {
    return null;
  }

  const combined = [appPreamble?.trim(), systemPrompt?.trim()]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  if (!combined) {
    return null;
  }

  const key = handoffKey(sessionId, providerId as string);
  const state = fingerprint(combined);
  if (deliveredHandoffs.get(key) === state) {
    return null;
  }
  return {
    preamble: buildPersonaHandoffPreamble(combined),
    markDelivered: () => deliveredHandoffs.set(key, state),
  };
}

export function claimPersonaHandoff(
  sessionId: string,
  providerId: string | undefined,
  systemPrompt: string | undefined,
  appPreamble?: string | null,
): string | null {
  const claim = preparePersonaHandoff(
    sessionId,
    providerId,
    systemPrompt,
    appPreamble,
  );
  claim?.markDelivered();
  return claim?.preamble ?? null;
}

/**
 * Forget any delivered handoffs for a session so the next send re-injects.
 * Use when a session is reset/forked or its history is cleared.
 */
export function resetPersonaHandoff(sessionId: string): void {
  const prefix = `${sessionId}\u0000`;
  for (const key of deliveredHandoffs.keys()) {
    if (key.startsWith(prefix)) {
      deliveredHandoffs.delete(key);
    }
  }
}

/** Test-only: clear all tracked handoffs. */
export function __resetAllPersonaHandoffs(): void {
  deliveredHandoffs.clear();
}
