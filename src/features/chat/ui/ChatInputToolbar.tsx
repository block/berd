import { useEffect, useMemo, useState } from "react";
import { Mic, ArrowUp, File, FolderOpen, Settings2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { IconPlayerStopFilled } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { ContextRing } from "./ContextRing";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Progress } from "@/shared/ui/progress";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/shared/ui/tooltip";
import { AgentModelPicker } from "./AgentModelPicker";
import { formatProviderLabel } from "@/shared/ui/icons/ProviderIcons";
import { getCatalogEntryFromEntries } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { supportsContextCompactionControls } from "../lib/autoCompact";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { ProjectInputSelector } from "./ProjectInputSelector";
import type {
  AgentPickerOption,
  ChatInputAgentModelPicker,
  ChatInputContextUsage,
  ChatInputPersonaPicker,
  ChatInputProjectPicker,
} from "../types";

interface ChatInputToolbarComposerActions {
  canSend: boolean;
  isStreaming: boolean;
  hasQueuedMessage: boolean;
  onSend: () => void;
  onStop?: () => void;
  onAttachFiles?: () => void;
  onAttachFolders?: () => void;
  attachmentsEnabled?: boolean;
  disabled?: boolean;
  sendDisabledReason?: string;
  voiceEnabled?: boolean;
  voiceRecording?: boolean;
  voiceTranscribing?: boolean;
  onVoiceToggle?: () => void;
}

interface ChatInputToolbarProps {
  personaPicker: Pick<ChatInputPersonaPicker, "selectedPersonaId">;
  agentModelPicker: ChatInputAgentModelPicker & { enabled?: boolean };
  projectPicker: ChatInputProjectPicker;
  contextUsage: ChatInputContextUsage;
  composerActions: ChatInputToolbarComposerActions;
  isCompact: boolean;
}

