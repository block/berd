import { useCallback, useMemo, useRef, useState } from "react";
import type { ProviderConfigStatusDto } from "@aaif/goose-sdk";
import {
  createCustomProvider,
  deleteCustomProvider,
  getCustomProviderTemplate,
  listCustomProviderCatalog,
  readCustomProvider,
  updateCustomProvider,
} from "@/features/providers/api/customProviders";
import { customProviderDraftToUpsertRequest } from "@/features/providers/lib/customProviderDraft";
import {
  assertValidCustomProviderDraft,
  type CustomProviderValidationOptions,
} from "@/features/providers/lib/customProviderValidation";
import type {
  CustomProviderCreateResponse,
  CustomProviderDeleteResponse,
  CustomProviderDraft,
  CustomProviderFormat,
  CustomProviderReadResponse,
  CustomProviderUpdateResponse,
  CustomProviderUpsertRequest,
  ProviderTemplateCatalogEntryDto,
  ProviderTemplateDto,
} from "@/features/providers/lib/customProviderTypes";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

interface SaveDraftOptions extends CustomProviderValidationOptions {
  providerId?: string;
}

interface UseCustomProvidersReturn {
  catalog: ProviderTemplateCatalogEntryDto[];
  catalogLoading: boolean;
  saving: boolean;
  loadCatalog: (
    format?: CustomProviderFormat,
  ) => Promise<ProviderTemplateCatalogEntryDto[]>;
  getTemplate: (providerId: string) => Promise<ProviderTemplateDto>;
  read: (providerId: string) => Promise<CustomProviderReadResponse>;
  create: (
    input: CustomProviderUpsertRequest,
  ) => Promise<CustomProviderCreateResponse>;
  update: (
    providerId: string,
    input: CustomProviderUpsertRequest,
  ) => Promise<CustomProviderUpdateResponse>;
  remove: (providerId: string) => Promise<CustomProviderDeleteResponse>;
  saveDraft: (
    draft: CustomProviderDraft,
    options?: SaveDraftOptions,
  ) => Promise<CustomProviderCreateResponse | CustomProviderUpdateResponse>;
  statusByProviderId: Map<string, ProviderConfigStatusDto>;
}

function customProviderCatalogEntry(input: {
  providerId: string;
  displayName: string;
  description?: string;
}): ProviderCatalogEntry {
  return {
    id: input.providerId,
    displayName: input.displayName,
    category: "model",
    description: input.description ?? "Custom model provider",
    setupMethod: "config_fields",
    group: "additional",
    customProvider: true,
    catalogSource: "custom",
    supportsInstall: false,
    supportsAuth: false,
    supportsAuthStatus: false,
  };
}

function mergeCustomProviderIntoCatalog(input: {
  providerId: string;
  displayName: string;
  description?: string;
}) {
  useProviderCatalogStore
    .getState()
    .mergeEntries([customProviderCatalogEntry(input)]);
}

function removeCustomProviderFromCatalog(providerId: string) {
  useProviderCatalogStore.getState().removeEntries([providerId]);
}

// User-driven custom provider CRUD, restored from the pre-#291 flow and
// adapted to the current model-cache design: after a create/update the
// provider's live model list is refreshed through providerModelCacheStore
// (the same post-save verification path useCredentials runs for built-in
// providers); the old providerInventoryStore no longer exists.
export function useCustomProviders(): UseCustomProvidersReturn {
  const catalogRequestIdRef = useRef(0);
  const [catalog, setCatalog] = useState<ProviderTemplateCatalogEntryDto[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [pendingOperations, setPendingOperations] = useState(0);
  const [statusByProviderId, setStatusByProviderId] = useState<
    Map<string, ProviderConfigStatusDto>
  >(() => new Map());

  const saving = pendingOperations > 0;

  const updateStatus = useCallback((status: ProviderConfigStatusDto) => {
    setStatusByProviderId((current) => {
      const next = new Map(current);
      next.set(status.providerId, status);
      return next;
    });
  }, []);

  const trackOperation = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      setPendingOperations((count) => count + 1);
      try {
        return await operation();
      } finally {
        setPendingOperations((count) => count - 1);
      }
    },
    [],
  );

  const refreshModels = useCallback((providerId: string) => {
    void useProviderModelCacheStore
      .getState()
      .refreshProviderModels(providerId, { force: true })
      .catch((error) => {
        console.warn(
          `Custom provider ${providerId} model refresh failed:`,
          formatAcpErrorMessage(error),
        );
      });
  }, []);

  const loadCatalog = useCallback(async (format?: CustomProviderFormat) => {
    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    setCatalogLoading(true);
    try {
      const nextCatalog = await listCustomProviderCatalog(format);
      if (catalogRequestIdRef.current === requestId) {
        setCatalog(nextCatalog);
      }
      return nextCatalog;
    } finally {
      if (catalogRequestIdRef.current === requestId) {
        setCatalogLoading(false);
      }
    }
  }, []);

  const getTemplate = useCallback(async (providerId: string) => {
    return getCustomProviderTemplate(providerId);
  }, []);

  const read = useCallback(
    async (providerId: string) => {
      const result = await readCustomProvider(providerId);
      mergeCustomProviderIntoCatalog({
        providerId: result.provider.providerId,
        displayName: result.provider.displayName,
      });
      updateStatus(result.status);
      return result;
    },
    [updateStatus],
  );

  const create = useCallback(
    async (input: CustomProviderUpsertRequest) =>
      trackOperation(async () => {
        const result = await createCustomProvider(input);
        mergeCustomProviderIntoCatalog({
          providerId: result.providerId,
          displayName: input.displayName,
        });
        updateStatus(result.status);
        refreshModels(result.providerId);
        return result;
      }),
    [refreshModels, trackOperation, updateStatus],
  );

  const update = useCallback(
    async (providerId: string, input: CustomProviderUpsertRequest) =>
      trackOperation(async () => {
        const result = await updateCustomProvider(providerId, input);
        mergeCustomProviderIntoCatalog({
          providerId,
          displayName: input.displayName,
        });
        updateStatus(result.status);
        refreshModels(providerId);
        return result;
      }),
    [refreshModels, trackOperation, updateStatus],
  );

  const remove = useCallback(
    async (providerId: string) =>
      trackOperation(async () => {
        const result = await deleteCustomProvider(providerId);
        removeCustomProviderFromCatalog(providerId);
        setStatusByProviderId((current) => {
          const next = new Map(current);
          next.delete(providerId);
          return next;
        });
        return result;
      }),
    [trackOperation],
  );

  const saveDraft = useCallback(
    async (draft: CustomProviderDraft, options: SaveDraftOptions = {}) => {
      const { providerId, ...validationOptions } = options;
      assertValidCustomProviderDraft(draft, validationOptions);
      const request = customProviderDraftToUpsertRequest(draft);
      return providerId ? update(providerId, request) : create(request);
    },
    [create, update],
  );

  return useMemo(
    () => ({
      catalog,
      catalogLoading,
      saving,
      loadCatalog,
      getTemplate,
      read,
      create,
      update,
      remove,
      saveDraft,
      statusByProviderId,
    }),
    [
      catalog,
      catalogLoading,
      saving,
      loadCatalog,
      getTemplate,
      read,
      create,
      update,
      remove,
      saveDraft,
      statusByProviderId,
    ],
  );
}
