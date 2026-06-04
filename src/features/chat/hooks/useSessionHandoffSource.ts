import { useEffect, useMemo, useState } from "react";

import {
  emitSessionHandoffComplete,
  emitSessionHandoffFailed,
  emitSessionHandoffSnapshot,
  type SessionHandoffSnapshot,
} from "@/features/chat/lib/sessionHandoffEvents";
import { completeSessionHandoff } from "@/features/chat/lib/sessionWindowCommands";
import { useChatStore, type ChatStore } from "@/features/chat/stores/chatStore";
import {
  useSessionWindowStore,
  type SessionWindowHandoff,
} from "@/features/chat/stores/sessionWindowStore";
import type { SessionChatRuntime } from "@/shared/types/chat";

interface UseSessionHandoffSourceOptions {
  currentWindowLabel?: string;
  enabled?: boolean;
}

interface SourceHandoff {
  sessionId: string;
  handoff: SessionWindowHandoff;
}

function getRuntime(state: ChatStore, sessionId: string) {
  return state.sessionStateById[sessionId];
}

function getMessages(state: ChatStore, sessionId: string) {
  return state.messagesBySession[sessionId] ?? [];
}

function isHandoffComplete(runtime: SessionChatRuntime | undefined): boolean {
  return runtime?.chatState === "idle" && !runtime.streamingMessageId;
}

function getSnapshot(
  state: ChatStore,
  sessionId: string,
  handoff: SessionWindowHandoff,
): SessionHandoffSnapshot {
  return {
    sessionId,
    fromLabel: handoff.fromLabel,
    toLabel: handoff.toLabel,
    messages: getMessages(state, sessionId),
    sessionState: getRuntime(state, sessionId),
  };
}

function getErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useSessionHandoffSource(
  options: UseSessionHandoffSourceOptions = {},
) {
  const enabled = options.enabled ?? true;
  const [currentWindowLabel, setCurrentWindowLabel] = useState(
    options.currentWindowLabel ?? null,
  );
  const handoffs = useSessionWindowStore((s) => s.handoffs);
  const sourceHandoffs = useMemo<SourceHandoff[]>(() => {
    if (!enabled || !currentWindowLabel) return [];

    return Object.entries(handoffs)
      .filter(([, handoff]) => handoff.fromLabel === currentWindowLabel)
      .map(([sessionId, handoff]) => ({ sessionId, handoff }));
  }, [currentWindowLabel, enabled, handoffs]);

  useEffect(() => {
    if (!enabled) {
      setCurrentWindowLabel(null);
      return;
    }

    if (options.currentWindowLabel) {
      setCurrentWindowLabel(options.currentWindowLabel);
      return;
    }

    if (!window.__TAURI_INTERNALS__) {
      return;
    }

    let didCancel = false;

    async function resolveCurrentWindowLabel() {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      if (!didCancel) {
        setCurrentWindowLabel(appWindow.label);
      }
    }

    void resolveCurrentWindowLabel().catch((error) => {
      console.error("Failed to resolve current window label:", error);
    });

    return () => {
      didCancel = true;
    };
  }, [enabled, options.currentWindowLabel]);

  useEffect(() => {
    const unsubscribers: Array<() => void> = [];

    for (const { sessionId, handoff } of sourceHandoffs) {
      let didComplete = false;

      const emitFailed = async (reason: string) => {
        try {
          await emitSessionHandoffFailed(handoff.toLabel, {
            sessionId,
            fromLabel: handoff.fromLabel,
            toLabel: handoff.toLabel,
            reason,
          });
        } catch (error) {
          console.error("Failed to emit session handoff failure:", error);
        }
      };

      const emitSnapshot = async (state = useChatStore.getState()) => {
        const snapshot = getSnapshot(state, sessionId, handoff);
        await emitSessionHandoffSnapshot(handoff.toLabel, snapshot);
      };

      const completeIfReady = async (state = useChatStore.getState()) => {
        if (didComplete || !isHandoffComplete(getRuntime(state, sessionId))) {
          return;
        }

        didComplete = true;
        try {
          await emitSnapshot(state);
          await emitSessionHandoffComplete(handoff.toLabel, {
            sessionId,
            fromLabel: handoff.fromLabel,
            toLabel: handoff.toLabel,
          });
          await completeSessionHandoff(sessionId);
        } catch (error) {
          await emitFailed(getErrorReason(error));
        }
      };

      const emitSnapshotSafely = async (state = useChatStore.getState()) => {
        try {
          await emitSnapshot(state);
        } catch (error) {
          await emitFailed(getErrorReason(error));
        }
      };

      void emitSnapshotSafely();
      void completeIfReady();

      const unsubscribe = useChatStore.subscribe((state, previousState) => {
        const messages = getMessages(state, sessionId);
        const previousMessages = getMessages(previousState, sessionId);
        const runtime = getRuntime(state, sessionId);
        const previousRuntime = getRuntime(previousState, sessionId);

        if (messages === previousMessages && runtime === previousRuntime) {
          return;
        }

        void emitSnapshotSafely(state);
        void completeIfReady(state);
      });

      unsubscribers.push(unsubscribe);
    }

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [sourceHandoffs]);
}
