import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { IconAiAgents, IconCheck, IconChevronDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { cn } from "@/shared/lib/cn";
import {
  logReasoningEffortInfo,
  reasoningEffortConfigLogFields,
} from "@/shared/lib/reasoningEffortDiagnostics";
import { Button } from "@/shared/ui/button";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  formatProviderLabel,
  getProviderIcon,
} from "@/shared/ui/icons/ProviderIcons";
import {
  resolveDisplayModelLabel,
  resolvePickerTriggerLabel,
} from "../lib/modelDisplayLabel";
import type {
  AgentPickerOption,
  ChatInputReasoningEffort,
  ModelOption,
} from "../types";
import {
  RecommendedModelList,
  type RecommendedModelListHandle,
} from "./AgentModelPickerLists";
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
  triggerIconOnly?: boolean;
  onOpen?: () => void;
  onOpenChange?: (open: boolean) => void;
  reasoningEffort?: ChatInputReasoningEffort;
  contentAlign?: PopoverContentAlign | "smart";
  contentCollisionPadding?: number;
}

type ReasoningEffortConfig = NonNullable<ChatInputReasoningEffort["config"]>;
type PopoverContentAlign = NonNullable<
  ComponentProps<typeof PopoverContent>["align"]
>;
const REASONING_EFFORT_COLUMN_TRANSITION_MS = 240;
const PICKER_WIDTH_COMPACT_PX = 420;
const PICKER_WIDTH_EXPANDED_PX = 596;