export function ChatInputToolbar({
  personaPicker,
  agentModelPicker,
  projectPicker,
  contextUsage,
  composerActions,
  isCompact,
}: ChatInputToolbarProps) {
  const { t } = useTranslation("chat");
  const { formatNumber } = useLocaleFormatting();
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const [isContextPopoverOpen, setIsContextPopoverOpen] = useState(false);
  const { selectedPersonaId = null } = personaPicker;
  const {
    providers = [],
    providersLoading,
    selectedProvider = "goose",
    onProviderChange,
    currentModelId,
    currentModelProviderId,
    currentModel,
    availableModels = [],
    modelsLoading = false,
    modelStatusMessage = null,
    onModelChange,
    onPickerOpen,
    enabled: agentModelPickerEnabled = true,
  } = agentModelPicker;
  const {
    enabled: projectPickerEnabled = true,
    selectedProjectId = null,
    availableProjects = [],
    onProjectChange,
    onCreateProject,
  } = projectPicker;
  const {
    contextTokens = 0,
    contextLimit = 0,
    isContextUsageReady,
    supportsCompactionControls,
    canCompactContext = false,
    isCompactingContext = false,
    onCompactContext,
  } = contextUsage;
  const {
    canSend,
    isStreaming,
    hasQueuedMessage,
    onSend,
    onStop,
    onAttachFiles,
    onAttachFolders,
    attachmentsEnabled = true,
    disabled = false,
    sendDisabledReason,
    voiceEnabled = false,
    voiceRecording = false,
    voiceTranscribing = false,
    onVoiceToggle,
  } = composerActions;
  const compactionControlsSupported =
    supportsCompactionControls ??
    supportsContextCompactionControls(selectedProvider);
  const sendButtonTooltip = canSend
    ? t("toolbar.sendMessage")
    : sendDisabledReason;

  const agentProviders = useMemo(() => {
    const seen = new Set<string>();
    const available: AgentPickerOption[] = [];
    for (const provider of providers) {
      if (seen.has(provider.id)) {
        continue;
      }
      seen.add(provider.id);
      available.push({
        ...provider,
        label:
          getCatalogEntryFromEntries(catalogEntries, provider.id)
            ?.displayName ?? provider.label,
      });
    }
    if (available.length > 0) return available;
    return [
      {
        id: selectedProvider,
        label:
          getCatalogEntryFromEntries(catalogEntries, selectedProvider)
            ?.displayName ?? formatProviderLabel(selectedProvider),
      },
    ];
  }, [catalogEntries, providers, selectedProvider]);
  const contextProgress =
    contextLimit > 0 ? Math.min(contextTokens / contextLimit, 1) : 0;
  const showContextUsage =
    (isContextUsageReady ?? contextLimit > 0) && contextTokens > 0;
  const contextPercentDigits =
    contextProgress > 0 && contextProgress < 0.1 ? 1 : 0;
  const usedPercentLabel = formatNumber(contextProgress, {
    style: "percent",
    minimumFractionDigits: contextPercentDigits,
    maximumFractionDigits: contextPercentDigits,
  });
  const formatCompactTokenCount = (value: number) =>
    formatNumber(value, {
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: value < 10_000 ? 1 : 0,
    });

  const handleCompactContext = () => {
    if (!canCompactContext || isCompactingContext || !onCompactContext) {
      return;
    }

    setIsContextPopoverOpen(false);
    void onCompactContext();
  };

  const handleOpenAutoCompactSettings = () => {
    setIsContextPopoverOpen(false);
    requestOpenSettings("general");
  };

  useEffect(() => {
    if (!showContextUsage && isContextPopoverOpen) {
      setIsContextPopoverOpen(false);
    }
  }, [isContextPopoverOpen, showContextUsage]);

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2",
        isCompact && "flex-wrap gap-y-2",
      )}
    >
      {/* Left side: pickers */}
      <div
        className={cn("flex min-w-0 items-center gap-2", isCompact && "flex-1")}
      >
        {attachmentsEnabled && (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="composer-action"
                    size="icon-pill-sm"
                    disabled={disabled}
                    aria-label={t("toolbar.attach")}
                  >
                    <Plus aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("toolbar.attach")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={() => onAttachFiles?.()}
                disabled={disabled}
              >
                <File className="mr-2 h-4 w-4" />
                {t("toolbar.attachFile")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onAttachFolders?.()}
                disabled={disabled}
              >
                <FolderOpen className="mr-2 h-4 w-4" />
                {t("toolbar.attachFolder")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {agentModelPickerEnabled &&
          (agentProviders.length > 0 || providersLoading) && (
            <AgentModelPicker
              agents={agentProviders}
              selectedAgentId={selectedProvider}
              onAgentChange={(providerId) => onProviderChange?.(providerId)}
              currentModelId={currentModelId}
              currentModelProviderId={currentModelProviderId}
              currentModelName={currentModel ?? null}
              availableModels={availableModels}
              modelsLoading={modelsLoading}
              modelStatusMessage={modelStatusMessage}
              onModelChange={onModelChange}
              onOpen={onPickerOpen}
              loading={providersLoading}
              isCompact={isCompact}
              showSelectedModelInTrigger={selectedPersonaId === null}
            />
          )}

        {projectPickerEnabled ? (
          <ProjectInputSelector
            selectedProjectId={selectedProjectId}
            availableProjects={availableProjects}
            onProjectChange={onProjectChange}
            onCreateProject={onCreateProject}
          />
        ) : null}
      </div>

      {/* Right side: actions */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-2",
          isCompact && "ml-auto",
        )}
      >
        <div className="flex items-center gap-2">
          {showContextUsage && (
            <Popover
              open={isContextPopoverOpen}
              onOpenChange={setIsContextPopoverOpen}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size={isCompact ? "icon-sm" : "sm"}
                      className={cn(
                        "group rounded-sm bg-transparent text-foreground/80 shadow-none hover:bg-transparent hover:text-foreground data-[state=open]:bg-transparent data-[state=open]:text-foreground",
                        isCompact ? "px-0" : "px-2.5",
                      )}
                      aria-label={t("toolbar.contextUsage")}
                    >
                      <ContextRing
                        tokens={contextTokens}
                        limit={contextLimit}
                        size={16}
                      />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  {t("toolbar.contextUsageTitle", {
                    tokens: formatNumber(contextTokens),
                    limit: formatNumber(contextLimit),
                  })}
                </TooltipContent>
              </Tooltip>
              <PopoverContent
                side="top"
                align="end"
                sideOffset={8}
                className="w-60 rounded-md p-1 text-left"
              >
                <div className="px-2 py-1.5 text-sm font-semibold text-foreground">
                  {t("toolbar.contextWindow")}
                </div>
                <div className="space-y-2 px-2 pb-1.5">
                  <Progress
                    className="h-1.5 bg-muted"
                    value={contextProgress * 100}
                  />
                  <div className="flex items-center justify-between gap-3 text-xs text-foreground">
                    <div className="truncate">
                      {t("toolbar.contextTokensBreakdown", {
                        tokens: formatCompactTokenCount(contextTokens),
                        limit: formatCompactTokenCount(contextLimit),
                      })}
                    </div>
                    <div className="shrink-0">{usedPercentLabel}</div>
                  </div>
                  {compactionControlsSupported ? (
                    <div className="flex items-center gap-1 pt-0.5">
                      <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        className="min-w-0 flex-1 justify-center"
                        onClick={handleCompactContext}
                        disabled={!canCompactContext || isCompactingContext}
                      >
                        {isCompactingContext
                          ? t("toolbar.compacting")
                          : t("toolbar.compactNow")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0 rounded-sm"
                        onClick={handleOpenAutoCompactSettings}
                        aria-label={t("toolbar.settings")}
                        title={t("toolbar.settings")}
                      >
                        <Settings2 className="size-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </PopoverContent>
            </Popover>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  variant="composer-action"
                  size="icon-pill-sm"
                  disabled={!voiceRecording && (!voiceEnabled || disabled)}
                  onClick={onVoiceToggle}
                  aria-label={
                    voiceRecording
                      ? t("toolbar.voiceInputRecording")
                      : t("toolbar.voiceInput")
                  }
                  className={cn(
                    voiceRecording &&
                      "bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground active:bg-destructive active:text-destructive-foreground",
                    voiceTranscribing && "animate-pulse",
                  )}
                >
                  <Mic aria-hidden="true" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {!voiceEnabled
                ? t("toolbar.voiceInputDisabled")
                : voiceRecording
                  ? t("toolbar.voiceInputRecording")
                  : voiceTranscribing
                    ? t("toolbar.voiceInputTranscribing")
                    : t("toolbar.voiceInput")}
            </TooltipContent>
          </Tooltip>
        </div>

        <div>
          {isStreaming && !canSend && !hasQueuedMessage ? (
            <Button
              type="button"
              onClick={onStop}
              variant="composer-action"
              size="icon-pill-sm"
              aria-label={t("toolbar.stopGeneration")}
              title={t("toolbar.stopGeneration")}
            >
              <IconPlayerStopFilled className="size-3.5" aria-hidden="true" />
            </Button>
          ) : !sendButtonTooltip ? (
            <Button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              variant="composer-action"
              size="icon-pill-sm"
              className={cn(!canSend && "disabled:opacity-100")}
              aria-label={t("toolbar.sendMessage")}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    onClick={onSend}
                    disabled={!canSend}
                    variant="composer-action"
                    size="icon-pill-sm"
                    className={cn(!canSend && "disabled:opacity-100")}
                    aria-label={sendButtonTooltip ?? t("toolbar.sendMessage")}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                </span>
              </TooltipTrigger>
              {sendButtonTooltip ? (
                <TooltipContent>{sendButtonTooltip}</TooltipContent>
              ) : null}
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
