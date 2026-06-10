import { useEffect, useMemo, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Spinner } from "@/shared/ui/spinner";
import {
  formatProviderLabel,
  getProviderIcon,
} from "@/shared/ui/icons/ProviderIcons";
import {
  resolveDisplayModelLabel,
  resolvePickerTriggerLabel,
} from "../lib/modelDisplayLabel";
import type { AgentPickerOption, ModelOption } from "../types";
import { AllModelsList, RecommendedModelList } from "./AgentModelPickerLists";
import { PickerItem } from "./AgentModelPickerItem";

interface AgentModelPickerProps {
  agents: AgentPickerOption[];
  selectedAgentId: string;
  onAgentChange: (agentId: string) => void;
  currentModelId?: string | null;
  currentModelProviderId?: string | null;
  currentModelName?: string | null;
  availableModels: ModelOption[];
  modelsLoading?: boolean;
  modelStatusMessage?: string | null;
  onModelChange?: (modelId: string, model?: ModelOption) => void;
  loading?: boolean;
  isCompact?: boolean;
  showSelectedModelInTrigger?: boolean;
  triggerTabIndex?: number;
  onOpen?: () => void;
  onOpenChange?: (open: boolean) => void;
}

type ModelView = "recommended" | "all";

export function AgentModelPicker({
  agents,
  selectedAgentId,
  onAgentChange,
  currentModelId = null,
  currentModelProviderId = null,
  currentModelName = null,
  availableModels,
  modelsLoading = false,
  modelStatusMessage = null,
  onModelChange,
  loading = false,
  isCompact = false,
  showSelectedModelInTrigger = true,
  triggerTabIndex,
  onOpen,
  onOpenChange,
}: AgentModelPickerProps) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [modelView, setModelView] = useState<ModelView>("recommended");
  const selectedAgentLabel =
    agents.find((agent) => agent.id === selectedAgentId)?.label ??
    formatProviderLabel(selectedAgentId);
  const displayModelLabel = resolveDisplayModelLabel({
    currentModelId,
    currentModelName,
    currentModelProviderId,
    availableModels,
  });
  const displayedModels = useMemo(() => {
    if (!currentModelId || !displayModelLabel) {
      return availableModels;
    }

    const hasCurrentModel = availableModels.some(
      (model) =>
        model.id === currentModelId &&
        (!currentModelProviderId ||
          !model.providerId ||
          model.providerId === currentModelProviderId),
    );
    if (hasCurrentModel) {
      return availableModels;
    }

    return [
      {
        id: currentModelId,
        name: displayModelLabel,
        displayName: displayModelLabel,
        providerId: currentModelProviderId ?? undefined,
        providerName: currentModelProviderId
          ? formatProviderLabel(currentModelProviderId)
          : undefined,
        recommended: true,
        featured: false,
      },
      ...availableModels,
    ];
  }, [
    availableModels,
    currentModelId,
    currentModelProviderId,
    displayModelLabel,
  ]);
  const triggerLabel = showSelectedModelInTrigger
    ? resolvePickerTriggerLabel({
        currentModelId,
        currentModelName,
        currentModelProviderId,
        availableModels: displayedModels,
        selectedAgentLabel,
      })
    : selectedAgentLabel;
  const triggerTitle =
    triggerLabel ?? (loading ? t("toolbar.loading") : undefined);

  const handleAgentSelect = (agent: AgentPickerOption) => {
    if (agent.readiness && agent.readiness !== "ready") {
      requestOpenSettings("providers");
      setOpen(false);
      return;
    }

    if (agent.id !== selectedAgentId) {
      onAgentChange(agent.id);
      setModelView("recommended");
    }
  };

  const handleModelSelect = (model: ModelOption) => {
    onModelChange?.(model.id, model);
    setOpen(false);
  };

  // Reset to recommended view when popover closes.
  useEffect(() => {
    if (!open) {
      setModelView("recommended");
    }
  }, [open]);

  // When in "all" view, expand the popover to full width for the search experience.
  const isAllView = modelView === "all";

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
        if (nextOpen) onOpen?.();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="composer-action"
          size="sm"
          aria-label={t("toolbar.chooseAgentModel")}
          title={triggerTitle}
          tabIndex={triggerTabIndex}
          disabled={loading && !selectedAgentLabel}
          leftIcon={getProviderIcon(selectedAgentId, "size-4")}
          rightIcon={<IconChevronDown className="opacity-50" />}
          className="chat-composer-selector-trigger min-w-0 max-w-full"
        >
          <span
            className={cn(
              "chat-composer-selector-label truncate",
              isCompact ? "max-w-32" : "max-w-56",
            )}
          >
            {triggerLabel ?? (loading ? t("toolbar.loading") : null)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        className="h-[min(24rem,50vh)] w-96 overflow-hidden p-1"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          contentRef.current
            ?.querySelector<HTMLElement>(
              '[data-col="agent"] button[data-selected]',
            )
            ?.focus();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const col = (document.activeElement as HTMLElement)?.closest(
              "[data-col]",
            );
            if (!col) return;
            const items = Array.from(
              col.querySelectorAll<HTMLElement>("button:not(:disabled)"),
            );
            const idx = items.indexOf(document.activeElement as HTMLElement);
            const next =
              e.key === "ArrowDown"
                ? items[(idx + 1) % items.length]
                : items[(idx - 1 + items.length) % items.length];
            next?.focus();
          } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const content = e.currentTarget as HTMLElement;
            const cols = Array.from(
              content.querySelectorAll<HTMLElement>("[data-col]"),
            );
            const currentCol = (document.activeElement as HTMLElement)?.closest(
              "[data-col]",
            );
            const colIdx = cols.indexOf(currentCol as HTMLElement);
            const targetCol =
              e.key === "ArrowRight"
                ? cols[(colIdx + 1) % cols.length]
                : cols[(colIdx - 1 + cols.length) % cols.length];
            if (!targetCol) return;
            const targetItems = Array.from(
              targetCol.querySelectorAll<HTMLElement>("button:not(:disabled)"),
            );
            const currentItems = Array.from(
              currentCol?.querySelectorAll<HTMLElement>(
                "button:not(:disabled)",
              ) ?? [],
            );
            const currentIdx = currentItems.indexOf(
              document.activeElement as HTMLElement,
            );
            const target =
              targetItems[Math.min(currentIdx, targetItems.length - 1)] ??
              targetItems[0];
            target?.focus();
          }
        }}
      >
        <div
          className={cn(
            "grid h-full gap-1 overflow-hidden",
            isAllView
              ? "grid-cols-1"
              : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
          )}
        >
          {/* Agent column — hidden in "all models" search view */}
          {!isAllView ? (
            <div
              data-col="agent"
              className="flex min-h-0 min-w-0 overflow-hidden p-1"
            >
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="shrink-0 px-2 py-1.5 text-sm font-semibold">
                  {t("toolbar.agent")}
                </div>
                <ScrollArea className="min-h-0 min-w-0 flex-1">
                  <div className="space-y-0.5 p-1">
                    {agents.map((agent) => {
                      const isSelected = agent.id === selectedAgentId;
                      const isReady =
                        !agent.readiness || agent.readiness === "ready";
                      const setupLabel =
                        agent.setupAction === "install"
                          ? t("toolbar.install")
                          : t("toolbar.connect");
                      const agentIcon = getProviderIcon(agent.id, "size-4");

                      return (
                        <PickerItem
                          key={agent.id}
                          onClick={() => handleAgentSelect(agent)}
                          selected={isSelected}
                          data-selected={isSelected || undefined}
                          className={cn(
                            "group justify-between",
                            !isReady &&
                              "opacity-40 hover:opacity-100 focus-visible:opacity-100",
                          )}
                        >
                          {agentIcon ? (
                            <span className="shrink-0">{agentIcon}</span>
                          ) : null}
                          <span className="min-w-0 flex-1 truncate">
                            {agent.label}
                          </span>
                          {isSelected ? (
                            <IconCheck className="size-4 shrink-0 text-muted-foreground" />
                          ) : !isReady ? (
                            <Button
                              asChild
                              variant="outline"
                              size="xxs"
                              className="pointer-events-none shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                            >
                              <span>{setupLabel}</span>
                            </Button>
                          ) : null}
                        </PickerItem>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>
            </div>
          ) : null}

          {/* Model column */}
          <div
            data-col="model"
            className="flex min-h-0 min-w-0 overflow-hidden p-1"
          >
            {modelsLoading ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="shrink-0 px-2 py-1.5 text-sm font-semibold">
                  {t("toolbar.model")}
                </div>
                {displayModelLabel ? (
                  <div className="space-y-0.5 p-1">
                    <PickerItem selected disabled>
                      <div className="min-w-0 flex-1 truncate">
                        {displayModelLabel}
                      </div>
                      <Spinner className="size-3.5 shrink-0" />
                    </PickerItem>
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                    <Spinner className="size-4" />
                    <span>{t("toolbar.loadingModels")}</span>
                  </div>
                )}
              </div>
            ) : displayedModels.length > 0 ? (
              modelView === "recommended" ? (
                <RecommendedModelList
                  models={displayedModels}
                  currentModelId={currentModelId}
                  currentModelProviderId={currentModelProviderId}
                  selectedAgentId={selectedAgentId}
                  onModelSelect={handleModelSelect}
                  onShowAll={() => setModelView("all")}
                  t={t}
                />
              ) : (
                <AllModelsList
                  models={displayedModels}
                  currentModelId={currentModelId}
                  currentModelProviderId={currentModelProviderId}
                  selectedAgentId={selectedAgentId}
                  onModelSelect={handleModelSelect}
                  onBack={() => setModelView("recommended")}
                  t={t}
                />
              )
            ) : (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="shrink-0 px-2 py-1.5 text-sm font-semibold">
                  {t("toolbar.model")}
                </div>
                <div className="px-2 py-2">
                  <div className="text-sm text-muted-foreground">
                    {modelStatusMessage ??
                      displayModelLabel ??
                      t("toolbar.noModelsAvailable")}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
