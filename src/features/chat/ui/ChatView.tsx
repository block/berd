import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { PinIcon, SearchIcon } from "lucide-react";
import {
  IconChevronDown,
  IconChevronUp,
  IconPlus,
  IconRotateClockwise,
  IconX,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { VirtualMessageTimelineGate } from "./VirtualMessageTimelineGate";
import { ChatSearchBar } from "./ChatSearchBar";
import { ChatInput } from "./ChatInput";
import { LoadingGoose } from "./LoadingGoose";
import { ChatLoadingSkeleton } from "./ChatLoadingSkeleton";
import { ConversationEmptyAvatar } from "./ConversationEmptyAvatar";
import { ArtifactPolicyProvider } from "../hooks/ArtifactPolicyContext";
import { ChatRightRail } from "./ChatRightRail";
import { useChatContextPanelCompactViewport } from "./ChatContextPanel";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import { useFocusRegion } from "@/app/focus/FocusRegionProvider";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import { perfLog } from "@/shared/lib/perfLog";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/lib/cn";
import { useChatSessionController } from "../hooks/useChatSessionController";
import {
  useChatSessionStore,
  type ChatSession,
} from "../stores/chatSessionStore";
import { TerminalPanel } from "@/features/terminal/ui/TerminalPanel";
import {
  queueTerminalCommand,
  restartTerminalSession,
  runCommandInTerminalSession,
  stopTerminalSession,
  subscribeTerminalSessionStatus,
} from "@/features/terminal/lib/terminalSessionManager";
import { useTerminalFallbackCwdPreference } from "@/features/terminal/lib/terminalCwdPreference";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import type { AgentSourceEntry } from "@/shared/api/agents";
import { ActiveChatGooseIndicator } from "@/shared/ui/SessionActivityIndicator";
import { getTextContent } from "@/shared/types/messages";
import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";
import { useChatTranscriptSearch } from "@/features/chat/hooks/useChatTranscriptSearch";
import type { TranscriptSearchBackend } from "@/features/chat/lib/transcriptSearchBackend";
import { scheduleAfterNextPaint } from "@/app/lib/scheduleAfterNextPaint";

const CHAT_COMPOSER_SHELL_CLASS =
  "rounded-sm bg-surface-chat-composer [backdrop-filter:var(--backdrop-composer-glass)] [-webkit-backdrop-filter:var(--backdrop-composer-glass)]";
const CHAT_RESPONDING_PILL_CLASS =
  "rounded-full bg-surface-chat-responding-pill-bg text-surface-chat-responding-pill-fg shadow-[var(--shadow-chat)]";
const CHAT_RESPONDING_GOOSE_CLASS =
  "[filter:var(--filter-chat-responding-goose)]";
const TERMINAL_HEADER_ICON_BUTTON_CLASS =
  "rounded-md text-muted-foreground opacity-70 hover:text-foreground hover:opacity-100 data-[state=open]:text-foreground data-[state=open]:opacity-100 aria-expanded:text-muted-foreground";

interface TerminalWorkspaceTab {
  id: string;
  cwd: string;
}

interface TerminalWorkspaceState {
  tabs: TerminalWorkspaceTab[];
  activeTabId: string | null;
  expanded: boolean;
}

const TERMINAL_WORKSPACE_STORAGE_KEY_PREFIX = "goose:chat-terminal-workspaces";

const DEFAULT_TERMINAL_WORKSPACE_STATE: TerminalWorkspaceState = {
  tabs: [],
  activeTabId: null,
  expanded: false,
};

let terminalTabIdSequence = 0;

function hashTerminalTabPath(path: string): string {
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function createLegacyTerminalTabId(cwd: string, index: number): string {
  return `legacy-${index}-${hashTerminalTabPath(cwd)}`;
}

function createTerminalTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `tab-${crypto.randomUUID()}`;
  }

  terminalTabIdSequence += 1;
  return `tab-${Date.now().toString(36)}-${terminalTabIdSequence.toString(36)}`;
}

