import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  applyRuntimeProviderConfig,
  defaultModelInventoryModeForLoadResult,
} from "@/features/providers/runtimeProviderConfig";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import { rerunDoctorReport } from "@/shared/api/useDoctorReport";
import {
  DEFAULT_RUNTIME_CONFIG,
  runtimeConfigSchema,
} from "@/shared/runtime-config/schema";
import type {
  RuntimeConfig,
  RuntimeConfigLoadResult,
} from "@/shared/runtime-config/schema";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
import { SettingsRow } from "@/shared/ui/settings-row";

function runtimeConfigForDraft(result: RuntimeConfigLoadResult): RuntimeConfig {
  return result.status === "ready" ? result.config : DEFAULT_RUNTIME_CONFIG;
}

function formatRuntimeConfig(config: RuntimeConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function RuntimeConfigSettings() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const result = useRuntimeConfigStore((state) => state.result);
  const setFakeConfig = useRuntimeConfigStore((state) => state.setFakeConfig);
  const clearFakeConfig = useRuntimeConfigStore(
    (state) => state.clearFakeConfig,
  );
  const refreshConfig = useRuntimeConfigStore((state) => state.refresh);
  const [draft, setDraft] = useState(() =>
    formatRuntimeConfig(runtimeConfigForDraft(result)),
  );
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    "clear" | "refresh" | "save" | null
  >(null);

  useEffect(() => {
    setDraft(formatRuntimeConfig(runtimeConfigForDraft(result)));
    setError(null);
  }, [result]);

  const statusMessage =
    result.status === "ready"
      ? t("runtimeConfig.status.ready", { source: result.source })
      : t("runtimeConfig.status.unavailable", {
          reason: result.reason,
          message: result.message,
        });

  function refreshDoctorReport() {
    void rerunDoctorReport(queryClient).catch((doctorError) => {
      console.warn("Failed to refresh Doctor after runtime config change", {
        doctorError,
      });
    });
  }

  async function applyLiveRuntimeConfig(nextResult: RuntimeConfigLoadResult) {
    const runtimeConfig =
      nextResult.status === "ready"
        ? nextResult.config
        : useRuntimeConfigStore.getState().config;
    await Promise.all([
      applyRuntimeProviderConfig(runtimeConfig, {
        seedModelsFresh:
          nextResult.status === "ready" && nextResult.source === "fakeEndpoint",
        defaultModelInventoryMode:
          defaultModelInventoryModeForLoadResult(nextResult),
      }),
      useDistroStore.getState().refresh(),
    ]);
  }

  async function handleSave() {
    setPendingAction("save");
    try {
      const parsed = runtimeConfigSchema.parse(JSON.parse(draft));
      const nextResult = await setFakeConfig(parsed);
      if (nextResult.status !== "ready") {
        throw new Error(nextResult.message);
      }
      await applyLiveRuntimeConfig(nextResult);
      setError(null);
      refreshDoctorReport();
      toast.success(t("runtimeConfig.saveSuccess"));
    } catch (saveError) {
      const message = errorMessage(saveError);
      setError(message);
      toast.error(t("runtimeConfig.saveError"));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleClear() {
    setPendingAction("clear");
    try {
      const nextResult = await clearFakeConfig();
      await applyLiveRuntimeConfig(nextResult);
      setError(null);
      refreshDoctorReport();
      toast.success(t("runtimeConfig.clearSuccess"));
    } catch (clearError) {
      const message = errorMessage(clearError);
      setError(message);
      toast.error(t("runtimeConfig.clearError"));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRefresh() {
    setPendingAction("refresh");
    try {
      const nextResult = await refreshConfig();
      await applyLiveRuntimeConfig(nextResult);
      setError(null);
      refreshDoctorReport();
      toast.success(t("runtimeConfig.refreshSuccess"));
    } catch (refreshError) {
      const message = errorMessage(refreshError);
      setError(message);
      toast.error(t("runtimeConfig.refreshError"));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <SettingsRow
      layout="stacked"
      label={t("runtimeConfig.editorLabel")}
      description={statusMessage}
      action={
        <div className="space-y-3">
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void handleRefresh()}
              disabled={pendingAction !== null}
            >
              <RefreshCw className="size-3.5" />
              {pendingAction === "refresh"
                ? t("runtimeConfig.refreshing")
                : t("common:actions.refresh")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void handleClear()}
              disabled={pendingAction !== null}
            >
              <Trash2 className="size-3.5" />
              {pendingAction === "clear"
                ? t("runtimeConfig.clearing")
                : t("common:actions.clear")}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="xs"
              onClick={() => void handleSave()}
              disabled={pendingAction !== null}
            >
              <Save className="size-3.5" />
              {pendingAction === "save"
                ? t("runtimeConfig.saving")
                : t("common:actions.save")}
            </Button>
          </div>
          <label className="sr-only" htmlFor="fake-runtime-config-response">
            {t("runtimeConfig.jsonLabel")}
          </label>
          <Textarea
            id="fake-runtime-config-response"
            variant="code"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            aria-invalid={error ? true : undefined}
            className="min-h-64 resize-y"
            spellCheck={false}
          />
          {error ? (
            <p className="break-words text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
