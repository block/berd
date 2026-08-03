import { create } from "zustand";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export const SECURITY_ALERT_MARKER = "🔒 Security Alert";

export interface PendingSecurityConfirmation {
  request: RequestPermissionRequest;
  title: string;
  command: string | null;
  alertText: string;
  resolve: (response: RequestPermissionResponse) => void;
  inferredExplanation: InferredExplanationState;
}

export type InferredExplanationState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; text: string }
  | { status: "needs_setup" }
  | { status: "failed" };

interface SecurityConfirmationState {
  pendingBySessionId: Record<string, PendingSecurityConfirmation[]>;
  mountedSurfaceCountBySessionId: Record<string, number>;
  enqueue: (
    pending: Omit<PendingSecurityConfirmation, "inferredExplanation">,
  ) => void;
  setInferredExplanation: (
    sessionId: string,
    request: RequestPermissionRequest,
    state: InferredExplanationState,
  ) => void;
  resolveWith: (
    sessionId: string,
    request: RequestPermissionRequest,
    optionId: string,
  ) => void;
  cancel: (sessionId: string) => void;
  cancelAll: (sessionId: string) => void;
  blockAll: (sessionId: string) => void;
  mountSurface: (sessionId: string) => void;
  unmountSurface: (sessionId: string) => void;
}

function optionId(
  request: RequestPermissionRequest,
  kind: string,
  fallbackIndex: number,
): string {
  const match = request.options?.find((option) => option.kind === kind);
  return match?.optionId ?? request.options?.[fallbackIndex]?.optionId ?? kind;
}

export const useSecurityConfirmationStore = create<SecurityConfirmationState>(
  (set, get) => ({
    pendingBySessionId: {},
    mountedSurfaceCountBySessionId: {},

    enqueue: (pending) => {
      const sessionId = pending.request.sessionId;
      set((state) => ({
        pendingBySessionId: {
          ...state.pendingBySessionId,
          [sessionId]: [
            ...(state.pendingBySessionId[sessionId] ?? []),
            { ...pending, inferredExplanation: { status: "idle" } },
          ],
        },
      }));
    },

    setInferredExplanation: (sessionId, request, inferredExplanation) => {
      set((state) => {
        const queue = state.pendingBySessionId[sessionId];
        if (!queue?.some((pending) => pending.request === request)) {
          return state;
        }
        return {
          pendingBySessionId: {
            ...state.pendingBySessionId,
            [sessionId]: queue.map((pending) =>
              pending.request === request
                ? { ...pending, inferredExplanation }
                : pending,
            ),
          },
        };
      });
    },

    resolveWith: (sessionId, request, selectedOptionId) => {
      const pending = get().pendingBySessionId[sessionId]?.[0];
      if (!pending || pending.request !== request) {
        return;
      }
      set((state) => ({
        pendingBySessionId: removeFirstPending(
          state.pendingBySessionId,
          sessionId,
        ),
      }));
      pending.resolve({
        outcome: { outcome: "selected", optionId: selectedOptionId },
      });
    },

    cancel: (sessionId) => {
      const pending = get().pendingBySessionId[sessionId]?.[0];
      if (!pending) {
        return;
      }
      set((state) => ({
        pendingBySessionId: removeFirstPending(
          state.pendingBySessionId,
          sessionId,
        ),
      }));
      pending.resolve({ outcome: { outcome: "cancelled" } });
    },

    cancelAll: (sessionId) => {
      const pending = get().pendingBySessionId[sessionId] ?? [];
      if (pending.length === 0) {
        return;
      }
      set((state) => ({
        pendingBySessionId: removeSessionPending(
          state.pendingBySessionId,
          sessionId,
        ),
      }));
      for (const confirmation of pending) {
        confirmation.resolve({ outcome: { outcome: "cancelled" } });
      }
    },

    blockAll: (sessionId) => {
      const pending = get().pendingBySessionId[sessionId] ?? [];
      if (pending.length === 0) {
        return;
      }
      set((state) => ({
        pendingBySessionId: removeSessionPending(
          state.pendingBySessionId,
          sessionId,
        ),
      }));
      for (const confirmation of pending) {
        confirmation.resolve({
          outcome: {
            outcome: "selected",
            optionId: blockOptionId(confirmation.request),
          },
        });
      }
    },

    mountSurface: (sessionId) => {
      set((state) => ({
        mountedSurfaceCountBySessionId: {
          ...state.mountedSurfaceCountBySessionId,
          [sessionId]:
            (state.mountedSurfaceCountBySessionId[sessionId] ?? 0) + 1,
        },
      }));
    },

    unmountSurface: (sessionId) => {
      set((state) => {
        const next = { ...state.mountedSurfaceCountBySessionId };
        const remaining = (next[sessionId] ?? 1) - 1;
        if (remaining > 0) {
          next[sessionId] = remaining;
        } else {
          delete next[sessionId];
        }
        return { mountedSurfaceCountBySessionId: next };
      });
    },
  }),
);

function removeFirstPending(
  pendingBySessionId: Record<string, PendingSecurityConfirmation[]>,
  sessionId: string,
): Record<string, PendingSecurityConfirmation[]> {
  const remaining = pendingBySessionId[sessionId]?.slice(1) ?? [];
  const next = { ...pendingBySessionId };
  if (remaining.length > 0) {
    next[sessionId] = remaining;
  } else {
    delete next[sessionId];
  }
  return next;
}

function removeSessionPending(
  pendingBySessionId: Record<string, PendingSecurityConfirmation[]>,
  sessionId: string,
): Record<string, PendingSecurityConfirmation[]> {
  const next = { ...pendingBySessionId };
  delete next[sessionId];
  return next;
}

/** Resolve the "block this tool call" option id for the current request. */
export function blockOptionId(request: RequestPermissionRequest): string {
  return optionId(request, "reject_once", 2);
}

/** Resolve the "allow this tool call once" option id for the current request. */
export function allowOptionId(request: RequestPermissionRequest): string {
  return optionId(request, "allow_once", 1);
}
