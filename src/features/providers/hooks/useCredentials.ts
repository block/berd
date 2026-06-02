import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  getProviderConfig,
  saveProviderConfig,
  deleteProviderConfig,
  type ProviderStatus,
  checkAllProviderStatus,
} from "@/features/providers/api/credentials";
import type { ProviderConfigChangeResponseUnstable as ProviderConfigChangeResponse } from "@aaif/goose-sdk";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import type { ProviderFieldValue } from "@/shared/types/providers";

export interface ProviderFieldSave {
  key: string;
  value: string;
  isSecret: boolean;
}

interface UseCredentialsReturn {
  configuredIds: Set<string>;
  loading: boolean;
  saving: boolean;
  savingProviderIds: Set<string>;
  syncingProviderIds: Set<string>;
  modelWarnings: Map<string, string>;
  getConfig: (providerId: string) => Promise<ProviderFieldValue[]>;
  save: (providerId: string, fields: ProviderFieldSave[]) => Promise<void>;
  remove: (providerId: string) => Promise<void>;
  completeNativeSetup: (
    providerId: string,
    result?: ProviderConfigChangeResponse,
  ) => Promise<void>;
}

export function useCredentials(): UseCredentialsReturn {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingProviderIds, setSavingProviderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [syncingProviderIds, setSyncingProviderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [modelWarnings, setModelWarnings] = useState<Map<string, string>>(
    () => new Map(),
  );
  const modelRefreshRunIds = useRef(new Map<string, number>());

  const refreshStatuses = useCallback(async () => {
    const nextStatuses = await checkAllProviderStatus();
    setStatuses(nextStatuses);
    return nextStatuses;
  }, []);

  const updateProviderStatus = useCallback((status: ProviderStatus) => {
    setStatuses((current) => {
      const next = current.filter(
        (item) => item.providerId !== status.providerId,
      );
      next.push(status);
      return next;
    });
  }, []);

  useEffect(() => {
    refreshStatuses()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [refreshStatuses]);

  const configuredIds = useMemo(
    () =>
      new Set(statuses.filter((s) => s.isConfigured).map((s) => s.providerId)),
    [statuses],
  );
  const saving = savingProviderIds.size > 0;

  const getConfig = useCallback(async (providerId: string) => {
    return getProviderConfig(providerId);
  }, []);

  const setProviderSaving = useCallback(
    (providerId: string, isSaving: boolean) => {
      setSavingProviderIds((current) => {
        const next = new Set(current);
        if (isSaving) {
          next.add(providerId);
        } else {
          next.delete(providerId);
        }
        return next;
      });
    },
    [],
  );

  const setProviderSyncing = useCallback(
    (providerId: string, isSyncing: boolean) => {
      setSyncingProviderIds((current) => {
        const next = new Set(current);
        if (isSyncing) {
          next.add(providerId);
        } else {
          next.delete(providerId);
        }
        return next;
      });
    },
    [],
  );

  const setProviderModelWarning = useCallback(
    (providerId: string, warning: string | null) => {
      setModelWarnings((current) => {
        const next = new Map(current);
        if (warning) {
          next.set(providerId, warning);
        } else {
          next.delete(providerId);
        }
        return next;
      });
    },
    [],
  );

  const cancelProviderModelRefresh = useCallback(
    (providerId: string) => {
      modelRefreshRunIds.current.set(
        providerId,
        (modelRefreshRunIds.current.get(providerId) ?? 0) + 1,
      );
      setProviderSyncing(providerId, false);
      setProviderModelWarning(providerId, null);
    },
    [setProviderModelWarning, setProviderSyncing],
  );

  const refreshProviderModels = useCallback(
    (providerId: string) => {
      const runId = (modelRefreshRunIds.current.get(providerId) ?? 0) + 1;
      modelRefreshRunIds.current.set(providerId, runId);
      setProviderSyncing(providerId, true);
      setProviderModelWarning(providerId, null);
      void useProviderModelCacheStore
        .getState()
        .refreshProviderModels(providerId, { force: true })
        .then(() => {
          if (modelRefreshRunIds.current.get(providerId) !== runId) {
            return;
          }
          const error = useProviderModelCacheStore
            .getState()
            .getError(providerId);
          setProviderModelWarning(providerId, error);
        })
        .catch((error) => {
          if (modelRefreshRunIds.current.get(providerId) !== runId) {
            return;
          }
          setProviderModelWarning(providerId, formatAcpErrorMessage(error));
        })
        .finally(() => {
          if (modelRefreshRunIds.current.get(providerId) !== runId) {
            return;
          }
          setProviderSyncing(providerId, false);
        });
    },
    [setProviderModelWarning, setProviderSyncing],
  );

  const save = useCallback(
    async (providerId: string, fields: ProviderFieldSave[]) => {
      setProviderSaving(providerId, true);
      try {
        const result = await saveProviderConfig(
          providerId,
          fields.map(({ key, value }) => ({ key, value })),
        );
        updateProviderStatus(result.status);
        useProviderModelCacheStore.getState().invalidateProvider(providerId);
        refreshProviderModels(providerId);
      } finally {
        setProviderSaving(providerId, false);
      }
    },
    [refreshProviderModels, setProviderSaving, updateProviderStatus],
  );

  const remove = useCallback(
    async (providerId: string) => {
      setProviderSaving(providerId, true);
      try {
        const result = await deleteProviderConfig(providerId);
        updateProviderStatus(result.status);
        useProviderModelCacheStore.getState().invalidateProvider(providerId);
        cancelProviderModelRefresh(providerId);
      } finally {
        setProviderSaving(providerId, false);
      }
    },
    [cancelProviderModelRefresh, setProviderSaving, updateProviderStatus],
  );

  const completeNativeSetup = useCallback(
    async (providerId: string, result?: ProviderConfigChangeResponse) => {
      if (result) {
        updateProviderStatus(result.status);
      } else {
        await refreshStatuses();
      }
      useProviderModelCacheStore.getState().invalidateProvider(providerId);
      refreshProviderModels(providerId);
    },
    [refreshProviderModels, refreshStatuses, updateProviderStatus],
  );

  return {
    configuredIds,
    loading,
    saving,
    savingProviderIds,
    syncingProviderIds,
    modelWarnings,
    getConfig,
    save,
    remove,
    completeNativeSetup,
  };
}
