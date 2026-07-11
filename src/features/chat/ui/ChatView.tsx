import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { VirtualMessageTimelineGate } from "./VirtualMessageTimelineGate";
import { ChatSearchBar } from "./ChatSearchBar";
import { ChatInput } from "./ChatInput";
import { LoadingBerd } from "./LoadingBerd";
import { ChatLoadingSkeleton } from "./ChatLoadingSkeleton";
import { ConversationEmptyAvatar } from "./ConversationEmptyAvatar";
import { ArtifactPolicyProvider } from "../hooks/ArtifactPolicyContext";
import { ChatRightRail } from "./ChatRightRail";
import { useChatContextPanelCompactViewport } from "./ChatContextPanel";
import { useFocusRegion } from "@/app/focus/FocusRegionProvider";
import { perfLog } from "@/shared/lib/perfLog";
import { Badge } from "@/shared/ui/badge";
import { cn } from "@/shared/lib/cn";
import { useChatSessionController } from "../hooks/useChatSessionController";
import { useWorkspaceRepository } from "@/features/workspaces/workspaceRepository";
import {
  useChatSessionStore,
  type ChatSession,
} from "../stores/chatSessionStore";
import type { ChatInputControls } from "../types";
import { TerminalCapability } from "@/features/terminal/capabilities/TerminalCapability";
import { useTerminalController } from "@/features/terminal/hooks/useTerminalController";
import { TerminalDockPreview } from "@/features/terminal/ui/TerminalDockPreview";
import {
  getDefaultTerminalDockedPlacement,
  isTerminalDockDropZone,
  type TerminalDockedPlacement,
} from "@/features/terminal/model/terminalState";
import { useTerminalFallbackCwdPreference } from "@/features/terminal/lib/terminalCwdPreference";
import type { AgentSourceEntry } from "@/shared/api/agents";
import { ActiveChatBerdIndicator } from "@/shared/ui/SessionActivityIndicator";
import { getTextContent } from "@/shared/types/messages";
import { getConversationBeforeForMessageFork } from "@/features/sessions/lib/sessionFork";
import type { ForkSessionHandler } from "@/features/sessions/hooks/useForkSession";
import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";
import { useChatTranscriptSearch } from "@/features/chat/hooks/useChatTranscriptSearch";
import type { TranscriptSearchBackend } from "@/features/chat/lib/transcriptSearchBackend";
import { scheduleAfterNextPaint } from "@/app/lib/scheduleAfterNextPaint";
import type { GlobalComposerHandoffRect } from "@/shared/ui/GlobalComposerPill";

const CHAT_COMPOSER_SHELL_CLASS =
  "rounded-sm bg-surface-chat-composer [backdrop-filter:var(--backdrop-composer-glass)] [-webkit-backdrop-filter:var(--backdrop-composer-glass)]";
const CHAT_RESPONDING_PILL_CLASS =
  "rounded-full bg-surface-chat-responding-pill-bg text-surface-chat-responding-pill-fg shadow-[var(--shadow-chat)] [--shimmer-ink:var(--color-surface-chat-responding-pill-fg)]";
const CLOSED_RIGHT_RAIL_DOCK_TARGET_WIDTH_PX = 48;
function shouldStageInitialTranscript(
  messages: readonly unknown[],
  isLoadingHistory: boolean,
): boolean {
  return messages.length > 0 && !isLoadingHistory;
}

interface ChatViewProps {
  sessionId: string;
  activeSession?: ChatSession | null;
  readOnlyStatus?: string;
  onCreatePersona?: () => void;
  onAgentBuilderSaved?: (source: AgentSourceEntry) => void;
  onAgentBuilderClose?: () => void;
  onCreateProject?: (options?: {
    onCreated?: (projectId: string) => void;
  }) => void;
  onOpenProjectSettings?: (projectId: string) => void;
  onForkChat?: ForkSessionHandler;
  leftViewportOcclusionPx?: number;
  composerHandoffRequest?: number;
  composerHandoffSessionId?: string | null;
  composerHandoffActive?: boolean;
  composerHandoffInProgress?: boolean;
  onComposerHandoffTarget?: (rect: GlobalComposerHandoffRect) => void;
}

