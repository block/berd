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
import type { ProviderType } from "@/shared/types/agents";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProviderInventory } from "@/features/providers/hooks/useProviderInventory";

export interface ProviderModelFieldsClasses {
  sectionGap?: string;
  fieldLabel?: string;
  selectTrigger?: string;
  statusMessage?: string;
}

export interface ProviderModelFieldsProps {
  provider: ProviderType | "";
  model: string;
  onProviderChange: (next: ProviderType | "") => void;
  onModelChange: (next: string) => void;
  isReadOnly?: boolean;
  /** When true, fields render side-by-side; otherwise stacked (rail). */
  gridLayout?: boolean;
  classes?: ProviderModelFieldsClasses;
}

export function ProviderModelFields({
  provider,
  model,
  onProviderChange,
  onModelChange,
  isReadOnly = false,
  gridLayout = false,
  classes,
}: ProviderModelFieldsProps) {
  const { t } = useTranslation(["agents", "common"]);
  const acpProviders = useAgentStore((s) => s.providers);
  const { getEntry, getModelsForAgent } = useProviderInventory();

  const availableModels = provider ? getModelsForAgent(provider) : [];
  const providerInventory = provider ? getEntry(provider) : undefined;
  const modelStatusMessage =
    providerInventory?.modelSelectionHint ??
    providerInventory?.lastRefreshError;
  const hasSavedModelOutsideInventory =
    Boolean(model) && !availableModels.some((entry) => entry.id === model);
  const modelSelectValue = hasSavedModelOutsideInventory
    ? `__saved__:${model}`
    : model || "__none__";

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
            const nextProvider =
              v === "__none__"
                ? ("" as ProviderType | "")
                : (v as ProviderType);
            onProviderChange(nextProvider);
            if (nextProvider !== provider) {
              onModelChange("");
            }
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
            <SelectValue placeholder={t("common:labels.none")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t("common:labels.none")}</SelectItem>
            {acpProviders.map((providerOption) => (
              <SelectItem key={providerOption.id} value={providerOption.id}>
                {providerOption.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className={classes?.sectionGap}>
        <Label className={classes?.fieldLabel}>{t("editor.model")}</Label>
        <Select
          value={modelSelectValue}
          onValueChange={(value: string) => {
            if (value === "__none__") {
              onModelChange("");
              return;
            }
            if (value.startsWith("__saved__:")) {
              onModelChange(value.slice("__saved__:".length));
              return;
            }
            onModelChange(value);
          }}
          disabled={isReadOnly || !provider}
        >
          <SelectTrigger
            className={cn(
              "w-full",
              classes?.selectTrigger,
              (isReadOnly || !provider) && "cursor-not-allowed opacity-70",
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
            <SelectItem value="__none__">{t("common:labels.none")}</SelectItem>
            {hasSavedModelOutsideInventory && (
              <SelectItem value={`__saved__:${model}`}>
                {t("editor.savedModelUnavailable", { model })}
              </SelectItem>
            )}
            {availableModels.map((modelOption) => (
              <SelectItem key={modelOption.id} value={modelOption.id}>
                {modelOption.displayName ?? modelOption.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasSavedModelOutsideInventory ? (
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