function toSentenceCaseLabel(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = /^[a-z0-9_-]+$/.test(trimmed)
    ? trimmed.replace(/[_-]+/g, " ")
    : trimmed;

  if (/[A-Z]{2,}/.test(normalized)) {
    return normalized;
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function isReasoningEffortOff(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "off";
}

function ReasoningEffortList({
  config,
  disabled = false,
  onChange,
  t,
}: {
  config: ReasoningEffortConfig;
  disabled?: boolean;
  onChange?: (value: string) => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-busy={disabled}>
      <div className="shrink-0 px-2 py-1.5 text-sm font-semibold">
        {t("toolbar.reasoningEffort")}
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="space-y-0.5 p-1">
          {config.options.map((option) => {
            const isSelected = option.id === config.currentValue;
            return (
              <PickerItem
                key={option.id}
                onClick={() => {
                  if (!disabled) {
                    onChange?.(option.id);
                  }
                }}
                selected={isSelected}
                aria-disabled={disabled}
                tabIndex={disabled ? -1 : undefined}
                className={cn(
                  "justify-between transition-[background-color,color] duration-150 ease-[cubic-bezier(0.2,0,0,1)]",
                  disabled &&
                    "pointer-events-none text-muted-foreground hover:bg-transparent focus-visible:bg-transparent",
                )}
              >
                <span className="min-w-0 flex-1 truncate transition-colors duration-150 ease-[cubic-bezier(0.2,0,0,1)]">
                  {toSentenceCaseLabel(option.name ?? option.id)}
                </span>
                {isSelected ? (
                  <IconCheck
                    className={cn(
                      "size-4 shrink-0 transition-colors duration-150 ease-[cubic-bezier(0.2,0,0,1)]",
                      disabled
                        ? "text-muted-foreground/70"
                        : "text-muted-foreground",
                    )}
                  />
                ) : null}
              </PickerItem>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

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
  triggerIconOnly = false,
  onOpen,
  onOpenChange,
  reasoningEffort,
  contentAlign = "start",
  contentCollisionPadding = 16,
}: AgentModelPickerProps) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<RecommendedModelListHandle>(null);
  const [resolvedContentAlign, setResolvedContentAlign] =
    useState<PopoverContentAlign>("start");
  const [latchedReasoningEffortConfig, setLatchedReasoningEffortConfig] =
    useState<ReasoningEffortConfig | null>(null);
  const [previousLatchInputs, setPreviousLatchInputs] = useState<{
    open: boolean;
    hasLive: boolean;
    config: ReasoningEffortConfig | undefined;
  }>({ open: false, hasLive: false, config: undefined });
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
  const triggerButtonSize = triggerIconOnly ? "icon-pill-sm" : "sm";
  const triggerProviderIcon =
    getProviderIcon(selectedAgentId, "size-4") ??
    (triggerIconOnly ? <IconAiAgents className="size-4" /> : null);
  const reasoningEffortConfig = reasoningEffort?.config;
  const hasLiveReasoningEffort =
    Boolean(reasoningEffortConfig?.configId) &&
    (reasoningEffortConfig?.options.length ?? 0) > 1;
  // Latch (or release) the reasoning-effort config inline as its live inputs
  // change, instead of in an effect, so the picker never paints a stale column.
  // The transient transition-clear (open with no live config) stays in the
  // effect below because it is a timer, not a synchronous state adjustment.
  if (
    previousLatchInputs.open !== open ||
    previousLatchInputs.hasLive !== hasLiveReasoningEffort ||
    previousLatchInputs.config !== reasoningEffortConfig
  ) {
    setPreviousLatchInputs({
      open,
      hasLive: hasLiveReasoningEffort,
      config: reasoningEffortConfig,
    });
    if (hasLiveReasoningEffort && reasoningEffortConfig) {
      setLatchedReasoningEffortConfig(reasoningEffortConfig);
    } else if (!open) {
      setLatchedReasoningEffortConfig(null);
    }
  }
  const isReasoningEffortPending =
    open && !reasoningEffortConfig && Boolean(latchedReasoningEffortConfig);
  const displayReasoningEffortConfig =
    reasoningEffortConfig ?? latchedReasoningEffortConfig;
  const selectedReasoningEffort = displayReasoningEffortConfig?.options.find(
    (option) => option.id === displayReasoningEffortConfig.currentValue,
  );
  const selectedReasoningEffortValue =
    selectedReasoningEffort?.id ?? displayReasoningEffortConfig?.currentValue;
  const selectedReasoningEffortLabel = isReasoningEffortOff(
    selectedReasoningEffortValue,
  )
    ? null
    : toSentenceCaseLabel(
        selectedReasoningEffort?.name ??
          displayReasoningEffortConfig?.currentValue,
      );
  const showReasoningEffort =
    hasLiveReasoningEffort || isReasoningEffortPending;
  const renderedReasoningEffortConfig =
    hasLiveReasoningEffort || isReasoningEffortPending
      ? displayReasoningEffortConfig
      : latchedReasoningEffortConfig;

  useEffect(() => {
    if (!open || hasLiveReasoningEffort || !reasoningEffortConfig) {
      return;
    }

    const clearLatchedConfig = window.setTimeout(() => {
      setLatchedReasoningEffortConfig(null);
    }, REASONING_EFFORT_COLUMN_TRANSITION_MS);

    return () => {
      window.clearTimeout(clearLatchedConfig);
    };
  }, [hasLiveReasoningEffort, open, reasoningEffortConfig]);

  const handleAgentSelect = (agent: AgentPickerOption) => {
    if (agent.readiness && agent.readiness !== "ready") {
      requestOpenSettings("providers");
      setOpen(false);
      return;
    }

    if (agent.id !== selectedAgentId) {
      onAgentChange(agent.id);
    }
  };

  const handleModelSelect = (model: ModelOption) => {
    onModelChange?.(model.id, model);
  };
  const showReasoningEffortColumn = showReasoningEffort;
  const pickerWidth = showReasoningEffortColumn
    ? PICKER_WIDTH_EXPANDED_PX
    : PICKER_WIDTH_COMPACT_PX;
  useEffect(() => {
    logReasoningEffortInfo("model picker gate", {
      open,
      hasConfig: Boolean(reasoningEffortConfig),
      hasLiveReasoningEffort,
      isReasoningEffortPending,
      showReasoningEffort,
      showReasoningEffortColumn,
      ...reasoningEffortConfigLogFields(
        "config",
        renderedReasoningEffortConfig,
      ),
    });
  }, [
    hasLiveReasoningEffort,
    isReasoningEffortPending,
    open,
    reasoningEffortConfig,
    renderedReasoningEffortConfig,
    showReasoningEffort,
    showReasoningEffortColumn,
  ]);
  const resolveContentAlign = useCallback((): PopoverContentAlign => {
    if (contentAlign !== "smart") {
      return contentAlign;
    }

    const triggerRect = triggerRef.current?.getBoundingClientRect();
    if (!triggerRect) {
      return "start";
    }

    const leftAlignedRightEdge = triggerRect.left + pickerWidth;
    return leftAlignedRightEdge <= window.innerWidth - contentCollisionPadding
      ? "start"
      : "center";
  }, [contentAlign, contentCollisionPadding, pickerWidth]);

  useEffect(() => {
    if (open) {
      setResolvedContentAlign(resolveContentAlign());
    }
  }, [open, resolveContentAlign]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setResolvedContentAlign(resolveContentAlign());
        }
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
        if (nextOpen) onOpen?.();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <ComposerActionButton
              ref={triggerRef}
              type="button"
              size={triggerButtonSize}
              aria-label={t("toolbar.chooseAgentModel")}
              tabIndex={triggerTabIndex}
              disabled={loading && !selectedAgentLabel}
              leftIcon={triggerProviderIcon}
              rightIcon={
                triggerIconOnly ? undefined : (
                  <IconChevronDown className="opacity-50" />
                )
              }
              className={cn(
                "chat-composer-selector-trigger group",
                triggerIconOnly ? "shrink-0" : "min-w-0 max-w-full",
              )}
            >
              {triggerIconOnly ? null : (
                <span
                  className={cn(
                    "chat-composer-selector-label flex min-w-0 items-baseline gap-1.5 truncate",
                    isCompact ? "max-w-32" : "max-w-56",
                  )}
                >
                  <span className="min-w-0 truncate">
                    {triggerLabel ?? (loading ? t("toolbar.loading") : null)}
                  </span>
                  {showReasoningEffort && selectedReasoningEffortLabel ? (
                    <span className="shrink-0 text-muted-foreground/70 dark:group-hover:text-foreground dark:group-data-[state=open]:text-foreground dark:group-aria-expanded:text-foreground">
                      {selectedReasoningEffortLabel}
                    </span>
                  ) : null}
                </span>
              )}
            </ComposerActionButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{triggerTitle}</TooltipContent>
      </Tooltip>
      <PopoverContent
        ref={contentRef}
        align={resolvedContentAlign}
        collisionPadding={contentCollisionPadding}
        className={cn(
          "h-[min(24rem,50vh)] overflow-hidden p-1 transition-[width] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)]",
          showReasoningEffortColumn ? "w-[37.25rem]" : "w-[26.25rem]",
        )}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          contentRef.current
            ?.querySelector<HTMLElement>(
              '[data-col="agent"] button[data-selected]',
            )
            ?.focus();
        }}
        onEscapeKeyDown={(e) => {
          if (modelListRef.current?.closeSearch()) {
            e.preventDefault();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const col = (document.activeElement as HTMLElement)?.closest(
              "[data-col]",
            );
            if (!col) return;
            const items = Array.from(
              col.querySelectorAll<HTMLElement>(
                "button[data-picker-nav-item]:not(:disabled)",
              ),
            );
            const idx = items.indexOf(document.activeElement as HTMLElement);
            const next =
              idx < 0
                ? e.key === "ArrowDown"
                  ? items[0]
                  : items[items.length - 1]
                : e.key === "ArrowDown"
                  ? items[(idx + 1) % items.length]
                  : items[(idx - 1 + items.length) % items.length];
            next?.focus();
          } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const content = e.currentTarget as HTMLElement;
            const cols = Array.from(
              content.querySelectorAll<HTMLElement>(
                "[data-col]:not([data-hidden='true'])",
              ),
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
              targetCol.querySelectorAll<HTMLElement>(
                "button[data-picker-nav-item]:not(:disabled)",
              ),
            );
            const currentItems = Array.from(
              currentCol?.querySelectorAll<HTMLElement>(
                "button[data-picker-nav-item]:not(:disabled)",
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
        <div className="flex h-full items-stretch overflow-hidden">
          {/* Agent column */}
          <div
            data-col="agent"
            className="flex min-h-0 w-[11.75rem] shrink-0 overflow-hidden p-1"
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
                        {!isReady ? (
                          <Button
                            asChild
                            variant="outline"
                            size="xxs"
                            className="pointer-events-none shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                          >
                            <span>{setupLabel}</span>
                          </Button>
                        ) : isSelected ? (
                          <IconCheck className="size-4 shrink-0 text-muted-foreground" />
                        ) : null}
                      </PickerItem>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          </div>

          {/* Model column */}
          <div
            data-col="model"
            className={cn(
              "flex min-h-0 min-w-0 overflow-hidden p-1",
              "ml-1 w-56 shrink-0",
            )}
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
              <RecommendedModelList
                key={selectedAgentId}
                ref={modelListRef}
                models={displayedModels}
                currentModelId={currentModelId}
                currentModelProviderId={currentModelProviderId}
                selectedAgentId={selectedAgentId}
                onModelSelect={handleModelSelect}
                t={t}
              />
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

          <div
            data-col="reasoning"
            data-hidden={!showReasoningEffortColumn}
            aria-hidden={!showReasoningEffortColumn}
            className={cn(
              "min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width,opacity] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)]",
              showReasoningEffortColumn
                ? "w-[11rem] opacity-100"
                : "pointer-events-none w-0 opacity-0",
            )}
          >
            <div
              className={cn(
                "flex h-full w-[11rem] min-w-0 p-1 pl-2 transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)]",
                showReasoningEffortColumn
                  ? "translate-x-0 opacity-100 delay-75"
                  : "-translate-x-1 opacity-0 delay-0",
              )}
            >
              {renderedReasoningEffortConfig ? (
                <ReasoningEffortList
                  config={renderedReasoningEffortConfig}
                  disabled={
                    isReasoningEffortPending || !showReasoningEffortColumn
                  }
                  onChange={reasoningEffort?.onChange}
                  t={t}
                />
              ) : null}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
