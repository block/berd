import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import type { Persona } from "@/shared/types/agents";

export interface RunPinnedPromptArgs {
  text: string;
  agentId?: string;
}

export interface RunPinnedPromptComposeOptions {
  personaId: string | null;
  executionTarget?: SessionExecutionTarget;
}

export interface RunPinnedPromptDeps {
  personas: Persona[];
  resolveExecutionTarget: (
    persona: Persona,
  ) => SessionExecutionTarget | undefined;
  /**
   * Target to run against when the pin has no agent (or the agent has no
   * model binding) — the home composer's current target. Composing without a
   * concrete target is how the global composer pill never behaves, so the
   * pin must not either.
   */
  resolveFallbackExecutionTarget: () => SessionExecutionTarget | undefined;
  compose: (
    text: string,
    options: RunPinnedPromptComposeOptions,
  ) => Promise<void> | void;
  onAgentUnavailable: () => void;
}

/**
 * Resolve a pinned prompt's attached agent and dispatch the prompt through
 * the global compose path. Returns false when nothing was sent: empty text,
 * or the attached agent no longer exists — the pin was saved with that agent
 * intent, so it must not silently run agentless.
 */
export async function runPinnedPrompt(
  args: RunPinnedPromptArgs,
  deps: RunPinnedPromptDeps,
): Promise<boolean> {
  const text = args.text.trim();
  if (!text) {
    return false;
  }

  let persona: Persona | undefined;
  if (args.agentId) {
    persona = deps.personas.find((candidate) => candidate.id === args.agentId);
    if (!persona) {
      deps.onAgentUnavailable();
      return false;
    }
  }

  const personaTarget = persona
    ? deps.resolveExecutionTarget(persona)
    : undefined;
  const executionTarget =
    personaTarget ?? deps.resolveFallbackExecutionTarget();
  await deps.compose(text, {
    // Explicit null mirrors the composer pill: "send without an agent", not
    // "inherit whatever the session has".
    personaId: persona ? persona.id : null,
    ...(executionTarget ? { executionTarget } : {}),
  });
  return true;
}
