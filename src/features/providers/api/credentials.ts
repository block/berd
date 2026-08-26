import type {
  ProviderConfigChangeResponseUnstable as ProviderConfigChangeResponse,
  ProviderConfigFieldUpdate,
  ProviderConfigStatusDto,
  ProviderSecretDto,
} from "@aaif/goose-sdk";
import type { ProviderFieldValue } from "@/shared/types/providers";
import { getClient } from "@/shared/api/acpConnection";
import { shareInFlight } from "@/shared/lib/shareInFlight";

export type ProviderStatus = ProviderConfigStatusDto;
export type ProviderFieldSaveInput = ProviderConfigFieldUpdate;

type ProviderConfigChangedListener = (providerId: string) => void;
const providerConfigChangedListeners = new Set<ProviderConfigChangedListener>();

function notifyProviderConfigChanged(providerId: string) {
  for (const listener of providerConfigChangedListeners) listener(providerId);
}

export function onProviderConfigChanged(
  listener: ProviderConfigChangedListener,
): () => void {
  providerConfigChangedListeners.add(listener);
  return () => providerConfigChangedListeners.delete(listener);
}

export async function getProviderConfig(
  providerId: string,
): Promise<ProviderFieldValue[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersConfigRead({
    providerId,
  });
  return response.fields;
}

export async function saveProviderConfig(
  providerId: string,
  fields: ProviderFieldSaveInput[],
): Promise<ProviderConfigChangeResponse> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersConfigSave({
    providerId,
    fields,
  });
  notifyProviderConfigChanged(providerId);
  return response;
}

export async function authenticateProviderConfig(
  providerId: string,
): Promise<ProviderConfigChangeResponse> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersConfigAuthenticate({
    providerId,
  });
  notifyProviderConfigChanged(providerId);
  return response;
}

export async function deleteProviderConfig(
  providerId: string,
): Promise<ProviderConfigChangeResponse> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersConfigDelete({
    providerId,
  });
  notifyProviderConfigChanged(providerId);
  return response;
}

export async function listProviderSecrets(): Promise<ProviderSecretDto[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersSecretsList({});
  return response.secrets;
}

/**
 * Provider configuration status for every provider. A plain call always
 * fetches; startup gates and mount-time probes that only need a same-tick
 * snapshot pass `{ coalesce: true }` to share one read.
 */
export const checkAllProviderStatus = shareInFlight(
  async (): Promise<ProviderStatus[]> => {
    const client = await getClient();
    const response = await client.goose.GooseUnstableProvidersConfigStatus({
      providerIds: [],
    });
    return response.statuses;
  },
);
