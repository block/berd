import {
  DEFAULT_TERMINAL_STATE,
  type TerminalPlacement,
  type TerminalTab,
} from "../model/terminalState";

type Listener = () => void;

interface AgentTerminalTabState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  expanded: boolean;
  placement: TerminalPlacement;
}

const states = new Map<string, AgentTerminalTabState>();
const listeners = new Map<string, Set<Listener>>();

const EMPTY_STATE: AgentTerminalTabState = {
  tabs: [],
  activeTabId: null,
  expanded: false,
  placement: DEFAULT_TERMINAL_STATE.placement,
};

export function getAgentTerminalTabState(
  sessionId: string,
): AgentTerminalTabState {
  return states.get(sessionId) ?? EMPTY_STATE;
}

export function setAgentTerminalTabState(
  sessionId: string,
  state: AgentTerminalTabState,
): void {
  if (state.tabs.length === 0) {
    states.delete(sessionId);
  } else {
    states.set(sessionId, state);
  }
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

export function subscribeAgentTerminalTabState(
  sessionId: string,
  listener: Listener,
): () => void {
  const sessionListeners = listeners.get(sessionId) ?? new Set<Listener>();
  sessionListeners.add(listener);
  listeners.set(sessionId, sessionListeners);
  return () => {
    sessionListeners.delete(listener);
    if (sessionListeners.size === 0) listeners.delete(sessionId);
  };
}

export function clearAgentTerminalTabStates(): void {
  const sessionIds = [...states.keys()];
  states.clear();
  for (const sessionId of sessionIds) {
    for (const listener of listeners.get(sessionId) ?? []) listener();
  }
}
