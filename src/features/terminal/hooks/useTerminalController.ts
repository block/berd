import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import {
  canStopAcpTerminal,
  closeAcpTerminalDisplay,
  stopAcpTerminal,
  subscribeAcpTerminalCapability,
  subscribeAcpTerminalOpenRequests,
} from "../lib/acpTerminalManager";
import {
  getAgentTerminalTabState,
  setAgentTerminalTabState,
  subscribeAgentTerminalTabState,
} from "../lib/acpTerminalTabState";
import {
  queueTerminalCommand,
  restartTerminalSession,
  runCommandInTerminalSession,
  stopTerminalSession,
  subscribeTerminalSessionStatus,
} from "../lib/terminalSessionManager";
import {
  appendActiveTerminalTab,
  canRestartTerminalTab,
  createAgentTerminalTab,
  createTerminalTab,
  DEFAULT_TERMINAL_STATE,
  findDefaultTerminalTab,
  getDefaultFloatingTerminalRect,
  getDefaultTerminalDockedPlacement,
  removeTerminalTab,
  resolveFloatingTerminalRect,
  resolveTerminalDockedPlacement,
  resolveTerminalDockHeight,
  TERMINAL_STORAGE_KEY_PREFIX,
  terminalTabLabel,
  validateTerminalState,
  type TerminalDockRegion,
  type TerminalFloatingBoundsMode,
  type TerminalFloatingRect,
  type TerminalPlacement,
  type TerminalState,
  type TerminalTab,
} from "../model/terminalState";

export type TerminalController = ReturnType<typeof useTerminalController>;

export interface UseTerminalControllerOptions {
  sessionId: string;
  cwd: string | null;
  onFocusReturn?: () => void;
}