function createTerminalTab(cwd: string): TerminalWorkspaceTab {
  return {
    id: createTerminalTabId(),
    cwd,
  };
}

function appendActiveTerminalTab(
  state: TerminalWorkspaceState,
  tab: TerminalWorkspaceTab,
): TerminalWorkspaceState {
  return {
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
    expanded: true,
  };
}

function removeTerminalTab(
  state: TerminalWorkspaceState,
  tabId: string,
): TerminalWorkspaceState {
  const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (closedIndex === -1) {
    return state;
  }

  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) {
    return DEFAULT_TERMINAL_WORKSPACE_STATE;
  }

  const activeTabStillOpen = tabs.some((tab) => tab.id === state.activeTabId);
  const nearestTab = tabs[Math.min(closedIndex, tabs.length - 1)];
  return {
    tabs,
    activeTabId: activeTabStillOpen ? state.activeTabId : nearestTab.id,
    expanded: state.expanded,
  };
}

function normalizeTerminalTabs(tabs: unknown[]): TerminalWorkspaceTab[] {
  const seenIds = new Set<string>();

  return tabs.reduce<TerminalWorkspaceTab[]>((normalizedTabs, item, index) => {
    if (!item || typeof item !== "object") {
      return normalizedTabs;
    }

    const tab = item as Partial<TerminalWorkspaceTab>;
    if (typeof tab.cwd !== "string" || tab.cwd.length === 0) {
      return normalizedTabs;
    }

    const baseId =
      typeof tab.id === "string" && tab.id.length > 0
        ? tab.id
        : createLegacyTerminalTabId(tab.cwd, index);
    let id = baseId;
    let duplicateIndex = 1;
    while (seenIds.has(id)) {
      duplicateIndex += 1;
      id = `${baseId}-${duplicateIndex}`;
    }

    seenIds.add(id);
    normalizedTabs.push({ id, cwd: tab.cwd });
    return normalizedTabs;
  }, []);
}

function findDefaultTerminalTab(
  tabs: TerminalWorkspaceTab[],
  cwd: string | null,
): TerminalWorkspaceTab | null {
  if (!cwd) {
    return null;
  }

  return tabs.find((tab) => tab.cwd === cwd) ?? null;
}

function shortenTerminalPath(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 2) {
    return normalized || path;
  }

  return `~/${segments.slice(-2).join("/")}`;
}

function terminalTabLabel(
  tab: TerminalWorkspaceTab,
  tabs: TerminalWorkspaceTab[],
): string {
  const baseLabel = shortenTerminalPath(tab.cwd);
  const matchingTabs = tabs.filter((candidate) => candidate.cwd === tab.cwd);
  if (matchingTabs.length <= 1) {
    return baseLabel;
  }

  const duplicateIndex =
    matchingTabs.findIndex((candidate) => candidate.id === tab.id) + 1;
  return `${baseLabel} (${duplicateIndex})`;
}

function terminalTabButtonId(tabId: string): string {
  return `terminal-tab-${tabId}`;
}

function terminalTabPanelId(tabId: string): string {
  return `terminal-tabpanel-${tabId}`;
}

function shouldStageInitialTranscript(
  messages: readonly unknown[],
  isLoadingHistory: boolean,
): boolean {
  return messages.length > 0 && !isLoadingHistory;
}

