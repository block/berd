import { useEffect, useRef } from "react";
import { AnimatePresence } from "motion/react";
import { useTranslation } from "react-i18next";
import { MessageTimeline } from "./MessageTimeline";
import { ChatInput } from "./ChatInput";
import { LoadingGoose } from "./LoadingGoose";
import { ChatLoadingSkeleton } from "./ChatLoadingSkeleton";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { ArtifactPolicyProvider } from "../hooks/ArtifactPolicyContext";
import { ChatContextPanel } from "./ChatContextPanel";
import { perfLog } from "@/shared/lib/perfLog";
import { useChatSessionController } from "../hooks/useChatSessionController";
import type { Message } from "@/shared/types/messages";

interface ChatViewProps {
  sessionId: string;
  onCreatePersona?: () => void;
  onCreateProject?: (options?: {
    onCreated?: (projectId: string) => void;
  }) => void;
}

// Tighten the tail padding when the latest visible assistant content is an MCP
// app so the app surface approaches the floating composer without hiding it.
function isMcpAppTail(messages: Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.metadata?.userVisible === false ||
      (message.role === "assistant" &&
        message.content.length === 0 &&
        message.metadata?.completionStatus === "inProgress")
    ) {
      continue;
    }

    return (
      message.role === "assistant" && message.content.at(-1)?.type === "mcpApp"
    );
  }

  return false;
}

export function ChatView({
  sessionId,
  onCreatePersona,
  onCreateProject,
}: ChatViewProps) {
  const { t } = useTranslation("chat");
  const mountStart = useRef(performance.now());
  const isContextPanelOpen = useChatSessionStore((s) => s.isContextPanelOpen);
  const controller = useChatSessionController({
    sessionId,
    onCreatePersonaRequested: onCreatePersona,
  });

  useEffect(() => {
    const ms = (performance.now() - mountStart.current).toFixed(1);
    perfLog(`[perf:chatview] ${sessionId.slice(0, 8)} mounted in ${ms}ms`);
  }, [sessionId]);

  const showIndicator =
    controller.chatState === "thinking" ||
    controller.chatState === "streaming" ||
    controller.chatState === "waiting" ||
    controller.chatState === "compacting";
  const shouldShowLoadingIndicator =
    showIndicator && !controller.isLoadingHistory;
  let sendDisabledReason: string | undefined;
  if (controller.session?.creationState === "pending") {
    sendDisabledReason = t("toolbar.sessionStarting");
  } else if (controller.session?.creationState === "failed") {
    sendDisabledReason =
      controller.session.creationError ?? t("toolbar.sessionStartFailed");
  }

  return (
    <ArtifactPolicyProvider
      messages={controller.messages}
      sessionCwd={controller.sessionArtifactCwd}
    >
      <div className="page-transition flex h-full min-w-0 gap-3 px-3 pb-3 pt-[var(--spacing-app-panel-gutter-top)]">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative mb-20 flex min-h-0 flex-1 flex-col overflow-hidden rounded-card-chat bg-card">
            {controller.isLoadingHistory ? (
              <ChatLoadingSkeleton />
            ) : controller.messages.length === 0 ? (
              <div className="flex h-full w-full items-center justify-center px-6">
                <p className="text-3xl font-light text-foreground">
                  {t("emptyState.startAConversation")}
                </p>
              </div>
            ) : (
              <MessageTimeline
                messages={controller.messages}
                streamingMessageId={controller.streamingMessageId}
                scrollTargetMessageId={
                  controller.scrollTarget?.messageId ?? null
                }
                scrollTargetQuery={controller.scrollTarget?.query ?? null}
                onScrollTargetHandled={controller.handleScrollTargetHandled}
                onSendMcpAppMessage={controller.handleSend}
                className={
                  isMcpAppTail(controller.messages) ? "pb-12" : "pb-24"
                }
              />
            )}

            <AnimatePresence initial={false}>
              {shouldShowLoadingIndicator ? (
                <LoadingGoose
                  key="loading-indicator"
                  chatState={
                    controller.chatState as
                      | "thinking"
                      | "streaming"
                      | "waiting"
                      | "compacting"
                  }
                />
              ) : null}
            </AnimatePresence>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-20 flex translate-y-1/2 justify-center px-4">
            <div
              className="pointer-events-auto w-full max-w-3xl rounded-composer bg-surface-composer-glass ring-1 ring-inset ring-[var(--ring-composer-glass-inner)] outline outline-1 outline-[var(--outline-composer-glass-outer)]"
              style={{
                backdropFilter: "var(--backdrop-composer-glass)",
                WebkitBackdropFilter: "var(--backdrop-composer-glass)",
              }}
            >
              <ChatInput
                composerActions={{
                  onSend: controller.handleSend,
                  disabled:
                    controller.projectMetadataPending ||
                    controller.isCompactingContext,
                  sendDisabled: controller.session?.creationState != null,
                  sendDisabledReason,
                  queuedMessage: controller.queue.queuedMessage,
                  onDismissQueue: controller.queue.dismiss,
                  onStop: controller.stopStreaming,
                  isStreaming:
                    controller.chatState === "streaming" ||
                    controller.chatState === "thinking",
                }}
                initialValue={controller.draftValue}
                onDraftChange={controller.handleDraftChange}
                selectedSkills={controller.selectedSkills}
                onSkillsChange={controller.handleSkillsChange}
                personaPicker={{
                  personas: controller.personas,
                  selectedPersonaId: controller.selectedPersonaId,
                  onPersonaChange: controller.handlePersonaChange,
                }}
                agentModelPicker={{
                  providers: controller.pickerAgents,
                  providersLoading: controller.providersLoading,
                  selectedProvider: controller.selectedProvider,
                  onProviderChange: controller.handleProviderChange,
                  currentModelId: controller.currentModelId,
                  currentModelProviderId: controller.currentModelProviderId,
                  currentModel: controller.currentModelName ?? undefined,
                  availableModels: controller.availableModels,
                  modelsLoading: controller.modelsLoading,
                  modelStatusMessage: controller.modelStatusMessage,
                  onModelChange: controller.handleModelChange,
                  onPickerOpen: controller.handlePickerOpen,
                }}
                projectPicker={{
                  selectedProjectId: controller.selectedProjectId,
                  availableProjects: controller.availableProjects,
                  onProjectChange: controller.handleProjectChange,
                  onCreateProject: (options) =>
                    onCreateProject?.({
                      onCreated: (projectId) => {
                        controller.handleProjectChange(projectId);
                        options?.onCreated?.(projectId);
                      },
                    }),
                }}
                contextUsage={{
                  contextTokens: controller.tokenState.accumulatedTotal,
                  contextLimit: controller.tokenState.contextLimit,
                  isContextUsageReady: controller.isContextUsageReady,
                  onCompactContext: controller.compactConversation,
                  canCompactContext: controller.canCompactContext,
                  isCompactingContext: controller.isCompactingContext,
                  supportsCompactionControls:
                    controller.supportsCompactionControls,
                }}
              />
            </div>
          </div>
        </div>

        <ChatContextPanel
          activeSessionId={sessionId}
          isOpen={isContextPanelOpen}
          project={controller.project}
          sessionWorkingDir={controller.session?.workingDir}
        />
      </div>
    </ArtifactPolicyProvider>
  );
}
