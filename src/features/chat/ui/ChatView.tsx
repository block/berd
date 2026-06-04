import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { PinIcon } from "lucide-react";
import { toast } from "sonner";
import { MessageTimeline } from "./MessageTimeline";
import { ChatInput } from "./ChatInput";
import { LoadingGoose } from "./LoadingGoose";
import { ChatLoadingSkeleton } from "./ChatLoadingSkeleton";
import { ConversationEmptyAvatar } from "./ConversationEmptyAvatar";
import { ArtifactPolicyProvider } from "../hooks/ArtifactPolicyContext";
import { ChatRightRail } from "./ChatRightRail";
import { useChatContextPanelCompactViewport } from "./ChatContextPanel";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import { perfLog } from "@/shared/lib/perfLog";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { useChatSessionController } from "../hooks/useChatSessionController";
import {
  useChatSessionStore,
  type ChatSession,
} from "../stores/chatSessionStore";
import { TerminalPanel } from "@/features/terminal/ui/TerminalPanel";
import {
  queueTerminalCommand,
  runCommandInTerminalSession,
} from "@/features/terminal/lib/terminalSessionManager";
import { useGitState } from "@/shared/hooks/useGitState";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import type { AgentSourceEntry } from "@/shared/api/agents";
import { ActiveChatGooseIndicator } from "@/shared/ui/SessionActivityIndicator";

const CHAT_COMPOSER_SHELL_CLASS =
  "rounded-composer bg-surface-chat-composer shadow-[var(--shadow-chat-composer)] [backdrop-filter:var(--backdrop-composer-glass)] [-webkit-backdrop-filter:var(--backdrop-composer-glass)]";
const CHAT_RESPONDING_PILL_CLASS =
  "rounded-full bg-surface-chat-responding-pill-bg text-surface-chat-responding-pill-fg shadow-[var(--shadow-chat)]";
const CHAT_RESPONDING_GOOSE_CLASS =
  "[filter:var(--filter-chat-responding-goose)]";

interface TerminalWorkspaceState {
  paths: string[];
  expandedPath: string | null;
}

const TERMINAL_WORKSPACE_STORAGE_KEY_PREFIX = "goose:chat-terminal-workspaces";

const DEFAULT_TERMINAL_WORKSPACE_STATE: TerminalWorkspaceState = {
  paths: [],
  expandedPath: null,
};

function validateTerminalWorkspaceState(
  value: unknown,
  defaults: TerminalWorkspaceState,
): TerminalWorkspaceState {
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const parsed = value as Partial<TerminalWorkspaceState>;
  const paths = Array.isArray(parsed.paths)
    ? parsed.paths.filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      )
    : defaults.paths;
  const uniquePaths = Array.from(new Set(paths));
  const expandedPath =
    typeof parsed.expandedPath === "string" &&
    uniquePaths.includes(parsed.expandedPath)
      ? parsed.expandedPath
      : null;

  return {
    paths: uniquePaths,
    expandedPath,
  };
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
}

