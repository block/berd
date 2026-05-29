import { getClient } from "@/shared/api/acpConnection";
import type {
  CustomProviderCreateResponseUnstable as CustomProviderCreateResponse,
  CustomProviderDeleteResponseUnstable as CustomProviderDeleteResponse,
  CustomProviderReadResponseUnstable as CustomProviderReadResponse,
  CustomProviderUpdateResponseUnstable as CustomProviderUpdateResponse,
  ProviderTemplateCatalogEntryDto,
  ProviderTemplateDto,
} from "@aaif/goose-sdk";
import type {
  CustomProviderFormat,
  CustomProviderUpsertRequest,
} from "../lib/customProviderTypes";
import { clearRawSupportedModelsCache } from "./inventory";

async function getProviderClient() {
  const client = await getClient();
  return client.goose;
}

export async function listCustomProviderCatalog(
  format?: CustomProviderFormat,
): Promise<ProviderTemplateCatalogEntryDto[]> {
  const client = await getProviderClient();
  const response = await client.GooseUnstableProvidersCatalogList(
    format ? { format } : {},
  );
  return response.providers;
}

export async function getCustomProviderTemplate(
  providerId: string,
): Promise<ProviderTemplateDto> {
  const client = await getProviderClient();
  const response = await client.GooseUnstableProvidersCatalogTemplate({
    providerId,
  });
  return response.template;
}

export async function createCustomProvider(
  input: CustomProviderUpsertRequest,
): Promise<CustomProviderCreateResponse> {
  const client = await getProviderClient();
  const response = await client.GooseUnstableProvidersCustomCreate(input);
  clearRawSupportedModelsCache([response.providerId]);
  return response;
}

export async function readCustomProvider(
  providerId: string,
): Promise<CustomProviderReadResponse> {
  const client = await getProviderClient();
  return client.GooseUnstableProvidersCustomRead({ providerId });
}

export async function updateCustomProvider(
  providerId: string,
  input: CustomProviderUpsertRequest,
): Promise<CustomProviderUpdateResponse> {
  const client = await getProviderClient();
  const response = await client.GooseUnstableProvidersCustomUpdate({
    ...input,
    providerId,
  });
  clearRawSupportedModelsCache([providerId]);
  return response;
}

export async function deleteCustomProvider(
  providerId: string,
): Promise<CustomProviderDeleteResponse> {
  const client = await getProviderClient();
  const response = await client.GooseUnstableProvidersCustomDelete({
    providerId,
  });
  clearRawSupportedModelsCache([providerId]);
  return response;
}
