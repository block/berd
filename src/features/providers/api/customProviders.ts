import type {
  CustomProviderConfigDto,
  CustomProviderCreateRequestUnstable,
  CustomProviderCreateResponseUnstable as CustomProviderCreateResponse,
  CustomProviderDeleteResponseUnstable as CustomProviderDeleteResponse,
  CustomProviderReadResponseUnstable as CustomProviderReadResponse,
  CustomProviderUpdateRequestUnstable,
  CustomProviderUpdateResponseUnstable as CustomProviderUpdateResponse,
  ProviderTemplateCatalogEntryDto,
  ProviderTemplateDto,
} from "@aaif/goose-sdk";
import { getClient } from "@/shared/api/acpConnection";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import type {
  CustomProviderFormat,
  CustomProviderUpsertRequest,
} from "@/features/providers/lib/customProviderTypes";
import type {
  RuntimeConfig,
  RuntimeCustomProvider,
  RuntimeGooseModelProvider,
} from "@/shared/runtime-config/schema";

const NOT_FOUND_PATTERN = /not\s*found|unknown[-_\s]*provider|\b404\b/i;

type CustomProviderWriteRequest = CustomProviderCreateRequestUnstable &
  CustomProviderUpdateRequestUnstable;

function toCustomProviderCreateRequest(
  provider: RuntimeCustomProvider,
): CustomProviderCreateRequestUnstable {
  return {
    catalogProviderId: provider.providerId,
    engine: provider.engine,
    displayName: provider.displayName,
    apiUrl: provider.apiUrl,
    ...(provider.basePath !== undefined ? { basePath: provider.basePath } : {}),
    ...(provider.models !== undefined ? { models: provider.models } : {}),
    requiresAuth: provider.requiresAuth,
    ...(provider.supportsStreaming !== undefined
      ? { supportsStreaming: provider.supportsStreaming }
      : {}),
    ...(provider.preservesThinking !== undefined
      ? { preservesThinking: provider.preservesThinking }
      : {}),
    ...(provider.headers !== undefined ? { headers: provider.headers } : {}),
  };
}

function toCustomProviderUpdateRequest(
  provider: RuntimeCustomProvider,
): CustomProviderWriteRequest {
  return {
    providerId: provider.providerId,
    ...toCustomProviderCreateRequest(provider),
  };
}