export function ChatView({
  sessionId,
  activeSession,
  readOnlyStatus,
  onCreatePersona,
  onAgentBuilderSaved,
  onAgentBuilderClose,
  onCreateProject,
}: ChatViewProps) {
  const { t } = useTranslation("chat");
  const mountStart = useRef(performance.now());
  const previousTerminalCwdRef = useRef<string | null>(null);
  const setTopBarActions = useSetTopBarActions();
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
    unpinFromHome,
  } = usePinToHomeWidget({ kind: "chat", id: sessionId });
  const controller = useChatSessionController({
    sessionId,
    readOnly: Boolean(readOnlyStatus),
    onCreatePersonaRequested: onCreatePersona,
  });
  const effectiveSession = controller.session ?? activeSession ?? null;
  const isContextPanelOpen = useChatSessionStore((s) => s.isContextPanelOpen);
  const setContextPanelOpen = useChatSessionStore((s) => s.setContextPanelOpen);
  const terminalWorkspacePath = useChatSessionStore((s) =>
    effectiveSession?.id
      ? (s.activeWorkspaceBySession[effectiveSession.id]?.path ?? null)
      : null,
  );
  const isContextPanelCompactViewport = useChatContextPanelCompactViewport();
  const [terminalWorkspaceState, setTerminalWorkspaceState] =
    usePersistedState<TerminalWorkspaceState>(
      `${TERMINAL_WORKSPACE_STORAGE_KEY_PREFIX}:${sessionId}`,
      DEFAULT_TERMINAL_WORKSPACE_STATE,
      validateTerminalWorkspaceState,
    );
  const isAgentBuilderSession =
    effectiveSession?.intent === "build-agent" &&
    Boolean(
      effectiveSession.targetAgentPath && effectiveSession.targetAgentSlug,
    );
  const hasVisibleRightRail =
    isAgentBuilderSession ||
    Boolean(
      effectiveSession?.id &&
        isContextPanelOpen &&
        !isContextPanelCompactViewport,
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
  const terminalCwd =
    terminalWorkspacePath ??
    effectiveSession?.workingDir ??
    controller.project?.workingDirs?.[0] ??
    null;
  const {
    data: terminalGitState,
    isLoading: terminalGitLoading,
    isFetching: terminalGitFetching,
  } = useGitState(terminalCwd, Boolean(effectiveSession?.id && terminalCwd));
  const terminalAvailable = Boolean(terminalCwd && terminalGitState?.isGitRepo);
  const terminalWorkspacePaths = terminalWorkspaceState.paths;
  const expandedTerminalPath = terminalWorkspaceState.expandedPath;
  const activeWorkspaceHasTerminal = terminalCwd
    ? terminalWorkspacePaths.includes(terminalCwd)
    : false;
  const orderedTerminalPaths = terminalCwd
    ? [
        ...terminalWorkspacePaths.filter((path) => path === terminalCwd),
        ...terminalWorkspacePaths.filter((path) => path !== terminalCwd),
      ]
    : terminalWorkspacePaths;
  const terminalVisible = orderedTerminalPaths.length > 0;

  const toggleTerminal = useCallback(() => {
    if (!terminalCwd) {
      toast.message(t("terminal.noWorkspace"));
      return;
    }

    if ((terminalGitLoading || terminalGitFetching) && !terminalGitState) {
      toast.message(t("terminal.checkingWorkspace"));
      return;
    }

    if (!terminalAvailable) {
      toast.message(t("terminal.gitOnly"));
      return;
    }

    setTerminalWorkspaceState((state) => {
      const paths = state.paths.includes(terminalCwd)
        ? state.paths
        : [...state.paths, terminalCwd];
      return {
        paths,
        expandedPath: state.expandedPath === terminalCwd ? null : terminalCwd,
      };
    });
  }, [
    terminalAvailable,
    terminalCwd,
    terminalGitFetching,
    terminalGitLoading,
    terminalGitState,
    setTerminalWorkspaceState,
    t,
  ]);

  useEffect(() => {
    const ms = (performance.now() - mountStart.current).toFixed(1);
    perfLog(`[perf:chatview] ${sessionId.slice(0, 8)} mounted in ${ms}ms`);
  }, [sessionId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "j" ||
        event.shiftKey ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey)
      ) {
        return;
      }

      event.preventDefault();
      toggleTerminal();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleTerminal]);

  useEffect(() => {
    const previousTerminalCwd = previousTerminalCwdRef.current;
    previousTerminalCwdRef.current = terminalCwd;
    if (!previousTerminalCwd || previousTerminalCwd === terminalCwd) {
      return;
    }

    setTerminalWorkspaceState((state) =>
      state.expandedPath === previousTerminalCwd
        ? { ...state, expandedPath: null }
        : state,
    );
  }, [setTerminalWorkspaceState, terminalCwd]);

  const handleCollapseTerminal = useCallback(
    (path: string) => {
      setTerminalWorkspaceState((state) =>
        state.expandedPath === path ? { ...state, expandedPath: null } : state,
      );
    },
    [setTerminalWorkspaceState],
  );

  const handleExpandTerminal = useCallback(
    (path: string) => {
      setTerminalWorkspaceState((state) => ({
        ...state,
        expandedPath: path,
      }));
    },
    [setTerminalWorkspaceState],
  );

  const handleCloseTerminal = useCallback(
    (path: string) => {
      setTerminalWorkspaceState((state) => {
        const paths = state.paths.filter(
          (existingPath) => existingPath !== path,
        );
        return {
          paths,
          expandedPath: state.expandedPath === path ? null : state.expandedPath,
        };
      });
    },
    [setTerminalWorkspaceState],
  );
  const handleCloseContextPanel = useCallback(() => {
    if (!effectiveSession?.id) {
      return;
    }

    setContextPanelOpen(effectiveSession.id, false);
  }, [effectiveSession?.id, setContextPanelOpen]);

  const handleRunShellCommand = useCallback(
    (command: string) => {
      if (!terminalCwd) {
        toast.message(t("terminal.noWorkspace"));
        return;
      }

      if ((terminalGitLoading || terminalGitFetching) && !terminalGitState) {
        toast.message(t("terminal.checkingWorkspace"));
        return;
      }

      if (!terminalAvailable) {
        toast.message(t("terminal.gitOnly"));
        return;
      }

      const sessionKey = `${sessionId}:${terminalCwd}`;
      if (!runCommandInTerminalSession(sessionKey, command)) {
        queueTerminalCommand(sessionKey, command);
      }

      setTerminalWorkspaceState((state) => {
        const paths = state.paths.includes(terminalCwd)
          ? state.paths
          : [...state.paths, terminalCwd];
        return {
          paths,
          expandedPath: terminalCwd,
        };
      });
    },
    [
      sessionId,
      setTerminalWorkspaceState,
      terminalAvailable,
      terminalCwd,
      terminalGitFetching,
      terminalGitLoading,
      terminalGitState,
      t,
    ],
  );

  const showIndicator =
    controller.chatState === "thinking" ||
    controller.chatState === "streaming" ||
    controller.chatState === "waiting" ||
    controller.chatState === "compacting";
  const shouldShowLoadingIndicator =
    showIndicator && !controller.isLoadingHistory;
  const loadingChatState = controller.chatState as
    | "thinking"
    | "streaming"
    | "waiting"
    | "compacting";
  const agentBuilderEmptyPrompt = t("emptyState.buildAgentPrompt");
  const agentBuilderComposerPlaceholder = t("input.agentBuilderPlaceholder");
  const isReadOnly = Boolean(readOnlyStatus);
  let sendDisabledReason: string | undefined;
  if (readOnlyStatus) {
    sendDisabledReason = readOnlyStatus;
  } else if (effectiveSession?.creationState === "pending") {
    sendDisabledReason = t("toolbar.sessionStarting");
  } else if (effectiveSession?.creationState === "failed") {
    sendDisabledReason =
      effectiveSession.creationError ?? t("toolbar.sessionStartFailed");
  }

  useEffect(() => {
    const label = isPinnedToHome
      ? t("pinToHome.unpin")
      : isPinningToHome
        ? t("pinToHome.pinning")
        : t("pinToHome.action");

    setTopBarActions(
      <Button
        type="button"
        variant="page-header"
        size="xs"
        onClick={() => (isPinnedToHome ? unpinFromHome() : void pinToHome())}
        disabled={isPinningToHome}
        aria-label={label}
        title={label}
        leftIcon={<PinIcon aria-hidden="true" />}
      >
        {label}
      </Button>,
    );

    return () => setTopBarActions(null);
  }, [
    isPinnedToHome,
    isPinningToHome,
    pinToHome,
    setTopBarActions,
    t,
    unpinFromHome,
  ]);

  // The composer is owned by the timeline so it stays mounted across loading,
  // empty, and populated states without losing focus or draft text.
  const footerStatus = readOnlyStatus ? (
    <div
      className={cn(
        "flex h-8 items-center gap-2 px-3 text-sm",
        CHAT_RESPONDING_PILL_CLASS,
      )}
    >
      <ActiveChatGooseIndicator
        size={14}
        className={CHAT_RESPONDING_GOOSE_CLASS}
      />
      <span>{readOnlyStatus}</span>
    </div>
  ) : shouldShowLoadingIndicator ? (
    <AnimatePresence initial={false}>
      <div
        className={cn(
          "flex h-8 items-center gap-2 px-3",
          CHAT_RESPONDING_PILL_CLASS,
        )}
      >
        <ActiveChatGooseIndicator
          size={14}
          className={CHAT_RESPONDING_GOOSE_CLASS}
        />
        <LoadingGoose
          key="loading-indicator"
          chatState={loadingChatState}
          className="mb-0 px-0"
        />
      </div>
    </AnimatePresence>
  ) : null;
  const composerFooter = (
    <div className="px-4">
      <div
        className={cn(
          "pointer-events-auto mx-auto w-full max-w-[var(--chat-composer-max-width)]",
          CHAT_COMPOSER_SHELL_CLASS,
        )}
      >
        <ChatInput
          surface="bare"
          placeholder={
            isAgentBuilderSession ? agentBuilderComposerPlaceholder : undefined
          }
          controls={
            isReadOnly
              ? {
                  agentModelPicker: false,
                  attachments: false,
                  autoFocus: false,
                  fileMentions: false,
                  projectPicker: false,
                  skills: false,
                  voice: false,
                }
              : effectiveSession?.intent === "build-agent"
                ? {
                    agentModelPicker: false,
                    projectPicker: false,
                  }
                : undefined
          }
          composerActions={{
            onSend: controller.handleSend,
            onSendNow: controller.sendNow,
            onSendQueuedNow: controller.sendQueuedNow,
            disabled:
              isReadOnly ||
              controller.projectMetadataPending ||
              controller.isCompactingContext,
            sendDisabled: isReadOnly || effectiveSession?.creationState != null,
            sendDisabledReason,
            queuedMessage: controller.queue.queuedMessage,
            onDismissQueue: controller.queue.dismiss,
            onStop: isReadOnly ? undefined : controller.stopStreaming,
            isStreaming:
              !isReadOnly &&
              (controller.chatState === "streaming" ||
                controller.chatState === "thinking"),
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
  );

  const conversationPlaceholder = controller.isLoadingHistory ? (
    <ChatLoadingSkeleton />
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
      <p className="text-3xl font-normal text-foreground">
        {isAgentBuilderSession
          ? agentBuilderEmptyPrompt
          : t("emptyState.startAConversation")}
      </p>
    </div>
  );
  const messageTimeline = (
    <MessageTimeline
      messages={controller.messages}
      streamingMessageId={controller.streamingMessageId}
      scrollTargetMessageId={controller.scrollTarget?.messageId ?? null}
      scrollTargetQuery={controller.scrollTarget?.query ?? null}
      onScrollTargetHandled={controller.handleScrollTargetHandled}
      onSendMcpAppMessage={isReadOnly ? undefined : controller.handleSend}
      onRunShellCommand={
        !isReadOnly && terminalAvailable ? handleRunShellCommand : undefined
      }
      showPlaceholder={controller.isLoadingHistory}
      placeholder={conversationPlaceholder}
      footer={composerFooter}
      footerStatus={footerStatus}
    />
  );

  return (
    <ArtifactPolicyProvider
      messages={controller.messages}
      sessionCwd={controller.sessionArtifactCwd}
    >
      <div
        className={cn(
          "page-transition flex h-full min-w-0 px-[var(--spacing-app-panel-gutter-inline)] pb-[var(--spacing-app-panel-gutter-bottom)] pt-[var(--spacing-app-panel-gutter-top)]",
          hasVisibleRightRail && "gap-[var(--spacing-app-panel-gutter-inline)]",
        )}
      >
        <div
          className={cn(
            "relative flex min-w-0 flex-1 flex-col",
            isAgentBuilderSession && "agent-builder-column-enter",
          )}
          style={agentBuilderChatColumnStyle}
        >
          <div className="relative flex min-h-0 flex-1 flex-col overflow-visible">
            {messageTimeline}
          </div>
          {terminalVisible ? (
            <div className="flex shrink-0 flex-col gap-2">
              {orderedTerminalPaths.map((path) => {
                const terminalExpanded = expandedTerminalPath === path;
                return (
                  <div
                    key={path}
                    onTransitionEnd={(event) => {
                      if (
                        event.target !== event.currentTarget ||
                        event.propertyName !== "height"
                      ) {
                        return;
                      }

                      const terminalElement = event.currentTarget.querySelector(
                        "[data-terminal-panel]",
                      );
                      terminalElement?.dispatchEvent(
                        new CustomEvent("goose-terminal-shell-transition-end", {
                          bubbles: true,
                        }),
                      );
                    }}
                    className={cn(
                      "shrink-0 overflow-hidden transition-[height] duration-200 ease-out will-change-[height] motion-reduce:transition-none",
                      terminalExpanded
                        ? "h-[clamp(220px,34vh,320px)]"
                        : "h-10 [&_.goose-terminal]:hidden",
                    )}
                  >
                    <TerminalPanel
                      sessionKey={`${sessionId}:${path}`}
                      cwd={path}
                      collapsed={!terminalExpanded}
                      onCollapse={() => handleCollapseTerminal(path)}
                      onExpand={() => handleExpandTerminal(path)}
                      onClose={() => handleCloseTerminal(path)}
                      className="h-full rounded-md bg-card"
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <ChatRightRail
          session={effectiveSession}
          project={controller.project}
          sessionWorkingDir={effectiveSession?.workingDir}
          onDraftPromoted={onAgentBuilderSaved}
          onAgentBuilderClose={onAgentBuilderClose}
          builderColumnClassName={
            isAgentBuilderSession ? "agent-builder-column-enter" : undefined
          }
          builderColumnStyle={agentBuilderRailColumnStyle}
          terminalOpen={activeWorkspaceHasTerminal}
          onRequestCloseContextPanel={handleCloseContextPanel}
          onToggleTerminal={toggleTerminal}
        />
      </div>
    </ArtifactPolicyProvider>
  );
}
