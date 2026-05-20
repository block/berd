import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconMicrophone,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useVoiceDictation } from "@/features/chat/hooks/useVoiceDictation";
import { getStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import type { ModelOption } from "@/features/chat/types";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { getProviderInventory } from "@/features/providers/api/inventory";
import { useProviderInventory } from "@/features/providers/hooks/useProviderInventory";
import { resolveAgentProviderCatalogIdStrict } from "@/features/providers/providerCatalog";
import { useProviderInventoryStore } from "@/features/providers/stores/providerInventoryStore";
import { getClient } from "@/shared/api/acpConnection";
import {
  inspectAttachmentPaths,
  readImageAttachment,
} from "@/shared/api/system";
import { cn } from "@/shared/lib/cn";
import { getPlatform } from "@/shared/lib/platform";
import {
  formatProviderLabel,
  getProviderIcon,
} from "@/shared/ui/icons/ProviderIcons";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import type {
  ChatAttachmentDraft,
  ChatFileAttachmentDraft,
  ChatImageAttachmentDraft,
} from "@/shared/types/messages";

export interface GlobalComposeOptions {
  providerId?: string;
  modelId?: string;
  modelName?: string;
  projectId?: string | null;
  attachments?: ChatAttachmentDraft[];
}

interface GlobalComposerPillProps {
  onSend: (text: string, options?: GlobalComposeOptions) => void;
}

interface ModelSelection {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

interface ModelGroup {
  providerId: string;
  providerName: string;
  models: ModelSelection[];
}

const MODEL_ALIAS_IDS = new Set(["current", "default"]);

function normalizeDialogSelection(
  selected: string | string[] | null,
): string[] {
  if (!selected) {
    return [];
  }

  return Array.isArray(selected) ? selected : [selected];
}

function compareLabels(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function getAttachmentPathKey(path?: string) {
  if (!path) {
    return null;
  }

  return getPlatform() === "linux" ? path : path.toLowerCase();
}

function getModelName(model: ModelOption) {
  return model.displayName ?? model.name ?? model.id;
}

function isModelAlias(modelId?: string | null): boolean {
  return modelId != null && MODEL_ALIAS_IDS.has(modelId);
}

function modelOptionToSelection(
  model: ModelOption,
  fallbackProviderId: string,
): ModelSelection {
  const providerId = model.providerId ?? fallbackProviderId;
  return {
    providerId,
    providerName: model.providerName ?? formatProviderLabel(providerId),
    modelId: model.id,
    modelName: getModelName(model),
  };
}

function buildModelGroups(
  models: ModelOption[],
  fallbackProviderId: string,
): ModelGroup[] {
  const recommendedByProviderAndModel = new Map<string, boolean>();
  const groups = new Map<string, ModelGroup>();

  for (const model of models) {
    const selection = modelOptionToSelection(model, fallbackProviderId);
    recommendedByProviderAndModel.set(
      `${selection.providerId}:${selection.modelId}`,
      model.recommended ?? false,
    );

    const group = groups.get(selection.providerId);
    if (group) {
      group.models.push(selection);
    } else {
      groups.set(selection.providerId, {
        providerId: selection.providerId,
        providerName: selection.providerName,
        models: [selection],
      });
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      models: group.models.sort((left, right) => {
        const leftRecommended =
          recommendedByProviderAndModel.get(
            `${left.providerId}:${left.modelId}`,
          ) ?? false;
        const rightRecommended =
          recommendedByProviderAndModel.get(
            `${right.providerId}:${right.modelId}`,
          ) ?? false;

        if (leftRecommended !== rightRecommended) {
          return leftRecommended ? -1 : 1;
        }

        return compareLabels(left.modelName, right.modelName);
      }),
    }))
    .sort((left, right) =>
      compareLabels(left.providerName, right.providerName),
    );
}

function findMatchingModel(
  models: ModelOption[],
  modelId: string,
  providerId?: string | null,
) {
  return (
    models.find(
      (model) =>
        model.id === modelId &&
        (!providerId || !model.providerId || model.providerId === providerId),
    ) ?? null
  );
}

function getPreferredModel(
  models: ModelOption[],
  fallbackProviderId: string,
): ModelSelection | null {
  const model =
    models.find((candidate) => candidate.recommended) ??
    models.find((candidate) => !isModelAlias(candidate.id)) ??
    models[0];

  return model ? modelOptionToSelection(model, fallbackProviderId) : null;
}

async function buildPathAttachments(
  paths: string[],
): Promise<ChatAttachmentDraft[]> {
  if (paths.length === 0) {
    return [];
  }

  const inspectedPaths = await inspectAttachmentPaths(paths);

  return Promise.all(
    inspectedPaths.flatMap((attachmentPath) => {
      if (attachmentPath.kind !== "file") {
        return [];
      }

      return [
        (async () => {
          if (attachmentPath.mimeType?.startsWith("image/")) {
            try {
              const image = await readImageAttachment(attachmentPath.path);
              return {
                id: crypto.randomUUID(),
                kind: "image",
                name: attachmentPath.name,
                path: attachmentPath.path,
                mimeType: image.mimeType,
                base64: image.base64,
                previewUrl: attachmentPath.path,
              } satisfies ChatImageAttachmentDraft;
            } catch {
              // Fall through to a file draft when the image payload can't be read.
            }
          }

          return {
            id: crypto.randomUUID(),
            kind: "file",
            name: attachmentPath.name,
            path: attachmentPath.path,
            ...(attachmentPath.mimeType
              ? { mimeType: attachmentPath.mimeType }
              : {}),
          } satisfies ChatFileAttachmentDraft;
        })(),
      ];
    }),
  );
}

export function GlobalComposerPill({ onSend }: GlobalComposerPillProps) {
  const { t } = useTranslation("chat");
  const selectedProvider = useAgentStore((state) => state.selectedProvider);
  const projects = useProjectStore((state) => state.projects);
  const { getModelsForAgent } = useProviderInventory();
  const mergeInventoryEntries = useProviderInventoryStore(
    (state) => state.mergeEntries,
  );
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachmentDraft[]>([]);
  const [modelOverride, setModelOverride] = useState<ModelSelection | null>(
    null,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [gooseDefaultSelection, setGooseDefaultSelection] =
    useState<ModelSelection | null>(null);

  const placeholder = t("globalPill.placeholder");

  const selectedAgentId =
    resolveAgentProviderCatalogIdStrict(selectedProvider) ?? "goose";
  const concreteSelectedProviderId =
    resolveAgentProviderCatalogIdStrict(selectedProvider) == null
      ? selectedProvider
      : null;
  const availableModels = useMemo(
    () => getModelsForAgent(selectedAgentId),
    [getModelsForAgent, selectedAgentId],
  );
  const defaultModelSelection = useMemo(() => {
    const storedPreference = getStoredModelPreference(selectedAgentId);
    if (storedPreference) {
      const matchingModel = findMatchingModel(
        availableModels,
        storedPreference.modelId,
        storedPreference.providerId,
      );
      const storedSelectionCompatible =
        !concreteSelectedProviderId ||
        storedPreference.providerId === concreteSelectedProviderId;

      if (matchingModel || storedSelectionCompatible) {
        const providerId =
          matchingModel?.providerId ??
          storedPreference.providerId ??
          selectedProvider;
        return {
          providerId,
          providerName:
            matchingModel?.providerName ?? formatProviderLabel(providerId),
          modelId: storedPreference.modelId,
          modelName:
            matchingModel != null
              ? getModelName(matchingModel)
              : storedPreference.modelName,
        };
      }
    }

    if (
      gooseDefaultSelection &&
      (!concreteSelectedProviderId ||
        gooseDefaultSelection.providerId === concreteSelectedProviderId)
    ) {
      const matchingDefault = findMatchingModel(
        availableModels,
        gooseDefaultSelection.modelId,
        gooseDefaultSelection.providerId,
      );
      return matchingDefault
        ? modelOptionToSelection(matchingDefault, selectedProvider)
        : gooseDefaultSelection;
    }

    const compatibleModels = concreteSelectedProviderId
      ? availableModels.filter(
          (model) =>
            !model.providerId ||
            model.providerId === concreteSelectedProviderId,
        )
      : availableModels;

    return getPreferredModel(compatibleModels, selectedProvider);
  }, [
    availableModels,
    concreteSelectedProviderId,
    gooseDefaultSelection,
    selectedAgentId,
    selectedProvider,
  ]);
  const modelGroups = useMemo(
    () => buildModelGroups(availableModels, selectedProvider),
    [availableModels, selectedProvider],
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const effectiveModelSelection = modelOverride ?? defaultModelSelection;

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  const submitCompose = useCallback(
    (draftText: string) => {
      const trimmed = draftText.trim();
      if (trimmed.length === 0 && attachments.length === 0) {
        return false;
      }

      const options: GlobalComposeOptions = {};
      if (attachments.length > 0) {
        options.attachments = attachments;
      }
      if (modelOverride) {
        options.providerId = modelOverride.providerId;
        options.modelId = modelOverride.modelId;
        options.modelName = modelOverride.modelName;
      }
      if (selectedProjectId) {
        options.projectId = selectedProjectId;
      }

      if (Object.keys(options).length > 0) {
        onSend(trimmed, options);
      } else {
        onSend(trimmed);
      }
      setText("");
      clearAttachments();
      setModelOverride(null);
      setSelectedProjectId(null);
      return true;
    },
    [attachments, clearAttachments, modelOverride, onSend, selectedProjectId],
  );

  const dictation = useVoiceDictation({
    text,
    setText,
    attachments,
    clearAttachments,
    selectedPersonaId: null,
    onSend: (draftText) => submitCompose(draftText),
    resetTextarea: () => {},
    isSendLocked: false,
  });

  useEffect(() => {
    if (!modelPickerOpen) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const entries = await getProviderInventory();
        if (!cancelled) {
          mergeInventoryEntries(entries);
        }
      } catch (error) {
        console.error(
          "Failed to sync provider inventory from global composer:",
          error,
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [modelPickerOpen, mergeInventoryEntries]);

  useEffect(() => {
    if (selectedAgentId !== "goose") {
      setGooseDefaultSelection(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const client = await getClient();
        const defaults = await client.goose.GooseDefaultsRead({});

        if (cancelled) {
          return;
        }

        const providerId = defaults.providerId ?? selectedProvider;
        const modelId = defaults.modelId ?? undefined;

        setGooseDefaultSelection(
          modelId
            ? {
                providerId,
                providerName: formatProviderLabel(providerId),
                modelId,
                modelName: modelId,
              }
            : null,
        );
      } catch {
        if (!cancelled) {
          setGooseDefaultSelection(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedAgentId, selectedProvider]);

  const expanded =
    focused ||
    modelPickerOpen ||
    projectPickerOpen ||
    dictation.isRecording ||
    dictation.isTranscribing ||
    text.trim().length > 0 ||
    attachments.length > 0;

  const effectivePlaceholder = dictation.isRecording
    ? t("toolbar.voiceInputRecording")
    : dictation.isTranscribing
      ? t("toolbar.voiceInputTranscribing")
      : placeholder;

  const handleSend = useCallback(() => {
    if (
      dictation.isRecording ||
      dictation.isTranscribing ||
      dictation.isStarting()
    ) {
      dictation.stopRecording();
    }

    submitCompose(text);
  }, [dictation, submitCompose, text]);

  const handleAttachFiles = useCallback(async () => {
    try {
      const selected = await open({
        title: t("attachments.chooseFilesDialogTitle"),
        multiple: true,
      });
      const nextAttachments = await buildPathAttachments(
        normalizeDialogSelection(selected),
      );
      if (nextAttachments.length === 0) {
        return;
      }

      setAttachments((previous) => {
        const seenPaths = new Set(
          previous
            .map((attachment) => getAttachmentPathKey(attachment.path))
            .filter((value): value is string => Boolean(value)),
        );
        const merged = [...previous];

        for (const attachment of nextAttachments) {
          const pathKey = getAttachmentPathKey(attachment.path);
          if (pathKey && seenPaths.has(pathKey)) {
            continue;
          }
          if (pathKey) {
            seenPaths.add(pathKey);
          }
          merged.push(attachment);
        }

        return merged;
      });
    } catch {
      // Dialog plugin may be unavailable in some environments.
    }
  }, [t]);

  const modelButtonLabel =
    effectiveModelSelection?.modelName ??
    defaultModelSelection?.modelName ??
    t("toolbar.selectModel");

  const projectButtonLabel = selectedProject?.name ?? t("toolbar.noProject");

  return (
    <div
      role="region"
      aria-label={t("globalPill.ariaLabel")}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
      className="fixed bottom-3 right-3 z-40 flex w-[482px] max-w-[calc(100vw-24px)] flex-col rounded-composer bg-surface-composer-glass px-4 py-3 ring-1 ring-inset ring-[var(--ring-composer-glass-inner)] outline outline-1 outline-[var(--outline-composer-glass-outer)]"
      style={{
        backdropFilter: "blur(24px) saturate(180%) brightness(1.05)",
        WebkitBackdropFilter: "blur(24px) saturate(180%) brightness(1.05)",
      }}
    >
      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2 px-2">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-1 text-[12px] text-foreground"
            >
              <span className="max-w-[220px] truncate">{attachment.name}</span>
              <button
                type="button"
                onClick={() =>
                  setAttachments((previous) =>
                    previous.filter((item) => item.id !== attachment.id),
                  )
                }
                className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={t("attachments.remove")}
              >
                <IconX className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-3 px-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={effectivePlaceholder}
          className="focus-override h-10 flex-1 appearance-none border-0 bg-transparent text-[16px] leading-[20px] text-foreground outline-none placeholder:text-foreground focus:outline-none focus:ring-0"
        />

        <div
          aria-hidden={expanded}
          className={cn(
            "flex shrink-0 items-center gap-2 transition-opacity duration-150",
            expanded && "pointer-events-none opacity-0",
          )}
        >
          <button
            type="button"
            tabIndex={expanded ? -1 : 0}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-button"
            aria-label={t("toolbar.voiceInput")}
            title={t("toolbar.voiceInput")}
          >
            <IconMicrophone className="size-4 text-foreground" />
          </button>
          <button
            type="button"
            tabIndex={expanded ? -1 : 0}
            onClick={handleSend}
            className="flex h-8 w-10 items-center justify-center rounded-full bg-surface-button"
            aria-label={t("toolbar.sendMessage")}
          >
            <IconArrowUp className="size-4 text-foreground" />
          </button>
        </div>
      </div>

      <div
        aria-hidden={!expanded}
        className={cn(
          "overflow-hidden transition-[max-height,opacity,padding-top] duration-200 ease-out",
          expanded ? "max-h-20 pt-2 opacity-100" : "max-h-0 pt-0 opacity-0",
        )}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            tabIndex={expanded ? 0 : -1}
            onClick={() => {
              void handleAttachFiles();
            }}
            className="flex h-8 w-10 items-center justify-center rounded-full bg-surface-button"
            aria-label={t("attachments.chooseFilesDialogTitle")}
          >
            <IconPlus className="size-4 text-foreground" />
          </button>

          <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                tabIndex={expanded ? 0 : -1}
                className="flex h-8 min-w-0 items-center gap-1 rounded-full px-2 text-[14px] text-foreground hover:bg-surface-button"
                aria-label={t("toolbar.selectModel")}
              >
                <span className="max-w-[140px] truncate">
                  {modelButtonLabel}
                </span>
                <IconChevronDown className="size-3 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-[320px] p-2">
              <div className="max-h-80 space-y-2 overflow-y-auto">
                {modelGroups.length === 0 ? (
                  <p className="px-2 py-3 text-center text-[14px] text-muted-foreground">
                    {t("toolbar.noModelsAvailable")}
                  </p>
                ) : null}
                {modelGroups.map((group) => (
                  <div key={group.providerId} className="space-y-1">
                    <div className="flex items-center gap-2 px-2 pt-1 text-[12px] font-medium text-muted-foreground">
                      <span className="text-muted-foreground">
                        {getProviderIcon(group.providerId, "size-3.5")}
                      </span>
                      <span>{group.providerName}</span>
                    </div>
                    <div className="space-y-0.5">
                      {group.models.map((model) => {
                        const isSelected =
                          effectiveModelSelection?.providerId ===
                            model.providerId &&
                          effectiveModelSelection.modelId === model.modelId;

                        return (
                          <button
                            key={`${model.providerId}:${model.modelId}`}
                            type="button"
                            onClick={() => {
                              setModelOverride(model);
                              setModelPickerOpen(false);
                            }}
                            className={cn(
                              "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent",
                              isSelected && "bg-muted",
                            )}
                          >
                            <span className="truncate">{model.modelName}</span>
                            {isSelected ? (
                              <IconCheck className="ml-2 size-4 shrink-0 text-muted-foreground" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                tabIndex={expanded ? 0 : -1}
                className="flex h-8 min-w-0 items-center gap-1 rounded-full px-2 text-[14px] text-foreground hover:bg-surface-button"
                aria-label={t("toolbar.selectProject")}
              >
                <span className="max-w-[120px] truncate">
                  {projectButtonLabel}
                </span>
                <IconChevronDown className="size-3 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-[260px] p-2">
              <div className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedProjectId(null);
                    setProjectPickerOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent",
                    selectedProjectId === null && "bg-muted",
                  )}
                >
                  <span>{t("toolbar.noProject")}</span>
                  {selectedProjectId === null ? (
                    <IconCheck className="ml-2 size-4 shrink-0 text-muted-foreground" />
                  ) : null}
                </button>
                {projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => {
                      setSelectedProjectId(project.id);
                      setProjectPickerOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent",
                      selectedProjectId === project.id && "bg-muted",
                    )}
                  >
                    <span className="truncate">{project.name}</span>
                    {selectedProjectId === project.id ? (
                      <IconCheck className="ml-2 size-4 shrink-0 text-muted-foreground" />
                    ) : null}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              tabIndex={expanded ? 0 : -1}
              disabled={!dictation.isRecording && !dictation.isEnabled}
              onClick={dictation.toggleRecording}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full bg-surface-button transition-colors",
                dictation.isRecording &&
                  "bg-destructive/12 text-destructive hover:bg-destructive/16",
                dictation.isTranscribing && "animate-pulse",
                !dictation.isRecording &&
                  !dictation.isEnabled &&
                  "opacity-50 hover:bg-surface-button",
              )}
              aria-label={
                dictation.isRecording
                  ? t("toolbar.voiceInputRecording")
                  : t("toolbar.voiceInput")
              }
              aria-pressed={dictation.isRecording}
              title={
                !dictation.isEnabled
                  ? t("toolbar.voiceInputDisabled")
                  : dictation.isRecording
                    ? t("toolbar.voiceInputRecording")
                    : dictation.isTranscribing
                      ? t("toolbar.voiceInputTranscribing")
                      : t("toolbar.voiceInput")
              }
            >
              <IconMicrophone className="size-4" />
            </button>
            <button
              type="button"
              tabIndex={expanded ? 0 : -1}
              onClick={handleSend}
              className="flex h-8 w-10 items-center justify-center rounded-full bg-surface-button"
              aria-label={t("toolbar.sendMessage")}
            >
              <IconArrowUp className="size-4 text-foreground" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
