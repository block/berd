import { create } from "zustand";

export interface SessionWindowHandoff {
  fromLabel: string;
  toLabel: string;
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
  setSnapshot: (entries: SessionWindowEntry[]) => void;
  isOpenInWindow: (sessionId: string) => boolean;
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

    set({ openSessions, handoffs });
  },
  isOpenInWindow: (sessionId) => sessionId in get().openSessions,
  isInHandoff: (sessionId) => sessionId in get().handoffs,
}));
