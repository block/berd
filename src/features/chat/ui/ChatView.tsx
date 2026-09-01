import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { AnimatePresence } from "motion/react";
import { IconLayoutSidebarLeftCollapse } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ChatSearchBar } from "./ChatSearchBar";
import { ChatTranscriptSurface } from "./ChatTranscriptSurface";
import { RemoteHostConnectionBanner } from "./RemoteHostConnectionBanner";
import { LoadingBerd } from "./LoadingBerd";
import { ChatRightRail } from "./ChatRightRail";
import {
  ARTIFACT_VIEWER_RAIL_ALLOWANCE_PX,
  ArtifactViewerPanel,
  CONVERSATION_MIN_WIDTH_WITH_VIEWER,
} from "./ArtifactViewerPanel";
import { useOpenArtifact } from "../stores/artifactViewerStore";
import { ArtifactAutoOpenMount } from "./ArtifactAutoOpenMount";
import {
  CP_TOTAL_W,
  useChatContextPanelCompactViewport,
} from "./ChatContextPanel";
import { useFocusRegion } from "@/app/focus/FocusRegionProvider";
import { perfLog } from "@/shared/lib/perfLog";
import { Badge } from "@/shared/ui/badge";
import { cn } from "@/shared/lib/cn";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import type { WorkspaceNameRequest } from "../hooks/useChatSessionController";
import {
  ConversationComposerCapability,
  useConversationComposerBinding,
} from "../capabilities/ConversationComposerCapability";
import { useResizableAgentBuilderRail } from "../hooks/useResizableAgentBuilderRail";
import { useWorkspaceRepository } from "@/features/workspaces/workspaceRepository";
import { useChangeSessionFolder } from "../hooks/useChangeSessionFolder";
import { isRemoteSession } from "../lib/remoteSession";
import {
  useChatSessionStore,
  type ChatSession,
} from "../stores/chatSessionStore";
import { TerminalCapability } from "@/features/terminal/capabilities/TerminalCapability";
import { useTerminalController } from "@/features/terminal/hooks/useTerminalController";
import { TerminalDockPreview } from "@/features/terminal/ui/TerminalDockPreview";
import {
  getDefaultTerminalDockedPlacement,
  isTerminalDockDropZone,
  type TerminalDockedPlacement,
} from "@/features/terminal/model/terminalState";
import { useTerminalFallbackCwdPreference } from "@/features/terminal/lib/terminalCwdPreference";
import { ActiveChatBerdIndicator } from "@/shared/ui/SessionActivityIndicator";
import { getTextContent } from "@/shared/types/messages";
import { getConversationBeforeForMessageFork } from "@/features/sessions/lib/sessionFork";
import type { ForkSessionHandler } from "@/features/sessions/hooks/useForkSession";
import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";
import { useChatTranscriptSearch } from "@/features/chat/hooks/useChatTranscriptSearch";
import {
  isAgentBuilderVisible,
  isContextPanelVisible,
} from "@/features/chat/lib/chatCapabilityVisibility";
import type { TranscriptSearchBackend } from "@/features/chat/lib/transcriptSearchBackend";
import type { GlobalComposerHandoffRect } from "@/shared/ui/GlobalComposerPill";
import { useVoiceConversationController } from "@/features/voice-conversation/hooks/useVoiceConversationController";
import { usePocketVoiceSetup } from "@/features/voice-conversation/hooks/usePocketVoiceSetup";
import { useMacSpeechSetup } from "@/features/voice-conversation/hooks/useMacSpeechSetup";
import { useOpenAiVoiceSetup } from "@/features/voice-conversation/hooks/useOpenAiVoiceSetup";
import { useSiriVoiceSetup } from "@/features/voice-conversation/hooks/useSiriVoiceSetup";
import {
  isMacSpeechAvailable,
  useVoiceInputPreference,
} from "@/features/voice-conversation/lib/voiceInputPreference";
import { useVoiceOutputPreference } from "@/features/voice-conversation/lib/voiceOutputPreference";
import { isVoiceSetupReady } from "@/features/voice-conversation/lib/voiceSetupReadiness";
import { useProfileCapabilities } from "@/shared/profile/capabilities";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import {
  SecurityConfirmationPanel,
  useRegisterSecurityConfirmationSurface,
} from "@/features/security/ui/SecurityConfirmationPanel";

