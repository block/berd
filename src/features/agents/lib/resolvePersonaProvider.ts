import type { AcpProvider } from "@/shared/api/acp";
import type { Persona } from "@/shared/types/agents";

/**
 * Resolve a persona's configured provider against the available providers.
 *
 * A persona stores its provider as a free-form string, which may be an exact
 * provider id or a looser label hint. Match by exact id first, then fall back
 * to a case-insensitive substring match against the provider label.
 *
 * Returns the matching provider, or undefined when the persona has no provider
 * or none of the available providers match. Callers gate the persona's model
 * on a resolved provider so a model is never paired with a mismatched provider.
 */
export function resolvePersonaProvider(
  persona: Pick<Persona, "provider"> | null | undefined,
  providers: AcpProvider[],
): AcpProvider | undefined {
  const personaProvider = persona?.provider?.toLowerCase();
  if (!personaProvider) {
    return undefined;
  }

  return providers.find(
    (provider) =>
      provider.id === persona?.provider ||
      provider.label.toLowerCase().includes(personaProvider),
  );
}
