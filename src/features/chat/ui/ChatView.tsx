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

interface ChatViewProps {
  sessionId: string;
  onCreatePersona?: () => void;
  onCreateProject?: (options?: {
    onCreated?: (projectId: string) => void;
  }) => void;
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

  // The composer lives inside the conversation's scroll container as a sticky
  // footer, so the conversation scrolls behind the glassy composer and the
  // browser handles native scroll latching between the composer's text and the
  // conversation. It stays mounted across loading, empty, and populated states
  // (passed as `footer`) so it never remounts and loses focus or draft text.
  const composerFooter = (
    <>
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
      <div className="px-4">
        <div className="pointer-events-auto mx-auto w-full max-w-xl rounded-card-chat bg-surface-composer shadow-[var(--shadow-chat)] backdrop-blur-md">
          <ChatInput
            surface="bare"
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
              supportsCompactionControls: controller.supportsCompactionControls,
            }}
          />
        </div>
      </div>
    </>
  );

  const conversationPlaceholder = controller.isLoadingHistory ? (
    <ChatLoadingSkeleton />
  ) : (
    <div className="flex w-full flex-1 items-center justify-center px-6">
      <p className="text-3xl font-light text-foreground">
        {t("emptyState.startAConversation")}
      </p>
    </div>
  );

  return (
    <ArtifactPolicyProvider
      messages={controller.messages}
      sessionCwd={controller.sessionArtifactCwd}
    >
      <div className="page-transition flex h-full min-w-0 gap-3 px-3 pb-3 pt-[var(--spacing-app-panel-gutter-top)]">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-card-chat bg-card">
            <MessageTimeline
              messages={controller.messages}
              streamingMessageId={controller.streamingMessageId}
              scrollTargetMessageId={controller.scrollTarget?.messageId ?? null}
              scrollTargetQuery={controller.scrollTarget?.query ?? null}
              onScrollTargetHandled={controller.handleScrollTargetHandled}
              onSendMcpAppMessage={controller.handleSend}
              showPlaceholder={controller.isLoadingHistory}
              placeholder={conversationPlaceholder}
              footer={composerFooter}
            />
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
