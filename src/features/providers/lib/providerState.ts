import type {
  ProviderCatalogEntry,
  ProviderSetupStatus,
} from "@/shared/types/providers";
import {
  getProviderConnectionEvidence,
  type ProviderConnectionEvidence,
  type ProviderConnectionSnapshot,
} from "./providerConnectionPolicy";

export interface ModelProviderState {
  id: string;
  evidence: ProviderConnectionEvidence;
  status: ProviderSetupStatus;
  connected: boolean;
}

const CONNECTED_EVIDENCE: ReadonlySet<ProviderConnectionEvidence> = new Set([
  "credential",
  "managed_endpoint",
  "custom",
]);

/**
 * Canonical projection of model-provider configuration. Consumers may choose
 * how to render the state, but they do not get to redefine what "connected"
 * means.
 */
export function projectModelProviderState(
  provider: ProviderCatalogEntry,
  snapshot: ProviderConnectionSnapshot,
): ModelProviderState {
  const evidence = getProviderConnectionEvidence(provider, snapshot);
  const connected = CONNECTED_EVIDENCE.has(evidence);
  return {
    id: provider.id,
    evidence,
    connected,
    status: connected
      ? "connected"
      : evidence === "saved_settings"
        ? "configured"
        : "not_configured",
  };
}

export function projectModelProviderStates(
  providers: readonly ProviderCatalogEntry[],
  snapshot: ProviderConnectionSnapshot,
): Map<string, ModelProviderState> {
  return new Map(
    providers.map((provider) => [
      provider.id,
      projectModelProviderState(provider, snapshot),
    ]),
  );
}

export function connectedModelProviderIds(
  providers: readonly ProviderCatalogEntry[],
  snapshot: ProviderConnectionSnapshot,
): string[] {
  return providers
    .filter(
      (provider) => projectModelProviderState(provider, snapshot).connected,
    )
    .map((provider) => provider.id);
}
