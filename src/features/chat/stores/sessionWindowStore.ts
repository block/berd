import { create } from "zustand";

export interface SessionWindowHandoff {
  fromLabel: string;
  toLabel: string;
  destinationReady: boolean;
  latestVersion: number;
  finalVersion?: number | null;
}

export type SessionWindowMode =
  | "owned"
  | {
      handoff: SessionWindowHandoff;
    };

export interface SessionWindowEntry {
  sessionId: string;
  windowLabel: string;
  mode?: SessionWindowMode;
}

interface SessionWindowState {
  openSessions: Record<string, string>;
  handoffs: Record<string, SessionWindowHandoff>;
  hasLoadedSnapshot: boolean;
  setSnapshot: (entries: SessionWindowEntry[]) => void;
  isOpenInWindow: (sessionId: string) => boolean;
  getWindowLabel: (sessionId: string) => string | undefined;
  isInHandoff: (sessionId: string) => boolean;
}

function getHandoff(mode: SessionWindowMode | undefined) {
  if (typeof mode === "object" && "handoff" in mode) {
    return mode.handoff;
  }

  return undefined;
}

export const useSessionWindowStore = create<SessionWindowState>((set, get) => ({
  openSessions: {},
  handoffs: {},
  hasLoadedSnapshot: false,
  setSnapshot: (entries) => {
    const openSessions: Record<string, string> = {};
    const handoffs: Record<string, SessionWindowHandoff> = {};

    for (const entry of entries) {
      openSessions[entry.sessionId] = entry.windowLabel;
      const handoff = getHandoff(entry.mode);
      if (handoff) {
        handoffs[entry.sessionId] = handoff;
      }
    }

    set({ openSessions, handoffs, hasLoadedSnapshot: true });
  },
  isOpenInWindow: (sessionId) => sessionId in get().openSessions,
  getWindowLabel: (sessionId) => get().openSessions[sessionId],
  isInHandoff: (sessionId) => sessionId in get().handoffs,
}));