export function useTerminalController({
  sessionId,
  cwd,
  onFocusReturn,
}: UseTerminalControllerOptions) {
  const { t } = useTranslation("chat");
  const [closingTabId, setClosingTabId] = useState<string | null>(null);
  const [terminalRegionElement, setTerminalRegionElement] =
    useState<HTMLDivElement | null>(null);
  const [persistedState, setPersistedState] = usePersistedState<TerminalState>(
    `${TERMINAL_STORAGE_KEY_PREFIX}:${sessionId}`,
    DEFAULT_TERMINAL_STATE,
    validateTerminalState,
  );
  const subscribeAgentTabs = useCallback(
    (listener: () => void) =>
      subscribeAgentTerminalTabState(sessionId, listener),
    [sessionId],
  );
  const getAgentTabsSnapshot = useCallback(
    () => getAgentTerminalTabState(sessionId),
    [sessionId],
  );
  const agentState = useSyncExternalStore(
    subscribeAgentTabs,
    getAgentTabsSnapshot,
    getAgentTabsSnapshot,
  );
  const state = useMemo<TerminalState>(() => {
    const tabs = [...persistedState.tabs, ...agentState.tabs];
    const activeTabId = tabs.some((tab) => tab.id === agentState.activeTabId)
      ? agentState.activeTabId
      : persistedState.activeTabId;
    return {
      ...persistedState,
      tabs,
      activeTabId: activeTabId ?? tabs[0]?.id ?? null,
      expanded:
        tabs.length > 0 && (persistedState.expanded || agentState.expanded),
      placement:
        persistedState.tabs.length > 0
          ? persistedState.placement
          : agentState.placement,
    };
  }, [agentState, persistedState]);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const commitState = useCallback(
    (updater: (state: TerminalState) => TerminalState): TerminalState => {
      const nextState = updater(stateRef.current);
      const userTabs = nextState.tabs.filter((tab) => tab.source !== "agent");
      const agentTabs = nextState.tabs.filter((tab) => tab.source === "agent");
      const activeIsAgent = agentTabs.some(
        (tab) => tab.id === nextState.activeTabId,
      );
      stateRef.current = nextState;
      setPersistedState({
        ...nextState,
        tabs: userTabs,
        activeTabId: activeIsAgent
          ? (userTabs[0]?.id ?? null)
          : nextState.activeTabId,
        expanded: nextState.expanded && userTabs.length > 0,
      });
      setAgentTerminalTabState(sessionId, {
        tabs: agentTabs,
        activeTabId: activeIsAgent ? nextState.activeTabId : null,
        expanded: nextState.expanded && agentTabs.length > 0,
        placement: nextState.placement,
      });
      return nextState;
    },
    [sessionId, setPersistedState],
  );

  const tabs = state.tabs;
  const subscribeStopCapabilities = useCallback(
    (listener: () => void) => {
      const unsubscribes = tabs
        .filter((tab) => tab.source === "agent")
        .map((tab) =>
          subscribeAcpTerminalCapability(sessionId, tab.id, listener),
        );
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [sessionId, tabs],
  );
  const getStopCapabilitiesSnapshot = useCallback(
    () =>
      tabs
        .filter((tab) => tab.source === "agent")
        .map((tab) => `${tab.id}:${canStopAcpTerminal(sessionId, tab.id)}`)
        .join("|"),
    [sessionId, tabs],
  );
  useSyncExternalStore(
    subscribeStopCapabilities,
    getStopCapabilitiesSnapshot,
    getStopCapabilitiesSnapshot,
  );
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === state.activeTabId) ?? tabs[0] ?? null,
    [tabs, state.activeTabId],
  );
  const activeWorkspaceHasTerminal = Boolean(findDefaultTerminalTab(tabs, cwd));
  const visible = tabs.length > 0;
  const expanded = state.expanded;
  const placement = state.placement;
  const available = Boolean(cwd);
  const isFloating = placement.kind === "floating";
  const dockedPlacement =
    placement.kind === "docked"
      ? placement
      : (placement.lastDockedPlacement ?? resolveTerminalDockedPlacement());
  const dockHeight = dockedPlacement.size.height;

  const [focusRequest, setFocusRequest] = useState(0);
  const requestFocus = useCallback(() => {
    setFocusRequest((value) => value + 1);
  }, []);

  const toggle = useCallback(() => {
    if (!cwd) {
      toast.message(t("terminal.noWorkspace"));
      return;
    }

    commitState((current) => {
      const defaultTab = findDefaultTerminalTab(current.tabs, cwd);
      if (!defaultTab) {
        requestFocus();
        return appendActiveTerminalTab(current, createTerminalTab(cwd));
      }

      const nextExpanded =
        current.activeTabId === defaultTab.id ? !current.expanded : true;
      if (nextExpanded) {
        requestFocus();
      } else {
        onFocusReturn?.();
      }

      return {
        ...current,
        activeTabId: defaultTab.id,
        expanded: nextExpanded,
      };
    });
  }, [commitState, cwd, onFocusReturn, requestFocus, t]);

  const addTab = useCallback(() => {
    if (!cwd) {
      toast.message(t("terminal.noWorkspace"));
      return;
    }

    requestFocus();
    commitState((current) =>
      appendActiveTerminalTab(current, createTerminalTab(cwd)),
    );
  }, [commitState, cwd, requestFocus, t]);

  const openAtPath = useCallback(
    (path: string) => {
      const normalizedPath = path.trim();
      if (!normalizedPath) {
        toast.message(t("terminal.noWorkspace"));
        return;
      }

      requestFocus();
      commitState((current) => {
        const defaultTab = findDefaultTerminalTab(current.tabs, normalizedPath);
        return defaultTab
          ? { ...current, activeTabId: defaultTab.id, expanded: true }
          : appendActiveTerminalTab(current, createTerminalTab(normalizedPath));
      });
    },
    [commitState, requestFocus, t],
  );

  useEffect(
    () =>
      subscribeAcpTerminalOpenRequests((request) => {
        if (request.sessionId !== sessionId) return;
        if (request.focus) requestFocus();
        commitState((current) => {
          const existing = current.tabs.find(
            (tab) => tab.id === request.terminalId,
          );
          if (existing) {
            return request.focus
              ? { ...current, activeTabId: existing.id, expanded: true }
              : current;
          }

          const next = appendActiveTerminalTab(
            current,
            createAgentTerminalTab(
              request.terminalId,
              request.cwd,
              request.title,
            ),
          );
          return request.focus
            ? next
            : {
                ...next,
                activeTabId: current.activeTabId ?? next.activeTabId,
                expanded: true,
              };
        });
      }),
    [commitState, requestFocus, sessionId],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      commitState((current) => {
        if (!current.tabs.some((tab) => tab.id === tabId)) {
          return current;
        }
        requestFocus();
        return { ...current, activeTabId: tabId, expanded: true };
      });
    },
    [commitState, requestFocus],
  );

  const collapse = useCallback(() => {
    commitState((current) => {
      if (!current.expanded) {
        return current;
      }
      onFocusReturn?.();
      return { ...current, expanded: false };
    });
  }, [commitState, onFocusReturn]);

  const expand = useCallback(() => {
    commitState((current) => {
      if (current.tabs.length === 0) {
        return current;
      }
      requestFocus();
      return { ...current, expanded: true };
    });
  }, [commitState, requestFocus]);

  const removeTab = useCallback(
    (
      tabId: string,
      { userInitiated = false }: { userInitiated?: boolean } = {},
    ) => {
      setClosingTabId(null);
      commitState((current) => {
        const nextState = removeTerminalTab(current, tabId);
        if (!userInitiated) {
          return nextState;
        }
        if (nextState.tabs.length === 0) {
          onFocusReturn?.();
        } else if (nextState.activeTabId !== current.activeTabId) {
          requestFocus();
        }
        return nextState;
      });
    },
    [commitState, onFocusReturn, requestFocus],
  );

  const canStopTab = useCallback(
    (tabId: string) => canStopAcpTerminal(sessionId, tabId),
    [sessionId],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      const tab = stateRef.current.tabs.find(
        (candidate) => candidate.id === tabId,
      );
      if (!tab) return;

      if (tab.source === "agent") {
        if (canStopAcpTerminal(sessionId, tabId)) {
          try {
            await stopAcpTerminal(sessionId, tabId);
          } catch (error) {
            console.error("Failed to stop ACP terminal", error);
            toast.error(t("terminal.stopFailed"));
            return;
          }
        }
        closeAcpTerminalDisplay(sessionId, tabId);
      } else {
        stopTerminalSession(`${sessionId}:${tabId}`, { writeStopped: true });
      }
      removeTab(tabId, { userInitiated: true });
    },
    [removeTab, sessionId, t],
  );

  const restart = useCallback(() => {
    if (!canRestartTerminalTab(activeTab)) {
      return;
    }

    restartTerminalSession(`${sessionId}:${activeTab.id}`);
    if (!expanded) {
      expand();
    }
  }, [activeTab, expand, expanded, sessionId]);

  const runCommand = useCallback(
    (command: string, options?: { newTerminal?: boolean }) => {
      if (!cwd) {
        toast.message(t("terminal.noWorkspace"));
        return;
      }

      const nextState = commitState((current) => {
        if (options?.newTerminal) {
          return appendActiveTerminalTab(current, createTerminalTab(cwd));
        }
        const defaultTab = findDefaultTerminalTab(current.tabs, cwd);
        return defaultTab
          ? { ...current, activeTabId: defaultTab.id, expanded: true }
          : appendActiveTerminalTab(current, createTerminalTab(cwd));
      });

      const targetTab = options?.newTerminal
        ? nextState.tabs[nextState.tabs.length - 1]
        : findDefaultTerminalTab(nextState.tabs, cwd);
      if (!targetTab) {
        return;
      }

      const sessionKey = `${sessionId}:${targetTab.id}`;
      if (!runCommandInTerminalSession(sessionKey, command)) {
        queueTerminalCommand(sessionKey, command);
      }
    },
    [commitState, cwd, sessionId, t],
  );

  const setPlacement = useCallback(
    (placement: TerminalPlacement) => {
      commitState((current) => ({ ...current, placement }));
    },
    [commitState],
  );

  const popOut = useCallback(() => {
    commitState((current) => {
      const lastDockedPlacement =
        current.placement.kind === "docked"
          ? current.placement
          : current.placement.lastDockedPlacement;
      return {
        ...current,
        expanded: current.tabs.length > 0 ? true : current.expanded,
        placement: {
          kind: "floating",
          rect:
            current.placement.kind === "floating"
              ? resolveFloatingTerminalRect(current.placement.rect)
              : getDefaultFloatingTerminalRect(),
          lastDockedPlacement,
        },
      };
    });
    requestFocus();
  }, [commitState, requestFocus]);

  const popOutToRect = useCallback(
    (
      rect: TerminalFloatingRect,
      mode: TerminalFloatingBoundsMode = "settle",
    ) => {
      commitState((current) => {
        const lastDockedPlacement =
          current.placement.kind === "docked"
            ? current.placement
            : current.placement.lastDockedPlacement;
        return {
          ...current,
          expanded: current.tabs.length > 0 ? true : current.expanded,
          placement: {
            kind: "floating",
            rect: resolveFloatingTerminalRect(rect, mode),
            lastDockedPlacement,
          },
        };
      });
      requestFocus();
    },
    [commitState, requestFocus],
  );

  const dockToRegion = useCallback(
    (region: TerminalDockRegion = "chatColumn") => {
      commitState((current) => {
        const previousDockedPlacement =
          current.placement.kind === "floating"
            ? current.placement.lastDockedPlacement
            : current.placement;
        const sameRegionPlacement =
          previousDockedPlacement?.region === region
            ? previousDockedPlacement
            : getDefaultTerminalDockedPlacement(region);

        return {
          ...current,
          placement: resolveTerminalDockedPlacement(sameRegionPlacement),
        };
      });
      requestFocus();
    },
    [commitState, requestFocus],
  );

  const dockToBottom = useCallback(() => {
    dockToRegion("chatColumn");
  }, [dockToRegion]);

  const updateFloatingRect = useCallback(
    (
      rect: { x: number; y: number; width: number; height: number },
      mode: TerminalFloatingBoundsMode = "settle",
    ) => {
      commitState((current) =>
        current.placement.kind === "floating"
          ? {
              ...current,
              placement: {
                ...current.placement,
                kind: "floating",
                rect: resolveFloatingTerminalRect(rect, mode),
              },
            }
          : current,
      );
    },
    [commitState],
  );

  const updateDockHeight = useCallback(
    (height: number) => {
      commitState((current) => {
        const docked =
          current.placement.kind === "docked"
            ? current.placement
            : (current.placement.lastDockedPlacement ??
              resolveTerminalDockedPlacement());
        const nextDockedPlacement = resolveTerminalDockedPlacement({
          ...docked,
          size: { height: resolveTerminalDockHeight(height) },
        });

        return current.placement.kind === "floating"
          ? {
              ...current,
              placement: {
                ...current.placement,
                lastDockedPlacement: nextDockedPlacement,
              },
            }
          : { ...current, placement: nextDockedPlacement };
      });
    },
    [commitState],
  );

  useEffect(() => {
    if (placement.kind !== "floating") {
      return;
    }

    const handleResize = () => {
      commitState((current) =>
        current.placement.kind === "floating"
          ? {
              ...current,
              placement: {
                ...current.placement,
                kind: "floating",
                rect: resolveFloatingTerminalRect(current.placement.rect),
              },
            }
          : current,
      );
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [commitState, placement.kind]);

  useEffect(() => {
    const unsubscribes = tabs.map((tab) =>
      subscribeTerminalSessionStatus(`${sessionId}:${tab.id}`, (change) => {
        if (
          change.status !== "exited" ||
          change.source !== "backend-exit" ||
          tab.source === "agent"
        ) {
          return;
        }

        stopTerminalSession(change.key);
        removeTab(tab.id);
      }),
    );

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [removeTab, sessionId, tabs]);

  const getTabLabel = useCallback(
    (tab: TerminalTab) => terminalTabLabel(tab, tabs),
    [tabs],
  );

  return {
    activeTab,
    activeWorkspaceHasTerminal,
    addTab,
    available,
    canRestart: canRestartTerminalTab(activeTab),
    canStopTab,
    closeTab,
    closingTabId,
    collapse,
    dockHeight,
    dockToBottom,
    dockToRegion,
    dockedPlacement,
    expanded,
    expand,
    focusRequest,
    getTabLabel,
    isFloating,
    openAtPath,
    placement,
    popOut,
    popOutToRect,
    removeTab,
    restart,
    runCommand,
    selectTab,
    setClosingTabId,
    setPlacement,
    setTerminalRegionElement,
    tabs,
    terminalRegionElement,
    toggle,
    updateDockHeight,
    updateFloatingRect,
    visible,
    cwd,
  };
}
