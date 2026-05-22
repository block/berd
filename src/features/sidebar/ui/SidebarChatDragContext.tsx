import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

export interface DraggingSessionState {
  id: string;
  /** The project the chat currently belongs to, or null when it lives in Recents. */
  fromProjectId: string | null;
}

interface SidebarChatDragContextValue {
  draggingSession: DraggingSessionState | null;
  beginSessionDrag: (id: string, fromProjectId: string | null) => void;
  endSessionDrag: () => void;
}

const SidebarChatDragContext = createContext<SidebarChatDragContextValue>({
  draggingSession: null,
  beginSessionDrag: () => {},
  endSessionDrag: () => {},
});

/**
 * Shares which chat is mid-drag (and where it came from) across the sidebar so
 * drop zones only light up where a move can actually happen. Dragging a chat
 * within its own group resolves to a no-op, so those targets stay inert.
 */
export function SidebarChatDragProvider({ children }: { children: ReactNode }) {
  const [draggingSession, setDraggingSession] =
    useState<DraggingSessionState | null>(null);

  const value = useMemo<SidebarChatDragContextValue>(
    () => ({
      draggingSession,
      beginSessionDrag: (id, fromProjectId) =>
        setDraggingSession({ id, fromProjectId }),
      endSessionDrag: () => setDraggingSession(null),
    }),
    [draggingSession],
  );

  return (
    <SidebarChatDragContext.Provider value={value}>
      {children}
    </SidebarChatDragContext.Provider>
  );
}

export function useSidebarChatDrag(): SidebarChatDragContextValue {
  return useContext(SidebarChatDragContext);
}