function validateTerminalWorkspaceState(
  value: unknown,
  defaults: TerminalWorkspaceState,
): TerminalWorkspaceState {
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const parsed = value as Partial<TerminalWorkspaceState>;
  if (Array.isArray(parsed.tabs)) {
    const tabs = normalizeTerminalTabs(parsed.tabs);
    const activeTabId =
      typeof parsed.activeTabId === "string" &&
      tabs.some((tab) => tab.id === parsed.activeTabId)
        ? parsed.activeTabId
        : (tabs[0]?.id ?? null);

    return {
      tabs,
      activeTabId,
      expanded: tabs.length > 0 && parsed.expanded === true,
    };
  }

  const legacyParsed = value as {
    paths?: unknown;
    expandedPath?: unknown;
  };
  const legacyPaths = Array.isArray(legacyParsed.paths)
    ? legacyParsed.paths.filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      )
    : [];
  const uniquePaths = Array.from(new Set(legacyPaths));
  const tabs = uniquePaths.map((cwd, index) => ({
    id: createLegacyTerminalTabId(cwd, index),
    cwd,
  }));
  const activeTab =
    typeof legacyParsed.expandedPath === "string"
      ? (tabs.find((tab) => tab.cwd === legacyParsed.expandedPath) ?? null)
      : null;

  return {
    tabs,
    activeTabId: activeTab?.id ?? tabs[0]?.id ?? defaults.activeTabId,
    expanded: Boolean(activeTab),
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
  onOpenProjectSettings?: (projectId: string) => void;
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
}: ChatViewProps) {
  const { t } = useTranslation("chat");
  const mountStart = useRef(performance.now());
  const terminalRootRef = useRef<HTMLDivElement | null>(null);
  const [closingTerminalTabId, setClosingTerminalTabId] = useState<
    string | null
  >(null);
  const transcriptSearchRootRef = useRef<HTMLDivElement | null>(null);
  const transcriptSearchBackendRef = useRef<TranscriptSearchBackend | null>(
    null,
  );
  const search = useChatTranscriptSearch(transcriptSearchRootRef, {
    backendRef: transcriptSearchBackendRef,
  });
  const { open: openSearch, close: closeSearch } = search;
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
  const isContextPanelCompactViewport = useChatContextPanelCompactViewport();
  const isContextPanelOpen = useChatSessionStore((s) => s.isContextPanelOpen);
  const setContextPanelOpen = useChatSessionStore((s) => s.setContextPanelOpen);
  const terminalWorkspacePath = useChatSessionStore((s) =>
    effectiveSession?.id
      ? (s.activeWorkspaceBySession[effectiveSession.id]?.path ?? null)
      : null,
  );
  const { fallbackCwd: terminalFallbackCwd } =
    useTerminalFallbackCwdPreference();
  const [terminalRegionElement, setTerminalRegionElement] =
    useState<HTMLDivElement | null>(null);
  const [terminalWorkspaceState, setTerminalWorkspaceState] =
    usePersistedState<TerminalWorkspaceState>(
      `${TERMINAL_WORKSPACE_STORAGE_KEY_PREFIX}:${sessionId}`,
      DEFAULT_TERMINAL_WORKSPACE_STATE,
      validateTerminalWorkspaceState,
    );
  const terminalWorkspaceStateRef = useRef(terminalWorkspaceState);
  useEffect(() => {
    terminalWorkspaceStateRef.current = terminalWorkspaceState;
  }, [terminalWorkspaceState]);
  const commitTerminalWorkspaceState = useCallback(
    (
      updater: (state: TerminalWorkspaceState) => TerminalWorkspaceState,
    ): TerminalWorkspaceState => {
      const nextState = updater(terminalWorkspaceStateRef.current);
      terminalWorkspaceStateRef.current = nextState;
      setTerminalWorkspaceState(nextState);
      return nextState;
    },
    [setTerminalWorkspaceState],
  );
  const isAgentBuilderSession = effectiveSession?.intent === "build-agent";
  const isAgentBuilderTargetFailed =
    effectiveSession?.targetAgentDraftState === "failed";
  const isAgentBuilderTargetPending =
    isAgentBuilderSession && !effectiveSession?.targetAgentPath;
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
  const fileMentionRoots = useMemo(() => {
    const roots = new Map<string, string>();
    for (const root of [
      terminalWorkspacePath,
      sessionTerminalCwd,
      ...(controller.project?.workingDirs ?? []),
      terminalCwd,
    ]) {
      const normalizedRoot = root?.trim();
      if (normalizedRoot) roots.set(normalizedRoot, normalizedRoot);
    }
    return Array.from(roots.values());
  }, [
    controller.project?.workingDirs,
    sessionTerminalCwd,
    terminalCwd,
    terminalWorkspacePath,
  ]);
  const terminalAvailable = Boolean(terminalCwd);
  const terminalTabs = terminalWorkspaceState.tabs;
  const activeTerminalTab = useMemo(
    () =>
      terminalTabs.find(
        (tab) => tab.id === terminalWorkspaceState.activeTabId,
      ) ??
      terminalTabs[0] ??
      null,
    [terminalTabs, terminalWorkspaceState.activeTabId],
  );
  const activeWorkspaceHasTerminal = Boolean(
    findDefaultTerminalTab(terminalTabs, terminalCwd),
  );
  const terminalVisible = terminalTabs.length > 0;
  const terminalExpanded = terminalWorkspaceState.expanded;

  const toggleTerminal = useCallback(() => {
    if (!terminalCwd) {
      toast.message(t("terminal.noWorkspace"));
      return;
    }

    commitTerminalWorkspaceState((state) => {
      const defaultTab = findDefaultTerminalTab(state.tabs, terminalCwd);
      if (!defaultTab) {
        return appendActiveTerminalTab(state, createTerminalTab(terminalCwd));
      }

      return {
        ...state,
        activeTabId: defaultTab.id,
        expanded: state.activeTabId === defaultTab.id ? !state.expanded : true,
      };
    });
  }, [commitTerminalWorkspaceState, terminalCwd, t]);

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

  const handleAddTerminalTab = useCallback(() => {
    if (!terminalCwd) {
      toast.message(t("terminal.noWorkspace"));
      return;
    }

    commitTerminalWorkspaceState((state) => {
      return appendActiveTerminalTab(state, createTerminalTab(terminalCwd));
    });
  }, [commitTerminalWorkspaceState, terminalCwd, t]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }

      if (eventMatchesShortcutCommand(event, "view.toggleTerminal")) {
        event.preventDefault();
        toggleTerminal();
        return;
      }

      if (eventMatchesShortcutCommand(event, "terminal.newTab")) {
        const target = event.target;
        const terminalHasFocus =
          target instanceof Node &&
          Boolean(terminalRootRef.current?.contains(target));
        if (!terminalHasFocus) {
          return;
        }

        event.preventDefault();
        handleAddTerminalTab();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleAddTerminalTab, toggleTerminal]);

  const handleSelectTerminalTab = useCallback(
    (tabId: string) => {
      commitTerminalWorkspaceState((state) =>
        state.tabs.some((tab) => tab.id === tabId)
          ? { ...state, activeTabId: tabId, expanded: true }
          : state,
      );
    },
    [commitTerminalWorkspaceState],
  );

  const handleCollapseTerminal = useCallback(() => {
    commitTerminalWorkspaceState((state) =>
      state.expanded ? { ...state, expanded: false } : state,
    );
  }, [commitTerminalWorkspaceState]);

  const handleExpandTerminal = useCallback(() => {
    commitTerminalWorkspaceState((state) =>
      state.tabs.length > 0 ? { ...state, expanded: true } : state,
    );
  }, [commitTerminalWorkspaceState]);

  const handleRemoveTerminalTab = useCallback(
    (tabId: string) => {
      setClosingTerminalTabId(null);
      commitTerminalWorkspaceState((state) => removeTerminalTab(state, tabId));
    },
    [commitTerminalWorkspaceState],
  );

  const handleCloseTerminal = useCallback(
    (tabId: string) => {
      stopTerminalSession(`${sessionId}:${tabId}`, { writeStopped: true });
      handleRemoveTerminalTab(tabId);
    },
    [handleRemoveTerminalTab, sessionId],
  );

  const handleRestartTerminal = useCallback(() => {
    if (!activeTerminalTab) {
      return;
    }

    restartTerminalSession(`${sessionId}:${activeTerminalTab.id}`);
    if (!terminalExpanded) {
      handleExpandTerminal();
    }
  }, [activeTerminalTab, handleExpandTerminal, sessionId, terminalExpanded]);

  useEffect(() => {
    const unsubscribes = terminalTabs.map((tab) =>
      subscribeTerminalSessionStatus(`${sessionId}:${tab.id}`, (change) => {
        if (change.status !== "exited" || change.source !== "backend-exit") {
          return;
        }

        stopTerminalSession(change.key);
        handleRemoveTerminalTab(tab.id);
      }),
    );

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [handleRemoveTerminalTab, sessionId, terminalTabs]);
  const handleCloseContextPanel = useCallback(() => {
    if (!effectiveSession?.id) {
      return;
    }

    setContextPanelOpen(effectiveSession.id, false);
  }, [effectiveSession?.id, setContextPanelOpen]);

  const handleOpenContextPanel = useCallback(() => {
    if (!effectiveSession?.id) {
      return;
    }

    setContextPanelOpen(effectiveSession.id, true);
  }, [effectiveSession?.id, setContextPanelOpen]);

  const handleRunShellCommand = useCallback(
    (command: string, options?: { newTerminal?: boolean }) => {
      if (!terminalCwd) {
        toast.message(t("terminal.noWorkspace"));
        return;
      }

      const nextState = commitTerminalWorkspaceState((state) => {
        if (options?.newTerminal) {
          return appendActiveTerminalTab(state, createTerminalTab(terminalCwd));
        }
        const defaultTab = findDefaultTerminalTab(state.tabs, terminalCwd);
        return defaultTab
          ? { ...state, activeTabId: defaultTab.id, expanded: true }
          : appendActiveTerminalTab(state, createTerminalTab(terminalCwd));
      });

      const targetTab = options?.newTerminal
        ? nextState.tabs[nextState.tabs.length - 1]
        : findDefaultTerminalTab(nextState.tabs, terminalCwd);
      if (!targetTab) {
        return;
      }

      const sessionKey = `${sessionId}:${targetTab.id}`;
      if (!runCommandInTerminalSession(sessionKey, command)) {
        queueTerminalCommand(sessionKey, command);
      }
    },
    [commitTerminalWorkspaceState, sessionId, terminalCwd, t],
  );

  const handleTerminalTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
      const currentIndex = terminalTabs.findIndex((tab) => tab.id === tabId);
      if (currentIndex === -1) {
        return;
      }

      let nextTab: TerminalWorkspaceTab | null = null;
      switch (event.key) {
        case "ArrowRight":
          nextTab = terminalTabs[(currentIndex + 1) % terminalTabs.length];
          break;
        case "ArrowLeft":
          nextTab =
            terminalTabs[
              (currentIndex - 1 + terminalTabs.length) % terminalTabs.length
            ];
          break;
        case "Home":
          nextTab = terminalTabs[0] ?? null;
          break;
        case "End":
          nextTab = terminalTabs.at(-1) ?? null;
          break;
        default:
          return;
      }

      if (!nextTab) {
        return;
      }

      event.preventDefault();
      handleSelectTerminalTab(nextTab.id);
      window.requestAnimationFrame(() => {
        document.getElementById(terminalTabButtonId(nextTab.id))?.focus();
      });
    },
    [handleSelectTerminalTab, terminalTabs],
  );

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

  useEffect(() => {
    const label = isPinnedToHome
      ? t("pinToHome.unpin")
      : isPinningToHome
        ? t("pinToHome.pinning")
        : t("pinToHome.action");

    setTopBarActions(
      <>
        <Button
          type="button"
          variant="page-header"
          size="xs"
          onClick={openSearch}
          aria-label={t("search.action")}
          title={t("search.action")}
          leftIcon={<SearchIcon aria-hidden="true" />}
        >
          {t("search.action")}
        </Button>
        <Button
          type="button"
          variant="page-header"
          size="xs"
          onClick={() => (isPinnedToHome ? unpinFromHome() : void pinToHome())}
          disabled={isPinningToHome}
          aria-label={label}
          title={label}
          leftIcon={
            <PinIcon
              aria-hidden="true"
              fill={isPinnedToHome ? "currentColor" : "none"}
            />
          }
        >
          {label}
        </Button>
      </>,
    );

    return () => setTopBarActions(null);
  }, [
    isPinnedToHome,
    isPinningToHome,
    openSearch,
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
            queuedMessage: controller.queue.queuedMessage,
            onDismissQueue: controller.queue.dismiss,
            onStop: isReadOnly ? undefined : controller.stopStreaming,
            isStreaming:
              !isReadOnly &&
              (controller.chatState === "streaming" ||
                controller.chatState === "thinking"),
          }}
          onRecallLastUserMessage={
            isReadOnly ? undefined : handleRecallLastUserMessage
          }
          initialValue={controller.draftValue}
          onDraftChange={controller.handleDraftChange}
          selectedSkills={controller.selectedSkills}
          onSkillsChange={controller.handleSkillsChange}
          fileMentionRoots={fileMentionRoots}
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
    enabled: terminalVisible && terminalExpanded,
    element: terminalRegionElement,
    getInitialFocus: () => {
      const terminalPanel =
        terminalRegionElement?.querySelector<HTMLElement>(
          "[data-terminal-panel]",
        ) ?? null;
      terminalPanel?.dispatchEvent(new CustomEvent("goose-terminal-focus"));
      return (
        terminalRegionElement?.querySelector<HTMLElement>(
          ".xterm-helper-textarea, .xterm textarea, textarea",
        ) ??
        terminalPanel ??
        terminalRegionElement?.querySelector<HTMLElement>(
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
          <div
            className={cn(
              "relative flex min-h-0 flex-1 flex-col overflow-visible rounded-md bg-card",
              terminalVisible && "min-h-[280px]",
            )}
          >
            {messageTimeline}
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
          {terminalVisible ? (
            <div
              ref={terminalRootRef}
              className="mt-[var(--spacing-app-panel-gutter-inline)] flex shrink-0 flex-col gap-2"
            >
              <div
                ref={terminalExpanded ? setTerminalRegionElement : undefined}
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
                  "flex shrink-0 flex-col overflow-hidden rounded-md bg-card text-foreground transition-[height] duration-200 ease-out will-change-[height] motion-reduce:transition-none",
                  terminalExpanded ? "h-[clamp(220px,34vh,320px)]" : "h-11",
                )}
              >
                <div
                  className={cn(
                    "flex shrink-0 items-center gap-1 px-2",
                    "h-11",
                    terminalExpanded && "border-b border-border/80",
                  )}
                >
                  <div
                    role="tablist"
                    aria-label={t("terminal.tabs")}
                    className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
                  >
                    {terminalTabs.map((tab) => {
                      const label = terminalTabLabel(tab, terminalTabs);
                      const selected = tab.id === activeTerminalTab?.id;
                      const stopAndCloseLabel = t("terminal.stopAndCloseTab", {
                        path: label,
                      });
                      const confirmStopTitle = t(
                        "terminal.confirmStopTabTitle",
                        {
                          path: label,
                        },
                      );
                      return (
                        <div
                          key={tab.id}
                          className={cn(
                            "group flex min-w-0 max-w-48 shrink-0 items-center rounded-sm border border-transparent",
                            "h-[30px]",
                            selected
                              ? "[background:color-mix(in_srgb,var(--foreground)_8%,var(--card))] text-foreground"
                              : "text-muted-foreground hover:[background:color-mix(in_srgb,var(--foreground)_5%,var(--card))] hover:text-foreground",
                          )}
                        >
                          <button
                            id={terminalTabButtonId(tab.id)}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            aria-controls={terminalTabPanelId(tab.id)}
                            aria-label={t("terminal.selectTab", {
                              path: label,
                            })}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => handleSelectTerminalTab(tab.id)}
                            onKeyDown={(event) =>
                              handleTerminalTabKeyDown(event, tab.id)
                            }
                            className="min-w-0 flex-1 truncate px-2 py-1 text-left font-mono text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {label}
                          </button>
                          <Popover
                            open={closingTerminalTabId === tab.id}
                            onOpenChange={(open) =>
                              setClosingTerminalTabId(open ? tab.id : null)
                            }
                          >
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <PopoverTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    aria-label={stopAndCloseLabel}
                                    className={cn(
                                      "mr-0.5 size-6",
                                      TERMINAL_HEADER_ICON_BUTTON_CLASS,
                                    )}
                                  >
                                    <IconX className="size-4" />
                                  </Button>
                                </PopoverTrigger>
                              </TooltipTrigger>
                              <TooltipContent>
                                {stopAndCloseLabel}
                              </TooltipContent>
                            </Tooltip>
                            <PopoverContent
                              side="top"
                              align="end"
                              sideOffset={8}
                              className="w-64 rounded-md p-3 text-left"
                            >
                              <div className="space-y-3">
                                <div className="space-y-1">
                                  <p className="text-sm font-medium text-foreground">
                                    {confirmStopTitle}
                                  </p>
                                  <p className="text-xs leading-5 text-muted-foreground">
                                    {t("terminal.confirmStopDescription")}
                                  </p>
                                </div>
                                <div className="flex justify-end gap-2">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="xs"
                                    onClick={() =>
                                      setClosingTerminalTabId(null)
                                    }
                                  >
                                    {t("common:actions.cancel")}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="destructive"
                                    size="xs"
                                    onClick={() => handleCloseTerminal(tab.id)}
                                  >
                                    {t("terminal.stop")}
                                  </Button>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        </div>
                      );
                    })}
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={handleRestartTerminal}
                        disabled={!activeTerminalTab}
                        aria-label={t("terminal.restart")}
                        className={TERMINAL_HEADER_ICON_BUTTON_CLASS}
                      >
                        <IconRotateClockwise className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("terminal.restart")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={handleAddTerminalTab}
                        disabled={!terminalCwd}
                        aria-label={t("terminal.newTab")}
                        className={TERMINAL_HEADER_ICON_BUTTON_CLASS}
                      >
                        <IconPlus className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("terminal.newTab")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={
                          terminalExpanded
                            ? handleCollapseTerminal
                            : handleExpandTerminal
                        }
                        aria-expanded={terminalExpanded}
                        aria-label={
                          terminalExpanded
                            ? t("terminal.collapse")
                            : t("terminal.expand")
                        }
                        className={TERMINAL_HEADER_ICON_BUTTON_CLASS}
                      >
                        {terminalExpanded ? (
                          <IconChevronDown className="size-4" />
                        ) : (
                          <IconChevronUp className="size-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {terminalExpanded
                        ? t("terminal.collapse")
                        : t("terminal.expand")}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <div
                  className={cn(
                    "min-h-0 flex-1",
                    !terminalExpanded && "hidden",
                  )}
                >
                  {terminalExpanded
                    ? terminalTabs.map((tab) => {
                        const selected = tab.id === activeTerminalTab?.id;
                        return (
                          <div
                            key={tab.id}
                            id={terminalTabPanelId(tab.id)}
                            role="tabpanel"
                            aria-labelledby={terminalTabButtonId(tab.id)}
                            tabIndex={selected ? 0 : undefined}
                            hidden={!selected}
                            className="h-full min-h-0"
                          >
                            {selected ? (
                              <TerminalPanel
                                key={tab.id}
                                sessionKey={`${sessionId}:${tab.id}`}
                                cwd={tab.cwd}
                                collapsed={false}
                                showHeader={false}
                                className="h-full bg-card"
                              />
                            ) : null}
                          </div>
                        );
                      })
                    : null}
                </div>
              </div>
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
