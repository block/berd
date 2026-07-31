import type {
  ProviderConfigChangeResponseUnstable as ProviderConfigChangeResponse,
  ProviderConfigFieldUpdate,
  ProviderConfigStatusDto,
  ProviderSecretDto,
} from "@aaif/goose-sdk";
import type { ProviderFieldValue } from "@/shared/types/providers";
import { getClient } from "@/shared/api/acpConnection";

export type ProviderStatus = ProviderConfigStatusDto;
export type ProviderFieldSaveInput = ProviderConfigFieldUpdate;

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
  return response;
}

export async function authenticateProviderConfig(
  providerId: string,
): Promise<ProviderConfigChangeResponse> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersConfigAuthenticate({
    providerId,
  });
  return response;
}

export async function deleteProviderConfig(
  providerId: string,
): Promise<ProviderConfigChangeResponse> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersConfigDelete({
    providerId,
  });
  return response;
}

export async function listProviderSecrets(): Promise<ProviderSecretDto[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersSecretsList({});
  return response.secrets;
}

export async function checkAllProviderStatus(): Promise<ProviderStatus[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersConfigStatus({
    providerIds: [],
  });
  return response.statuses;
}
