import type { AcpProvider } from "@/shared/api/acp";
import type { Persona } from "@/shared/types/agents";
import {
  normalizeProviderKey,
  resolveModelProviderCatalogIdStrict,
} from "@/features/providers/providerCatalog";

const IMPLICIT_GOOSE_PROVIDER: AcpProvider = { id: "goose", label: "Goose" };

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
  persona: Pick<Persona, "provider" | "model"> | null | undefined,
  providers: AcpProvider[],
): AcpProvider | undefined {
  const personaProvider = persona?.provider?.trim();
  if (!personaProvider) {
    return undefined;
  }

  const normalizedPersonaProvider = normalizeProviderKey(personaProvider);
  if (persona?.model && resolveModelProviderCatalogIdStrict(personaProvider)) {
    return IMPLICIT_GOOSE_PROVIDER;
  }
  const matchingProvider = providers.find(
    (provider) =>
      provider.id === personaProvider ||
      normalizeProviderKey(provider.id) === normalizedPersonaProvider ||
      normalizeProviderKey(provider.label).includes(normalizedPersonaProvider),
  );

  if (matchingProvider) {
    return matchingProvider;
  }

  if (
    normalizedPersonaProvider === "goose" ||
    normalizedPersonaProvider === "berd"
  ) {
    return IMPLICIT_GOOSE_PROVIDER;
  }

  return undefined;
}
