import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { findSidebarChatDropTarget } from "@/features/sidebar/lib/sidebarPointerDragRegistry";
import type { SidebarChatDropTargetKind } from "@/features/sidebar/lib/sidebarPointerDragRegistry";

export interface DraggingSessionState {
  id: string;
  /** The project the chat currently belongs to, or null when it lives in Recents. */
  fromProjectId: string | null;
  /** The project chat group the chat currently belongs to, when grouped. */
  fromProjectGroupId: string | null;
}

interface SessionDropTargetRegistration {
  key: string;
  kind: SidebarChatDropTargetKind;
  projectId: string | null;
  projectGroupId?: string;
  element: HTMLElement;
  onDrop: (sessionId: string) => void;
}

interface ActiveSessionDropTarget {
  key: string;
  kind: SidebarChatDropTargetKind;
  projectId: string | null;
  projectGroupId?: string;
  onDrop: (sessionId: string) => void;
}

interface SidebarChatDragContextValue {
  draggingSession: DraggingSessionState | null;
  activeSessionDropTargetKey: string | null;
  beginSessionDrag: (
    id: string,
    fromProjectId: string | null,
    fromProjectGroupId?: string | null,
  ) => void;
  updateSessionDragTarget: (
    clientX: number,
    clientY: number,
  ) => ActiveSessionDropTarget | null;
  endSessionDrag: () => void;
  registerSessionDropTarget: (
    target: SessionDropTargetRegistration,
  ) => () => void;
}

const SidebarChatDragContext = createContext<SidebarChatDragContextValue>({
  draggingSession: null,
  activeSessionDropTargetKey: null,
  beginSessionDrag: () => {},
  updateSessionDragTarget: () => null,
  endSessionDrag: () => {},
  registerSessionDropTarget: () => () => {},
});

function canAcceptSessionDrop(
  target: Pick<
    SessionDropTargetRegistration,
    "kind" | "projectId" | "projectGroupId"
  >,
  draggingSession: DraggingSessionState | null,
): boolean {
  if (!draggingSession) return false;
  if (target.kind === "recents") {
    return draggingSession.fromProjectId != null;
  }
  if (target.kind === "project-group") {
    return (
      target.projectId === draggingSession.fromProjectId &&
      target.projectGroupId !== draggingSession.fromProjectGroupId
    );
  }
  return target.projectId !== draggingSession.fromProjectId;
}

/**
 * Shares which chat is mid-drag (and where it came from) across the sidebar so
 * drop zones only light up where a move can actually happen. Sidebar-internal
 * drags are pointer-driven instead of HTML5 DataTransfer-driven so Tauri can
 * keep native file-path drops enabled for attachments without intercepting
 * product drag interactions.
 */
export function SidebarChatDragProvider({ children }: { children: ReactNode }) {
  const [draggingSession, setDraggingSession] =
    useState<DraggingSessionState | null>(null);
  const draggingSessionRef = useRef<DraggingSessionState | null>(null);
  const [activeSessionDropTargetKey, setActiveSessionDropTargetKey] = useState<
    string | null
  >(null);
  const dropTargetsRef = useRef(
    new Map<string, SessionDropTargetRegistration>(),
  );

  const beginSessionDrag = useCallback(
    (
      id: string,
      fromProjectId: string | null,
      fromProjectGroupId: string | null = null,
    ) => {
      const next = { id, fromProjectId, fromProjectGroupId };
      draggingSessionRef.current = next;
      setDraggingSession(next);
      setActiveSessionDropTargetKey(null);
    },
    [],
  );

  const updateSessionDragTarget = useCallback(
    (clientX: number, clientY: number): ActiveSessionDropTarget | null => {
      const dragging = draggingSessionRef.current;
      const targets = Array.from(dropTargetsRef.current.values())
        .filter((target) => canAcceptSessionDrop(target, dragging))
        .map((target) => ({
          kind: target.kind,
          projectId: target.projectId,
          projectGroupId: target.projectGroupId,
          rect: target.element.getBoundingClientRect(),
          key: target.key,
          onDrop: target.onDrop,
        }));

      const match = findSidebarChatDropTarget(targets, clientX, clientY);
      const nextKey = match ? match.key : null;
      setActiveSessionDropTargetKey((prev) =>
        prev === nextKey ? prev : nextKey,
      );

      if (!match) {
        return null;
      }

      return {
        key: match.key,
        kind: match.kind,
        projectId: match.projectId,
        projectGroupId: match.projectGroupId,
        onDrop: match.onDrop,
      };
    },
    [],
  );

  const endSessionDrag = useCallback(() => {
    draggingSessionRef.current = null;
    setDraggingSession(null);
    setActiveSessionDropTargetKey(null);
  }, []);

  const registerSessionDropTarget = useCallback(
    (target: SessionDropTargetRegistration) => {
      dropTargetsRef.current.set(target.key, target);
      return () => {
        dropTargetsRef.current.delete(target.key);
      };
    },
    [],
  );

  const value = useMemo<SidebarChatDragContextValue>(
    () => ({
      draggingSession,
      activeSessionDropTargetKey,
      beginSessionDrag,
      updateSessionDragTarget,
      endSessionDrag,
      registerSessionDropTarget,
    }),
    [
      activeSessionDropTargetKey,
      beginSessionDrag,
      draggingSession,
      endSessionDrag,
      registerSessionDropTarget,
      updateSessionDragTarget,
    ],
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