function normalizedHeaders(headers: Record<string, string> | undefined) {
  return new Map(
    Object.entries(headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
}

function sameStringSet(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const normalizedLeft = new Set((left ?? []).map((value) => value.trim()));
  const normalizedRight = new Set((right ?? []).map((value) => value.trim()));
  return (
    normalizedLeft.size === normalizedRight.size &&
    [...normalizedLeft].every((value) => normalizedRight.has(value))
  );
}

function sameHeaders(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const normalizedLeft = normalizedHeaders(left);
  const normalizedRight = normalizedHeaders(right);
  const keys = new Set([...normalizedLeft.keys(), ...normalizedRight.keys()]);
  for (const key of keys) {
    if (normalizedLeft.get(key) !== normalizedRight.get(key)) {
      return false;
    }
  }
  return true;
}

function sameOptionalBool(
  left: boolean | null | undefined,
  right: boolean | null | undefined,
  defaultValue?: boolean,
): boolean {
  return (left ?? defaultValue) === (right ?? defaultValue);
}

function providerNeedsUpdate(
  existing: CustomProviderConfigDto,
  desired: RuntimeCustomProvider,
): boolean {
  return (
    (existing.catalogProviderId ?? undefined) !== desired.providerId ||
    existing.engine !== desired.engine ||
    existing.displayName !== desired.displayName ||
    existing.apiUrl !== desired.apiUrl ||
    (existing.basePath ?? undefined) !== desired.basePath ||
    !sameStringSet(existing.models, desired.models) ||
    existing.requiresAuth !== desired.requiresAuth ||
    !sameOptionalBool(existing.supportsStreaming, desired.supportsStreaming) ||
    !sameOptionalBool(
      existing.preservesThinking,
      desired.preservesThinking,
      false,
    ) ||
    !sameHeaders(existing.headers, desired.headers)
  );
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const maybeStatus = "status" in error ? error.status : undefined;
    const maybeStatusCode =
      "statusCode" in error ? error.statusCode : undefined;
    const maybeCode = "code" in error ? error.code : undefined;
    if (maybeStatus === 404 || maybeStatusCode === 404) {
      return true;
    }
    if (
      typeof maybeCode === "string" &&
      /not[_-]?found|unknown[_-]?provider/i.test(maybeCode)
    ) {
      return true;
    }
  }
  if (error instanceof Error) {
    const data = "data" in error ? String(error.data) : "";
    return NOT_FOUND_PATTERN.test(`${error.message} ${data}`);
  }
  return NOT_FOUND_PATTERN.test(String(error));
}

export async function syncRuntimeCustomProvider(
  provider: RuntimeGooseModelProvider,
): Promise<void> {
  if (!provider.customProvider) {
    return;
  }

  const client = await getClient();
  const desired = provider.customProvider;
  const updateRequest = toCustomProviderUpdateRequest(desired);

  try {
    const existing = await client.goose.GooseUnstableProvidersCustomRead({
      providerId: desired.providerId,
    });
    if (!providerNeedsUpdate(existing.provider, desired)) {
      return;
    }
    await client.goose.GooseUnstableProvidersCustomUpdate(updateRequest);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    const created = await client.goose.GooseUnstableProvidersCustomCreate(
      toCustomProviderCreateRequest(desired),
    );
    if (created.providerId !== desired.providerId) {
      throw new Error(
        `Runtime custom provider created as '${created.providerId}', but runtime config expects '${desired.providerId}'. Use '${created.providerId}' as the runtime provider id.`,
      );
    }
  }
}

export async function syncRuntimeCustomProviders(
  config: RuntimeConfig,
): Promise<void> {
  for (const provider of config.goose.modelProviders) {
    await syncRuntimeCustomProvider(provider);
  }
}

// --- User-driven custom provider CRUD + template catalog ------------------
// Restored from the pre-#291 provider flow, adapted to the current
// providerModelCacheStore (the old inventory cache no longer exists).

function invalidateProviderModels(providerId: string) {
  useProviderModelCacheStore.getState().invalidateProvider(providerId);
}

export interface CustomProviderSummary {
  providerId: string;
  displayName: string;
  description?: string;
  configured: boolean;
  modelCount: number;
}

/**
 * List the user's existing custom providers from the live provider
 * inventory (entries with providerType "Custom").
 */
export async function listCustomProviders(): Promise<CustomProviderSummary[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersList({});
  return response.entries
    .filter((entry) => entry.providerType === "Custom")
    .map((entry) => ({
      providerId: entry.providerId,
      displayName: entry.providerName,
      description: entry.description || undefined,
      configured: entry.configured,
      modelCount: entry.models.length,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function listCustomProviderCatalog(
  format?: CustomProviderFormat,
): Promise<ProviderTemplateCatalogEntryDto[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersCatalogList(
    format ? { format } : {},
  );
  return response.providers;
}

export async function getCustomProviderTemplate(
  providerId: string,
): Promise<ProviderTemplateDto> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersCatalogTemplate({
    providerId,
  });
  return response.template;
}

export async function createCustomProvider(
  input: CustomProviderUpsertRequest,
): Promise<CustomProviderCreateResponse> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersCustomCreate(input);
  invalidateProviderModels(response.providerId);
  return response;
}

export async function readCustomProvider(
  providerId: string,
): Promise<CustomProviderReadResponse> {
  const client = await getClient();
  return client.goose.GooseUnstableProvidersCustomRead({ providerId });
}

export async function updateCustomProvider(
  providerId: string,
  input: CustomProviderUpsertRequest,
): Promise<CustomProviderUpdateResponse> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersCustomUpdate({
    ...input,
    providerId,
  });
  invalidateProviderModels(providerId);
  return response;
}

export async function deleteCustomProvider(
  providerId: string,
): Promise<CustomProviderDeleteResponse> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableProvidersCustomDelete({
    providerId,
  });
  invalidateProviderModels(providerId);
  return response;
}
