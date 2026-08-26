import type {
  ProviderConfigChangeResponseUnstable as ProviderConfigChangeResponse,
  ProviderConfigFieldUpdate,
  ProviderConfigStatusDto,
  ProviderSecretDto,
} from "@aaif/goose-sdk";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProviderFieldValue } from "@/shared/types/providers";
import { getClient } from "@/shared/api/acpConnection";
import { shareInFlight } from "@/shared/lib/shareInFlight";

export type ProviderStatus = ProviderConfigStatusDto;
export type ProviderFieldSaveInput = ProviderConfigFieldUpdate;

const PROVIDER_CONFIG_CHANGED_EVENT = "provider-config:changed";

async function notifyProviderConfigChanged(providerId: string) {
  await emit(PROVIDER_CONFIG_CHANGED_EVENT, { providerId });
}

export function onProviderConfigChanged(
  listener: (providerId: string) => void,
): Promise<UnlistenFn> {
  return listen<{ providerId: string }>(
    PROVIDER_CONFIG_CHANGED_EVENT,
    (event) => listener(event.payload.providerId),
  );
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
  await notifyProviderConfigChanged(providerId);
  return response;
}

export async function authenticateProviderConfig(
  providerId: string,
): Promise<ProviderConfigChangeResponse> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersConfigAuthenticate({
    providerId,
  });
  await notifyProviderConfigChanged(providerId);
  return response;
}

export async function deleteProviderConfig(
  providerId: string,
): Promise<ProviderConfigChangeResponse> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersConfigDelete({
    providerId,
  });
  await notifyProviderConfigChanged(providerId);
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