const CHAT_RESPONDING_PILL_CLASS =
  "rounded-full bg-surface-chat-responding-pill-bg text-surface-chat-responding-pill-fg shadow-[var(--shadow-chat)] [--shimmer-ink:var(--color-surface-chat-responding-pill-fg)]";
const CLOSED_RIGHT_RAIL_DOCK_TARGET_WIDTH_PX = 48;
interface ChatViewProps {
  sessionId: string;
  activeSession?: ChatSession | null;
  readOnlyStatus?: string;
  onCreatePersona?: () => void;
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
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
  onAgentBuilderCompleted?: (agentId: string) => void;
}

export function ChatView({
  sessionId,
  activeSession,
  readOnlyStatus,
  onCreatePersona,
  onCreateProject,
  onOpenProjectSettings,
  onForkChat,
  leftViewportOcclusionPx = 0,
  composerHandoffRequest = 0,
  composerHandoffSessionId = null,
  composerHandoffActive = false,
  composerHandoffInProgress = false,
  onComposerHandoffTarget,
  onWorkspaceNameRequest,
  onAgentBuilderCompleted,
}: ChatViewProps) {
  const { t } = useTranslation("chat");
  useRegisterSecurityConfirmationSurface(sessionId);
  const isArtifactViewerOpen = useOpenArtifact(sessionId) !== null;
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
  const composerBinding = useConversationComposerBinding({
    target: {
      kind: "existingSession",
      sessionId,
      sessionSnapshot: activeSession,
      readOnlyReason: readOnlyStatus,
    },
    onCreatePersonaRequested: onCreatePersona,
    onWorkspaceNameRequest,
  });
  const { controller, admissionBlocked, onSend } = composerBinding;
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
  const isReadOnly = Boolean(readOnlyStatus);
  // A remote session's cwd and artifact paths live on its SSH host: the
  // in-chat terminal (a local PTY), local folder pickers, and local file
  // auto-open would all act on the wrong machine, so their affordances are
  // withheld below (v1 — no ssh terminals or remote file loads).
  const sessionIsRemote = isRemoteSession(effectiveSession);
  // While the viewer panel is open it occupies row width much like the
  // sidebar occludes the viewport: include its floor allowance in the
  // compact-mode query so the right rail only docks when rail + viewer +
  // conversation genuinely fit side by side. Below that, the rail uses its
  // own compact overlay behavior instead of overflowing the row.
  const agentBuilderOpenForLayout = isAgentBuilderVisible(effectiveSession, {
    readOnly: isReadOnly,
  });
  const chatRowOcclusionPx =
    leftViewportOcclusionPx +
    (isArtifactViewerOpen ? ARTIFACT_VIEWER_RAIL_ALLOWANCE_PX : 0) +
    (agentBuilderOpenForLayout ? CP_TOTAL_W : 0);
  const isContextPanelCompactViewport =
    useChatContextPanelCompactViewport(chatRowOcclusionPx);
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
  const capabilities = useProfileCapabilities();
  const sessionSurveyOpportunityRateBasisPoints = useRuntimeConfigStore(
    (state) => state.config.feedback?.sessionSurveySamplingRateBasisPoints ?? 0,
  );
  const pocketVoiceSetup = usePocketVoiceSetup(capabilities.voiceConversation);
  const macSpeechSetup = useMacSpeechSetup(capabilities.voiceConversation);
  const voiceInput = useVoiceInputPreference(
    isMacSpeechAvailable(macSpeechSetup.status, macSpeechSetup.loading),
  );
  const voiceOutput = useVoiceOutputPreference();
  const openAiVoiceSetup = useOpenAiVoiceSetup(
    capabilities.voiceConversation &&
      (voiceInput.backend === "openai" || voiceOutput.backend === "openai"),
  );
  const siriVoiceSetup = useSiriVoiceSetup(
    capabilities.voiceConversation && voiceOutput.backend === "siri",
  );
  const voiceReady = isVoiceSetupReady(
    pocketVoiceSetup.status,
    macSpeechSetup.status,
    siriVoiceSetup.status,
    voiceInput.backend,
    voiceOutput.backend,
    openAiVoiceSetup.status,
  );
  const voiceAdmissionPermanentlyBlocked =
    composerBinding.target.kind === "existingSession" &&
    Boolean(composerBinding.target.admission.blockingReason);
  const voiceDeliveryTemporarilyBlocked =
    !voiceAdmissionPermanentlyBlocked &&
    ((composerBinding.target.kind === "existingSession" &&
      composerBinding.target.admission.securityConfirmationPending) ||
      controller.projectMetadataPending ||
      controller.isCompactingContext ||
      controller.isLoadingHistory ||
      !controller.workspaceContextReady ||
      controller.queue.queuedMessage !== null);
  const voiceConversation = useVoiceConversationController({
    sessionId,
    // Voice delivery only needs to wait for admission. Holding its per-session
    // queue through the full run would prevent later utterances from steering
    // the active run.
    onSend,
    enabled: capabilities.voiceConversation,
    isGooseSession: controller.selectedProvider === "goose",
    pocketReady: voiceReady,
    inputBackend: voiceInput.backend,
    siriVoice:
      siriVoiceSetup.status?.selectedVoiceInstalled === true
        ? siriVoiceSetup.status.selectedVoice
        : null,
    onPocketSetupRequired: () => {
      requestOpenSettings("voice", {
        returnTarget: { type: "voice-setup", sessionId },
      });
    },
    readOnly: Boolean(readOnlyStatus),
    routeBlocked: voiceDeliveryTemporarilyBlocked,
    routeUnavailable: voiceAdmissionPermanentlyBlocked,
    disabled: admissionBlocked || voiceDeliveryTemporarilyBlocked,
  });
  const isAgentBuilderOpen = agentBuilderOpenForLayout;
  const patchSession = useChatSessionStore((s) => s.patchSession);
  const agentBuilderContextState = effectiveSession?.agentBuilderContextState;
  const contextVisible = isContextPanelVisible(
    effectiveSession,
    isRightRailOpen,
    { readOnly: isReadOnly },
  );

  useEffect(() => {
    if (
      !isAgentBuilderOpen ||
      !effectiveSession?.id ||
      agentBuilderContextState != null
    ) {
      return;
    }

    patchSession(effectiveSession.id, {
      agentBuilderContextState: "autoClosed",
    });
  }, [
    agentBuilderContextState,
    effectiveSession?.id,
    isAgentBuilderOpen,
    patchSession,
  ]);

  // The two-column builder layout below keys off *visibility* (main's
  // capability model can close the builder while the session keeps its
  // build-agent intent), so a closed builder renders as a normal chat row.
  const isAgentBuilderSession = isAgentBuilderOpen;
  // When editing an agent, the chat column can be collapsed so the builder rail
  // takes the full surface. This is per-session view state that intentionally
  // does NOT persist across app restarts. Editing an existing agent seeds the
  // collapsed state (agentBuilderChatStartCollapsed); creating a new agent
  // opens in the default split view. Keyed by sessionId so switching resets it.
  // `initialized` guards against clobbering a user toggle once the session
  // metadata (which may arrive after mount) resolves.
  const startCollapsed = Boolean(
    effectiveSession?.agentBuilderChatStartCollapsed,
  );
  const [chatCollapseState, setChatCollapseState] = useState<{
    sessionId: string;
    collapsed: boolean;
    initialized: boolean;
  }>({
    sessionId,
    collapsed: startCollapsed,
    initialized: isAgentBuilderSession,
  });
  if (chatCollapseState.sessionId !== sessionId) {
    setChatCollapseState({
      sessionId,
      collapsed: startCollapsed,
      initialized: isAgentBuilderSession,
    });
  } else if (!chatCollapseState.initialized && isAgentBuilderSession) {
    // Session metadata resolved after mount — seed from the edit hint once.
    setChatCollapseState({
      sessionId,
      collapsed: startCollapsed,
      initialized: true,
    });
  }
  const isAgentBuilderChatCollapsed =
    isAgentBuilderSession &&
    chatCollapseState.sessionId === sessionId &&
    chatCollapseState.collapsed;
  const toggleAgentBuilderChat = useCallback(() => {
    setChatCollapseState((current) =>
      current.sessionId === sessionId
        ? { ...current, collapsed: !current.collapsed, initialized: true }
        : { sessionId, collapsed: true, initialized: true },
    );
  }, [sessionId]);
  const {
    railFraction: builderRailFraction,
    isResizingRail: isResizingBuilderRail,
    separatorProps: builderRailSeparatorProps,
  } = useResizableAgentBuilderRail();
  // Two-column split for agent-builder sessions is driven by an animated CSS
  // grid template. Every state uses pure `fr` units (which interpolate) so
  // collapse/expand and drag-resize tween smoothly without jumping:
  //  - collapsed        → chat track goes to 0fr, builder fills the surface
  //  - after a drag     → tracks split by the stored fraction
  //  - default (equal)  → 50/50 split
  const builderFraction = builderRailFraction ?? 0.5;
  const agentBuilderGridTemplate = isAgentBuilderChatCollapsed
    ? "0fr 1fr"
    : `${1 - builderFraction}fr ${builderFraction}fr`;
  const hasVisibleRightRail =
    isAgentBuilderOpen ||
    Boolean(
      effectiveSession?.id && contextVisible && !isContextPanelCompactViewport,
    );
  // Each column slides in from the side it lives on — chat from the left
  // (negative offset), builder rail from the right — over a short distance
  // with a soft stagger. The entrance should read as the panels settling
  // into place, not flying in (BOT-1501 found the old bottom-up rise too
  // fast and aggressive).
  const agentBuilderChatColumnStyle = isAgentBuilderOpen
    ? ({
        "--agent-builder-column-enter-delay": "0ms",
        "--agent-builder-column-enter-x": "-16px",
      } as CSSProperties)
    : undefined;
  const agentBuilderRailColumnStyle = isAgentBuilderOpen
    ? ({
        "--agent-builder-column-enter-delay": "90ms",
        "--agent-builder-column-enter-x": "24px",
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
  // Never hand the terminal a remote session's cwd: the PTY spawns locally,
  // so it would either fail or land in an unrelated local directory.
  const terminalCwd = sessionIsRemote
    ? null
    : (terminalWorkspacePath ??
      sessionTerminalCwd ??
      projectTerminalCwd ??
      null);

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
    // No terminal shortcut for remote sessions — there is no local cwd to
    // open a PTY in, and the affordance is hidden everywhere else too.
    if (sessionIsRemote) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (eventMatchesShortcutCommand(event, "view.toggleTerminal")) {
        event.preventDefault();
        handleToggleTerminal();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleToggleTerminal, sessionIsRemote]);

  const handleCloseRightRail = useCallback(() => {
    if (!effectiveSession?.id || !contextVisible) return;
    const focusedInsideRail = rightRailRef.current?.contains(
      document.activeElement,
    );
    setRightRailOpen(false);
    if (focusedInsideRail) focusChatComposer();
  }, [
    contextVisible,
    effectiveSession?.id,
    focusChatComposer,
    setRightRailOpen,
  ]);

  const handleOpenContextPanel = useCallback(() => {
    if (!effectiveSession?.id) return;
    if (isAgentBuilderOpen) {
      patchSession(effectiveSession.id, {
        agentBuilderContextState: "userOpened",
      });
    }
    setRightRailOpen(true);
  }, [
    effectiveSession?.id,
    isAgentBuilderOpen,
    patchSession,
    setRightRailOpen,
  ]);

  // Missing-folder recovery notices carry a "Change folder" action; opening
  // the folder picker directly resolves them, so route the action straight
  // to the picker instead of just revealing the context panel (BOT-1471).
  const changeFolderSessionId = effectiveSession?.id ?? sessionId;
  const { changeFolder: handleChangeFolder } = useChangeSessionFolder(
    changeFolderSessionId,
    {
      defaultPath: terminalWorkspacePath ?? effectiveSession?.workingDir,
      attachWorkspace:
        workspaceRepository.mode === "multi" &&
        Boolean(controller.project?.name),
    },
  );
  const onTimelineChangeFolder =
    !isReadOnly && !sessionIsRemote && changeFolderSessionId
      ? handleChangeFolder
      : undefined;

  const shouldShowLoadingIndicator =
    !controller.isLoadingHistory &&
    (controller.chatState === "thinking" ||
      controller.chatState === "streaming" ||
      controller.chatState === "waiting" ||
      controller.chatState === "compacting");
  const loadingChatState = controller.chatState as
    | "thinking"
    | "streaming"
    | "waiting"
    | "compacting";
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
          motionPreset="responding"
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
          composerHandoffActive && "invisible pointer-events-none",
        )}
      >
        {sessionIsRemote &&
        effectiveSession?.remoteHost &&
        !effectiveSession.creationState ? (
          <RemoteHostConnectionBanner
            host={effectiveSession.remoteHost}
            sessionId={effectiveSession.id}
          />
        ) : null}
        <SecurityConfirmationPanel sessionId={sessionId} />
        <ConversationComposerCapability
          binding={composerBinding}
          renderingPolicy={{
            presentation: {
              surface: "bare",
              innerBareSurface: true,
              providerColumnMode: "gated",
            },
            lifecycleConstraints: {
              handoff: {
                active: composerHandoffActive,
                inProgress: composerHandoffInProgress,
              },
              voiceConversation,
            },
          }}
          onCreateProject={onCreateProject}
          onRecallLastUserMessage={
            isReadOnly ? undefined : handleRecallLastUserMessage
          }
          attachmentDropTargetRef={conversationDropTargetRef}
          onAttachmentDragOverChange={setConversationAttachmentDragOver}
        />
      </div>
    </div>
  );

  const timelineSessionId = effectiveSession?.id ?? sessionId;
  const messageTimeline = (
    <ChatTranscriptSurface
      sessionId={timelineSessionId}
      messages={controller.messages}
      sessionCreatedAt={effectiveSession?.createdAt}
      sessionSurveySamplingRateBasisPoints={
        isReadOnly || !capabilities.feedbackSurveys
          ? 0
          : sessionSurveyOpportunityRateBasisPoints
      }
      streamingMessageId={controller.streamingMessageId}
      responsePending={shouldShowLoadingIndicator}
      isLoadingHistory={controller.isLoadingHistory}
      selectedPersona={controller.selectedPersona}
      sessionCwd={controller.sessionArtifactCwd}
      scrollTargetMessageId={controller.scrollTarget?.messageId ?? null}
      scrollTargetQuery={controller.scrollTarget?.query ?? null}
      onScrollTargetHandled={controller.handleScrollTargetHandled}
      searchContentRef={transcriptSearchRootRef}
      searchBackendRef={transcriptSearchBackendRef}
      onSendMcpAppMessage={
        composerBinding.admissionBlocked ? undefined : composerBinding.onSend
      }
      onRunShellCommand={
        !isReadOnly && terminalAvailable ? handleRunShellCommand : undefined
      }
      onEditProject={onOpenProjectSettings}
      onChangeFolder={onTimelineChangeFolder}
      onOpenContextPanel={handleOpenContextPanel}
      onForkFromMessage={
        !isReadOnly && onForkChat ? handleForkFromMessage : undefined
      }
      suppressEmptyPlaceholder={suppressEmptyConversationPlaceholder}
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
    <>
      <ArtifactAutoOpenMount
        // Remote artifacts cannot be read locally, so never auto-open the
        // viewer for them; a null session absorbs appearances silently.
        sessionId={sessionIsRemote ? null : sessionId}
        isHistoryLoading={controller.isLoadingHistory}
        sessionCwd={controller.sessionArtifactCwd}
      />
      <div
        // The builder's resize divider measures this element to map pointer x
        // to a column fraction. It resolves the element by this attribute
        // rather than by counting parentElement hops, so inserting a wrapper
        // between the divider and this grid cannot silently corrupt the math.
        data-agent-builder-grid={isAgentBuilderSession ? "" : undefined}
        className={cn(
          // @container: the chat row is a size container so the viewer/
          // conversation min-width floors (cqw units) resolve against the
          // row's actual width — sidebar occlusion included — not the
          // viewport.
          "@container h-full min-w-0 px-[var(--spacing-app-panel-gutter-inline)] pb-[var(--spacing-app-panel-gutter-bottom)] pt-[var(--spacing-app-panel-gutter-top)]",
          !composerHandoffActive && "page-transition",
          // Agent-builder sessions lay out as a two-column grid so the chat can
          // slide in/out and the builder can be resized via the grid template.
          isAgentBuilderSession ? "grid" : "flex",
          !isAgentBuilderSession &&
            (effectiveHasVisibleRightRail || isArtifactViewerOpen) &&
            "gap-[var(--spacing-app-panel-gutter-inline)]",
        )}
        style={
          isAgentBuilderSession
            ? ({
                gridTemplateColumns: agentBuilderGridTemplate,
                // Collapse the inter-column gap to 0 when the chat is hidden so
                // the builder truly fills the surface; animate it in step with
                // the tracks so nothing jumps.
                columnGap: isAgentBuilderChatCollapsed
                  ? "0px"
                  : "var(--spacing-app-panel-gutter-inline)",
                transition: isResizingBuilderRail
                  ? "none"
                  : "grid-template-columns 240ms cubic-bezier(0.22, 1, 0.36, 1), column-gap 240ms cubic-bezier(0.22, 1, 0.36, 1)",
              } as CSSProperties)
            : undefined
        }
      >
        <div
          ref={chatColumnRef}
          data-chat-column
          className={cn(
            "relative flex min-w-0 flex-col",
            !isAgentBuilderSession && "flex-1",
            isAgentBuilderSession && "agent-builder-column-enter",
            // While editing an agent the chat lives in a grid track that can
            // animate to zero width; clip its contents so the slide reads
            // cleanly. Kept mounted (not unmounted) so composer draft/focus
            // state survives the collapse/expand toggle.
            isAgentBuilderSession && "overflow-hidden",
          )}
          // `inert` (vs aria-hidden) removes the collapsed chat from the tab
          // order, pointer events, and the a11y tree in one step, so keyboard
          // and screen-reader users can't land in the invisible zero-width
          // panel while its focusable children stay mounted.
          inert={isAgentBuilderChatCollapsed ? true : undefined}
          style={{
            ...agentBuilderChatColumnStyle,
            // While the viewer is open, the conversation keeps a readable
            // floor; the viewer panel is the flex child that yields (down to
            // its own floor) when the row tightens. Skipped for agent-builder
            // sessions, where the grid track must be free to collapse to 0.
            ...(isArtifactViewerOpen && !isAgentBuilderSession
              ? { minWidth: CONVERSATION_MIN_WIDTH_WITH_VIEWER }
              : null),
          }}
        >
          <div
            ref={conversationDropTargetRef}
            className={cn(
              "relative flex min-h-0 flex-1 flex-col overflow-visible rounded-md bg-card",
              terminal.visible && !terminal.isFloating && "min-h-[280px]",
            )}
          >
            {isAgentBuilderSession ? (
              <button
                type="button"
                aria-label={t("agentBuilder.hideChat")}
                title={t("agentBuilder.hideChat")}
                onClick={toggleAgentBuilderChat}
                className="absolute right-3 top-3 z-30 inline-flex size-7 items-center justify-center rounded-full bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <IconLayoutSidebarLeftCollapse
                  className="size-4"
                  aria-hidden="true"
                />
              </button>
            ) : null}
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

        {sessionId && !isAgentBuilderSession ? (
          <ArtifactViewerPanel sessionId={sessionId} />
        ) : null}

        <ChatRightRail
          ref={rightRailRef}
          session={effectiveSession}
          project={controller.project}
          sessionWorkingDir={
            workspaceRepository.chatWorkspaces(effectiveSession).primary
              ?.path ?? effectiveSession?.workingDir
          }
          contextVisible={contextVisible}
          agentBuilderReadOnly={isReadOnly}
          agentBuilderChatCollapsed={isAgentBuilderChatCollapsed}
          builderRailSeparatorProps={builderRailSeparatorProps}
          onExpandAgentBuilderChat={toggleAgentBuilderChat}
          onAgentBuilderCompleted={onAgentBuilderCompleted}
          builderColumnClassName={
            isAgentBuilderOpen ? "agent-builder-column-enter" : undefined
          }
          builderColumnStyle={agentBuilderRailColumnStyle}
          terminalOpen={terminal.activeWorkspaceHasTerminal}
          contextPanelLeftViewportOcclusionPx={chatRowOcclusionPx}
          onRequestCloseRightRail={handleCloseRightRail}
          onToggleTerminal={sessionIsRemote ? undefined : handleToggleTerminal}
          terminalController={terminal}
          terminalDockPreview={terminalDockPreview}
          terminalRootRef={terminalRootRef}
          getTerminalDockTargetForPointer={getTerminalDockTargetForPointer}
          onTerminalDockPreviewChange={setTerminalDockPreview}
          onTerminalDockToRegion={handleTerminalDockToRegion}
          onOpenTerminalAtPath={
            sessionIsRemote ? undefined : handleOpenTerminalAtPath
          }
        />
      </div>
    </>
  );
}