export function ChatView({
  sessionId,
  activeSession,
  readOnlyStatus,
  onCreatePersona,
  onAgentBuilderSaved,
  onAgentBuilderClose,
  onCreateProject,
  onOpenProjectSettings,
  onForkChat,
  leftViewportOcclusionPx = 0,
  composerHandoffRequest = 0,
  composerHandoffSessionId = null,
  composerHandoffActive = false,
  composerHandoffInProgress = false,
  onComposerHandoffTarget,
}: ChatViewProps) {
  const { t } = useTranslation("chat");
  const mountStart = useRef(performance.now());
  const terminalRootRef = useRef<HTMLDivElement | null>(null);
  const chatColumnRef = useRef<HTMLDivElement | null>(null);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const conversationDropTargetRef = useRef<HTMLDivElement | null>(null);
  const [conversationAttachmentDragOver, setConversationAttachmentDragOver] =
    useState(false);
  const transcriptSearchRootRef = useRef<HTMLDivElement | null>(null);
  const transcriptSearchBackendRef = useRef<TranscriptSearchBackend | null>(
    null,
  );
  const search = useChatTranscriptSearch(transcriptSearchRootRef, {
    backendRef: transcriptSearchBackendRef,
  });
  const { close: closeSearch } = search;
  const controller = useChatSessionController({
    sessionId,
    readOnly: Boolean(readOnlyStatus),
    onCreatePersonaRequested: onCreatePersona,
  });
  const activeSessionClientSessionId = activeSession?.clientSessionId ?? null;

  useLayoutEffect(() => {
    const isComposerHandoffTargetSession =
      composerHandoffSessionId !== null &&
      (sessionId === composerHandoffSessionId ||
        activeSessionClientSessionId === composerHandoffSessionId);

    if (
      composerHandoffRequest <= 0 ||
      !composerHandoffInProgress ||
      !isComposerHandoffTargetSession
    ) {
      return;
    }

    let cancelled = false;

    const measure = () => {
      if (cancelled) {
        return;
      }

      const rect = composerShellRef.current?.getBoundingClientRect();
      if (rect) {
        onComposerHandoffTarget?.({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        });
      }
    };

    const frameId = window.requestAnimationFrame(measure);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [
    composerHandoffInProgress,
    composerHandoffRequest,
    activeSessionClientSessionId,
    composerHandoffSessionId,
    onComposerHandoffTarget,
    sessionId,
  ]);
  const workspaceRepository = useWorkspaceRepository();
  const effectiveSession = controller.session ?? activeSession ?? null;
  const isContextPanelCompactViewport = useChatContextPanelCompactViewport(
    leftViewportOcclusionPx,
  );
  const isRightRailOpen = useChatSessionStore((s) => s.isRightRailOpen);
  const setRightRailOpen = useChatSessionStore((s) => s.setRightRailOpen);
  const terminalWorkspacePath = useChatSessionStore((s) =>
    effectiveSession?.id
      ? workspaceRepository.chatWorkspaces(effectiveSession, {
          activePath: s.activeWorkspaceBySession[effectiveSession.id]?.path,
        }).primary?.path
      : null,
  );
  const { fallbackCwd: terminalFallbackCwd } =
    useTerminalFallbackCwdPreference();
  const isAgentBuilderSession = effectiveSession?.intent === "build-agent";
  const isAgentBuilderTargetFailed =
    effectiveSession?.targetAgentDraftState === "failed";
  const isAgentBuilderTargetPending =
    isAgentBuilderSession && !effectiveSession?.targetAgentPath;
  const hasVisibleRightRail =
    isAgentBuilderSession ||
    Boolean(
      effectiveSession?.id && isRightRailOpen && !isContextPanelCompactViewport,
    );
  const agentBuilderChatColumnStyle = isAgentBuilderSession
    ? ({
        "--agent-builder-column-enter-delay": "0ms",
        "--agent-builder-column-enter-y": "48px",
      } as CSSProperties)
    : undefined;
  const agentBuilderRailColumnStyle = isAgentBuilderSession
    ? ({
        "--agent-builder-column-enter-delay": "105ms",
        "--agent-builder-column-enter-y": "72px",
      } as CSSProperties)
    : undefined;
  const projectTerminalCwd = controller.project?.workingDirs?.[0] ?? null;
  const projectHasNoWorkspace = Boolean(
    controller.project && controller.project.workingDirs.length === 0,
  );
  const useConfiguredTerminalFallback =
    Boolean(terminalFallbackCwd) &&
    !terminalWorkspacePath &&
    !projectTerminalCwd &&
    (!effectiveSession?.projectId || projectHasNoWorkspace);
  const sessionTerminalCwd =
    useConfiguredTerminalFallback && terminalFallbackCwd
      ? terminalFallbackCwd
      : effectiveSession?.workingDir;
  const terminalCwd =
    terminalWorkspacePath ?? sessionTerminalCwd ?? projectTerminalCwd ?? null;

  // When a user action closes/collapses the terminal there is nowhere else
  // meaningful to land focus, so return it to the chat composer.
  const focusChatComposer = useCallback(() => {
    const composer = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='chat-composer']:not(:disabled)",
    );
    composer?.focus();
  }, []);

  const terminal = useTerminalController({
    sessionId,
    cwd: terminalCwd,
    onFocusReturn: focusChatComposer,
  });
  const rightRailRef = useRef<HTMLDivElement | null>(null);
  const [terminalDockPreview, setTerminalDockPreview] =
    useState<TerminalDockedPlacement | null>(null);
  const terminalInRightRail =
    terminal.placement.kind === "docked" &&
    terminal.placement.region === "rightRail";
  const effectiveHasVisibleRightRail = hasVisibleRightRail;
  const getTerminalDockTargetForPointer = useCallback(
    (clientX: number, clientY: number): TerminalDockedPlacement | null => {
      const rightRailRect = rightRailRef.current?.getBoundingClientRect();
      if (rightRailRect) {
        const dockTargetLeft = effectiveHasVisibleRightRail
          ? rightRailRect.left
          : rightRailRect.right - CLOSED_RIGHT_RAIL_DOCK_TARGET_WIDTH_PX;
        if (
          clientX >= dockTargetLeft &&
          clientX <= rightRailRect.right &&
          clientY >= rightRailRect.top &&
          clientY <= rightRailRect.bottom
        ) {
          return getDefaultTerminalDockedPlacement("rightRail");
        }
      }

      const chatColumnRect = chatColumnRef.current?.getBoundingClientRect();
      if (
        chatColumnRect &&
        clientX >= chatColumnRect.left &&
        clientX <= chatColumnRect.right &&
        isTerminalDockDropZone(clientY)
      ) {
        return getDefaultTerminalDockedPlacement("chatColumn");
      }

      return null;
    },
    [effectiveHasVisibleRightRail],
  );
  const terminalAvailable = terminal.available;
  useEffect(() => {
    if (!terminal.isFloating && terminalDockPreview) {
      setTerminalDockPreview(null);
    }
  }, [terminal.isFloating, terminalDockPreview]);

  useEffect(() => {
    const ms = (performance.now() - mountStart.current).toFixed(1);
    perfLog(`[perf:chatview] ${sessionId.slice(0, 8)} mounted in ${ms}ms`);
  }, [sessionId]);

  // ChatView remounts per session via its key upstream; this covers the one
  // in-place id change (draft promotion) defensively. close() no-ops when
  // the bar is not open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the re-close trigger.
  useEffect(() => {
    closeSearch();
  }, [closeSearch, sessionId]);

  const openRightRailForTerminal = useCallback(() => {
    if (!effectiveSession?.id || !terminalInRightRail) return;
    setRightRailOpen(true);
  }, [effectiveSession?.id, setRightRailOpen, terminalInRightRail]);

  const handleToggleTerminal = useCallback(() => {
    if (terminalInRightRail && !isRightRailOpen) {
      openRightRailForTerminal();
      terminal.expand();
      return;
    }
    terminal.toggle();
  }, [
    isRightRailOpen,
    openRightRailForTerminal,
    terminal.expand,
    terminal.toggle,
    terminalInRightRail,
  ]);

  const handleRunShellCommand = useCallback(
    (command: string, options?: { newTerminal?: boolean }) => {
      openRightRailForTerminal();
      terminal.runCommand(command, options);
    },
    [openRightRailForTerminal, terminal.runCommand],
  );

  const handleOpenTerminalAtPath = useCallback(
    (path: string) => {
      openRightRailForTerminal();
      terminal.openAtPath(path);
    },
    [openRightRailForTerminal, terminal.openAtPath],
  );
  const handleTerminalDockToRegion = useCallback(
    (region: TerminalDockedPlacement["region"]) => {
      if (region === "rightRail" && effectiveSession?.id) {
        setRightRailOpen(true);
      }
    },
    [effectiveSession?.id, setRightRailOpen],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (eventMatchesShortcutCommand(event, "view.toggleTerminal")) {
        event.preventDefault();
        handleToggleTerminal();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleToggleTerminal]);

  const handleCloseRightRail = useCallback(() => {
    if (!effectiveSession?.id) return;
    const focusedInsideRail = rightRailRef.current?.contains(
      document.activeElement,
    );
    setRightRailOpen(false);
    if (focusedInsideRail) focusChatComposer();
  }, [effectiveSession?.id, focusChatComposer, setRightRailOpen]);

  const handleOpenContextPanel = useCallback(() => {
    if (!effectiveSession?.id) return;
    setRightRailOpen(true);
  }, [effectiveSession?.id, setRightRailOpen]);

  const showIndicator =
    controller.chatState === "thinking" ||
    controller.chatState === "streaming" ||
    controller.chatState === "waiting" ||
    controller.chatState === "compacting";
  const loadingChatState = controller.chatState as
    | "thinking"
    | "streaming"
    | "waiting"
    | "compacting";
  const agentBuilderEmptyPrompt = t("emptyState.buildAgentPrompt");
  const agentBuilderComposerPlaceholder = t("input.agentBuilderPlaceholder");
  const isReadOnly = Boolean(readOnlyStatus);
  const chatInputControls = useMemo<ChatInputControls | undefined>(() => {
    if (isReadOnly) {
      return {
        agentModelPicker: false,
        attachments: false,
        autoFocus: false,
        fileMentions: false,
        projectPicker: false,
        skills: false,
        voice: false,
      };
    }

    if (effectiveSession?.intent === "build-agent") {
      return {
        agentModelPicker: false,
        ...(composerHandoffActive ? { autoFocus: false } : {}),
        projectPicker: false,
      };
    }

    if (!controller.skillsEnabled || composerHandoffActive) {
      return {
        ...(!controller.skillsEnabled ? { skills: false } : {}),
        ...(composerHandoffActive ? { autoFocus: false } : {}),
      };
    }

    return undefined;
  }, [
    composerHandoffActive,
    controller.skillsEnabled,
    effectiveSession?.intent,
    isReadOnly,
  ]);
  const shouldStageTranscript = shouldStageInitialTranscript(
    controller.messages,
    controller.isLoadingHistory,
  );
  const [initialTranscriptGate, setInitialTranscriptGate] = useState(() => ({
    sessionId,
    pending: shouldStageTranscript,
  }));
  const isPreparingInitialTranscript =
    initialTranscriptGate.sessionId === sessionId
      ? initialTranscriptGate.pending
      : shouldStageTranscript;
  const showTimelineLoading =
    controller.isLoadingHistory || isPreparingInitialTranscript;
  const shouldShowLoadingIndicator = showIndicator && !showTimelineLoading;
  const timelineMessages = isPreparingInitialTranscript
    ? []
    : controller.messages;
  const suppressEmptyConversationPlaceholder =
    composerHandoffInProgress || controller.queue.queuedMessage !== null;
  const handleForkFromMessage = useCallback(
    (messageId: string) => {
      if (isReadOnly || !effectiveSession?.id || !onForkChat) {
        return;
      }

      const conversationBefore = getConversationBeforeForMessageFork(
        controller.messages,
        messageId,
      );
      if (conversationBefore == null) {
        return;
      }

      void onForkChat(effectiveSession.id, { conversationBefore });
    },
    [controller.messages, effectiveSession?.id, isReadOnly, onForkChat],
  );

  // Only gate the first render for a session. Later live updates should stream
  // into the mounted timeline without showing the skeleton again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset signal for the initial transcript gate.
  useEffect(() => {
    const pending = shouldStageInitialTranscript(
      controller.messages,
      controller.isLoadingHistory,
    );

    setInitialTranscriptGate((current) =>
      current.sessionId === sessionId && current.pending === pending
        ? current
        : { sessionId, pending },
    );

    if (!pending) {
      return;
    }

    return scheduleAfterNextPaint(() => {
      setInitialTranscriptGate((current) =>
        current.sessionId === sessionId && current.pending
          ? { sessionId, pending: false }
          : current,
      );
    });
  }, [sessionId]);

  let sendDisabledReason: string | undefined;
  if (readOnlyStatus) {
    sendDisabledReason = readOnlyStatus;
  } else if (effectiveSession?.creationState === "pending") {
    sendDisabledReason = t("toolbar.sessionStarting");
  } else if (effectiveSession?.creationState === "failed") {
    sendDisabledReason =
      effectiveSession.creationError ?? t("toolbar.sessionStartFailed");
  } else if (isAgentBuilderTargetFailed) {
    sendDisabledReason = t("toolbar.agentBuilderPrepareFailed");
  } else if (isAgentBuilderTargetPending) {
    sendDisabledReason = t("toolbar.agentBuilderPreparing");
  }

  // The composer is owned by the timeline so it stays mounted across loading,
  // empty, and populated states without losing focus or draft text.
  const footerStatus = composerHandoffActive ? null : readOnlyStatus ? (
    <div
      className={cn(
        "chat-response-status-enter flex h-8 items-center gap-2 px-3 text-sm",
        CHAT_RESPONDING_PILL_CLASS,
      )}
    >
      <ActiveChatBerdIndicator size={14} />
      <span>{readOnlyStatus}</span>
    </div>
  ) : shouldShowLoadingIndicator ? (
    <AnimatePresence initial={false}>
      <div
        className={cn(
          "chat-response-status-enter flex h-8 items-center gap-2 px-3",
          CHAT_RESPONDING_PILL_CLASS,
        )}
      >
        <ActiveChatBerdIndicator size={14} />
        <LoadingBerd
          key="loading-indicator"
          chatState={loadingChatState}
          className="mb-0 px-0"
        />
      </div>
    </AnimatePresence>
  ) : null;

  // ↑-to-edit: recall the text of the most recent user message in this session.
  const handleRecallLastUserMessage = useCallback((): string | null => {
    const msgs = controller.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role === "user") {
        const text = getTextContent(msg).trim();
        if (text.length > 0) return text;
      }
    }
    return null;
  }, [controller.messages]);

  const composerFooter = (
    <div className="px-[var(--spacing-app-panel-gutter-inline)] pb-[var(--spacing-app-panel-gutter-inline)]">
      <div
        ref={composerShellRef}
        className={cn(
          "pointer-events-auto mx-auto w-full max-w-[var(--chat-composer-max-width)]",
          CHAT_COMPOSER_SHELL_CLASS,
          composerHandoffActive && "invisible pointer-events-none",
        )}
      >
        <ChatInput
          surface="bare"
          placeholder={
            isAgentBuilderSession ? agentBuilderComposerPlaceholder : undefined
          }
          controls={chatInputControls}
          skillProjectDirs={controller.skillProjectDirs}
          fileMentionProjectDirs={controller.fileMentionProjectDirs}
          skillProviderId={controller.selectedProvider}
          composerActions={{
            onSend: controller.handleSend,
            onSteerMessage: controller.steerDraftMessage,
            canSteerMessage: controller.canSteerMessage,
            onSteerQueuedMessage: controller.steerQueuedMessage,
            canSteerQueuedMessage: controller.canSteerQueuedMessage,
            disabled:
              isReadOnly ||
              controller.projectMetadataPending ||
              controller.isCompactingContext,
            sendDisabled:
              isReadOnly ||
              effectiveSession?.creationState != null ||
              isAgentBuilderTargetPending,
            sendDisabledReason,
            queuedMessage: composerHandoffInProgress
              ? null
              : controller.queue.queuedMessage,
            onDismissQueue: composerHandoffInProgress
              ? undefined
              : controller.queue.dismiss,
            onStop: isReadOnly ? undefined : controller.stopStreaming,
            isStreaming:
              !isReadOnly &&
              (controller.chatState === "streaming" ||
                controller.chatState === "thinking"),
          }}
          onRecallLastUserMessage={
            isReadOnly ? undefined : handleRecallLastUserMessage
          }
          attachmentDropTargetRef={conversationDropTargetRef}
          onAttachmentDragOverChange={setConversationAttachmentDragOver}
          initialValue={controller.draftValue}
          initialAttachments={controller.draftAttachments}
          onDraftChange={controller.handleDraftChange}
          onDraftAttachmentsChange={controller.handleDraftAttachmentsChange}
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
          reasoningEffort={{
            config: controller.reasoningEffort,
            onChange: controller.handleReasoningEffortChange,
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
            accumulatedCost: controller.tokenState.accumulatedCost,
            isContextUsageReady: controller.isContextUsageReady,
            onCompactContext: controller.compactConversation,
            canCompactContext: controller.canCompactContext,
            isCompactingContext: controller.isCompactingContext,
            supportsCompactionControls: controller.supportsCompactionControls,
          }}
        />
      </div>
    </div>
  );

  const conversationPlaceholder = showTimelineLoading ? (
    <ChatLoadingSkeleton />
  ) : suppressEmptyConversationPlaceholder ? (
    <div className="flex w-full flex-1" aria-hidden="true" />
  ) : (
    <div className="flex w-full flex-1 flex-col items-center justify-center px-6">
      <AnimatePresence initial={false}>
        {!isAgentBuilderSession && controller.selectedPersona ? (
          <motion.div
            key="conversation-empty-avatar"
            className="overflow-hidden"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
          >
            <div className="pb-4">
              <ConversationEmptyAvatar persona={controller.selectedPersona} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <p className="text-sm font-normal text-foreground">
        {isAgentBuilderSession
          ? agentBuilderEmptyPrompt
          : t("emptyState.startAConversation")}
      </p>
    </div>
  );
  const timelineSessionId = effectiveSession?.id ?? sessionId;
  const messageTimeline = (
    <VirtualMessageTimelineGate
      sessionId={timelineSessionId}
      messages={timelineMessages}
      streamingMessageId={controller.streamingMessageId}
      scrollTargetMessageId={controller.scrollTarget?.messageId ?? null}
      scrollTargetQuery={controller.scrollTarget?.query ?? null}
      onScrollTargetHandled={controller.handleScrollTargetHandled}
      searchContentRef={transcriptSearchRootRef}
      searchBackendRef={transcriptSearchBackendRef}
      onSendMcpAppMessage={isReadOnly ? undefined : controller.handleSend}
      onRunShellCommand={
        !isReadOnly && terminalAvailable ? handleRunShellCommand : undefined
      }
      onEditProject={onOpenProjectSettings}
      onOpenContextPanel={
        // The builder rail replaces the context panel for fully-targeted
        // agent-builder sessions, so opening it would silently no-op.
        isAgentBuilderSession ? undefined : handleOpenContextPanel
      }
      onForkFromMessage={
        !isReadOnly && onForkChat ? handleForkFromMessage : undefined
      }
      showPlaceholder={showTimelineLoading}
      placeholder={conversationPlaceholder}
      footer={composerFooter}
      footerStatus={footerStatus}
    />
  );
  useFocusRegion({
    id: "terminal",
    label: "terminal",
    key: "t",
    enabled: terminal.visible && terminal.expanded,
    element: terminal.terminalRegionElement,
    getInitialFocus: () => {
      const terminalPanel =
        terminal.terminalRegionElement?.querySelector<HTMLElement>(
          "[data-terminal-panel]",
        ) ?? null;
      terminalPanel?.dispatchEvent(new CustomEvent("goose-terminal-focus"));
      return (
        terminal.terminalRegionElement?.querySelector<HTMLElement>(
          ".xterm-helper-textarea, .xterm textarea, textarea",
        ) ??
        terminalPanel ??
        terminal.terminalRegionElement?.querySelector<HTMLElement>(
          "button:not(:disabled)",
        ) ??
        null
      );
    },
  });

  return (
    <ArtifactPolicyProvider
      messages={timelineMessages}
      sessionCwd={controller.sessionArtifactCwd}
    >
      <div
        className={cn(
          "flex h-full min-w-0 px-[var(--spacing-app-panel-gutter-inline)] pb-[var(--spacing-app-panel-gutter-bottom)] pt-[var(--spacing-app-panel-gutter-top)]",
          !composerHandoffActive && "page-transition",
          effectiveHasVisibleRightRail &&
            "gap-[var(--spacing-app-panel-gutter-inline)]",
        )}
      >
        <div
          ref={chatColumnRef}
          data-chat-column
          className={cn(
            "relative flex min-w-0 flex-1 flex-col",
            isAgentBuilderSession && "agent-builder-column-enter",
          )}
          style={agentBuilderChatColumnStyle}
        >
          <div
            ref={conversationDropTargetRef}
            className={cn(
              "relative flex min-h-0 flex-1 flex-col overflow-visible rounded-md bg-card",
              terminal.visible && !terminal.isFloating && "min-h-[280px]",
            )}
          >
            {messageTimeline}
            {conversationAttachmentDragOver ? (
              <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-md border border-dashed border-border/80 bg-surface-glass-subtle p-6 [backdrop-filter:var(--backdrop-glass-subtle)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 [-webkit-backdrop-filter:var(--backdrop-glass-subtle)]">
                <Badge variant="inverse">{t("attachments.dropToAttach")}</Badge>
              </div>
            ) : null}
            {search.isOpen ? (
              <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4 sm:justify-end sm:px-[var(--chat-transcript-inline-padding)]">
                <ChatSearchBar
                  query={search.query}
                  totalMatches={search.matchCount}
                  activeMatchIndex={search.activeMatchIndex}
                  isIndexing={search.isIndexing}
                  announcedTotalMatches={search.announcedMatchCount}
                  announcedActiveMatchIndex={search.announcedActiveMatchIndex}
                  announcedIsIndexing={search.announcedIsIndexing}
                  focusSignal={search.focusSignal}
                  onQueryChange={search.setQuery}
                  onNext={search.goToNext}
                  onPrevious={search.goToPrevious}
                  onClose={closeSearch}
                />
              </div>
            ) : null}
          </div>
          {terminal.visible &&
          terminal.isFloating &&
          terminalDockPreview?.region === "chatColumn" ? (
            <TerminalDockPreview
              height={terminalDockPreview.size.height}
              surface="chatColumn"
            />
          ) : null}
          {terminal.visible && !terminalInRightRail ? (
            <div
              ref={terminalRootRef}
              className={cn(
                terminal.isFloating
                  ? "contents"
                  : "mt-[var(--spacing-app-panel-gutter-inline)] flex min-h-0 shrink flex-col gap-2",
              )}
            >
              <TerminalCapability
                controller={terminal}
                rootRef={terminalRootRef}
                sessionId={sessionId}
                getDockTargetForPointer={getTerminalDockTargetForPointer}
                onDockPreviewChange={setTerminalDockPreview}
                onDockToRegion={handleTerminalDockToRegion}
              />
            </div>
          ) : null}
        </div>

        <ChatRightRail
          ref={rightRailRef}
          session={effectiveSession}
          project={controller.project}
          sessionWorkingDir={
            workspaceRepository.chatWorkspaces(effectiveSession).primary
              ?.path ?? effectiveSession?.workingDir
          }
          onDraftPromoted={onAgentBuilderSaved}
          onAgentBuilderClose={onAgentBuilderClose}
          builderColumnClassName={
            isAgentBuilderSession ? "agent-builder-column-enter" : undefined
          }
          builderColumnStyle={agentBuilderRailColumnStyle}
          terminalOpen={terminal.activeWorkspaceHasTerminal}
          contextPanelLeftViewportOcclusionPx={leftViewportOcclusionPx}
          onRequestCloseRightRail={handleCloseRightRail}
          onToggleTerminal={handleToggleTerminal}
          terminalController={terminal}
          terminalDockPreview={terminalDockPreview}
          terminalRootRef={terminalRootRef}
          getTerminalDockTargetForPointer={getTerminalDockTargetForPointer}
          onTerminalDockPreviewChange={setTerminalDockPreview}
          onTerminalDockToRegion={handleTerminalDockToRegion}
          onOpenTerminalAtPath={handleOpenTerminalAtPath}
        />
      </div>
    </ArtifactPolicyProvider>
  );
}
