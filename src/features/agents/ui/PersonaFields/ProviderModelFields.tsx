import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { Label } from "@/shared/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Button } from "@/shared/ui/button";
import type { ProviderType } from "@/shared/types/agents";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import { useProviderModels } from "@/features/providers/hooks/useProviderModels";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";

export interface ProviderModelFieldsClasses {
  sectionGap?: string;
  fieldLabel?: string;
  selectTrigger?: string;
  statusMessage?: string;
}

interface ProviderModelSelection {
  modelId: string;
  modelProviderId: string;
}

function modelOptionValue(modelId: string, providerId: string): string {
  return JSON.stringify([providerId, modelId]);
}

export interface ProviderModelFieldsProps {
  provider: ProviderType | "";
  modelProviderId?: string;
  model: string;
  onProviderChange: (next: ProviderType | "") => void;
  onModelChange: (selection: ProviderModelSelection | null) => void;
  builderSessionId?: string;
  isReadOnly?: boolean;
  /** When true, fields render side-by-side; otherwise stacked (rail). */
  gridLayout?: boolean;
  classes?: ProviderModelFieldsClasses;
}

export function ProviderModelFields({
  provider,
  modelProviderId,
  model,
  onProviderChange,
  onModelChange,
  builderSessionId,
  isReadOnly = false,
  gridLayout = false,
  classes,
}: ProviderModelFieldsProps) {
  const { t } = useTranslation(["agents", "common"]);
  const acpProviders = useAgentStore((s) => s.providers);
  const { getModelsForAgent, getError } = useProviderModels();
  const { agentReadiness } = useAgentProviderStatus();

  const availableModels = provider ? getModelsForAgent(provider) : [];
  const modelStatusMessage = provider ? getError(provider) : null;
  const selectedProviderReadiness = provider
    ? (agentReadiness.get(provider) ?? "not_ready")
    : "ready";
  const isSelectedProviderReady = selectedProviderReadiness === "ready";
  const selectedModel = availableModels.find(
    (entry) =>
      entry.id === model &&
      (!modelProviderId ||
        !entry.providerId ||
        entry.providerId === modelProviderId),
  );
  const hasSavedModelOutsideInventory = Boolean(model) && !selectedModel;
  let modelSelectValue = "__none__";
  if (selectedModel) {
    modelSelectValue = modelOptionValue(
      selectedModel.id,
      selectedModel.providerId ?? provider,
    );
  } else if (hasSavedModelOutsideInventory) {
    modelSelectValue = `__saved__:${model}`;
  }
  const getProviderSetupLabel = (
    readiness: "ready" | "not_installed" | "not_ready",
  ) =>
    readiness === "not_installed"
      ? t("editor.installProvider")
      : t("editor.connectProvider");

  const containerClass = gridLayout
    ? "grid grid-cols-1 gap-4 sm:grid-cols-2"
    : "flex flex-col gap-4";

  return (
    <div className={containerClass}>
      <div className={classes?.sectionGap}>
        <Label className={classes?.fieldLabel}>{t("editor.provider")}</Label>
        <Select
          value={provider || "__none__"}
          onValueChange={(v: string) => {
            if (v !== "__none__") {
              const readiness = agentReadiness.get(v) ?? "not_ready";
              if (readiness !== "ready") {
                requestOpenSettings("providers", {
                  returnTarget: builderSessionId
                    ? {
                        type: "agent-builder-provider-setup",
                        sessionId: builderSessionId,
                        providerId: v,
                      }
                    : undefined,
                });
                return;
              }
            }

            const nextProvider =
              v === "__none__"
                ? ("" as ProviderType | "")
                : (v as ProviderType);
            onProviderChange(nextProvider);
          }}
          disabled={isReadOnly}
        >
          <SelectTrigger
            className={cn(
              "w-full",
              classes?.selectTrigger,
              isReadOnly && "cursor-not-allowed opacity-70",
            )}
          >
            <SelectValue placeholder={t("common:labels.default")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">
              {t("common:labels.default")}
            </SelectItem>
            {acpProviders.map((providerOption) => {
              const readiness =
                agentReadiness.get(providerOption.id) ?? "not_ready";
              const isReady = readiness === "ready";

              return (
                <SelectItem
                  key={providerOption.id}
                  value={providerOption.id}
                  aria-disabled={!isReady}
                  className={cn(
                    "group",
                    !isReady &&
                      "cursor-default text-muted-foreground opacity-40 hover:opacity-100 data-[highlighted]:opacity-100",
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-2 pr-5">
                    <span className="min-w-0 truncate">
                      {providerOption.label}
                    </span>
                    {!isReady ? (
                      <Button
                        asChild
                        variant="outline"
                        size="xxs"
                        className="pointer-events-none shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-data-[highlighted]:opacity-100"
                      >
                        <span>{getProviderSetupLabel(readiness)}</span>
                      </Button>
                    ) : null}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      <div className={classes?.sectionGap}>
        <Label className={classes?.fieldLabel}>{t("editor.model")}</Label>
        <Select
          value={modelSelectValue}
          onValueChange={(value: string) => {
            if (value === "__none__") {
              onModelChange(null);
              return;
            }
            if (value.startsWith("__saved__:")) {
              if (modelProviderId) {
                onModelChange({
                  modelId: value.slice("__saved__:".length),
                  modelProviderId,
                });
              }
              return;
            }
            const selected = availableModels.find(
              (entry) =>
                modelOptionValue(entry.id, entry.providerId ?? provider) ===
                value,
            );
            if (selected) {
              onModelChange({
                modelId: selected.id,
                modelProviderId: selected.providerId ?? provider,
              });
            }
          }}
          disabled={isReadOnly || !provider || !isSelectedProviderReady}
        >
          <SelectTrigger
            className={cn(
              "w-full",
              classes?.selectTrigger,
              (isReadOnly || !provider || !isSelectedProviderReady) &&
                "cursor-not-allowed opacity-70",
            )}
          >
            <SelectValue
              placeholder={
                provider
                  ? t("editor.modelPlaceholder")
                  : t("editor.chooseProviderFirst")
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">
              {t("common:labels.default")}
            </SelectItem>
            {hasSavedModelOutsideInventory && (
              <SelectItem value={`__saved__:${model}`}>
                {t("editor.savedModelUnavailable", { model })}
              </SelectItem>
            )}
            {availableModels.map((modelOption) => (
              <SelectItem
                key={`${modelOption.providerId ?? provider}:${modelOption.id}`}
                value={modelOptionValue(
                  modelOption.id,
                  modelOption.providerId ?? provider,
                )}
              >
                {modelOption.displayName ?? modelOption.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!isSelectedProviderReady ? (
          <p
            className={cn(
              "text-[11px] text-muted-foreground",
              classes?.statusMessage,
            )}
          >
            {t("editor.providerNotConnected")}{" "}
            <button
              type="button"
              className="inline underline hover:text-foreground"
              onClick={() =>
                requestOpenSettings("providers", {
                  returnTarget: builderSessionId
                    ? {
                        type: "agent-builder-provider-setup",
                        sessionId: builderSessionId,
                        providerId: provider,
                      }
                    : undefined,
                })
              }
            >
              {t("editor.openProviderSettings")}
            </button>
          </p>
        ) : hasSavedModelOutsideInventory ? (
          <p
            className={cn(
              "text-[11px] text-muted-foreground",
              classes?.statusMessage,
            )}
          >
            {t("editor.savedModelUnavailableHelp")}
          </p>
        ) : !provider ? null : availableModels.length === 0 ? (
          <p
            className={cn(
              "text-[11px] text-muted-foreground",
              classes?.statusMessage,
            )}
          >
            {modelStatusMessage ?? t("editor.noModelsAvailable")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
