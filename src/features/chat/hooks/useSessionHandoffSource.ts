import { useEffect, useMemo, useState } from "react";

import {
  finishSessionHandoff,
  publishSessionHandoffSnapshot,
  type SessionHandoffPayload,
} from "@/features/chat/lib/sessionWindowCommands";
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

const SNAPSHOT_COALESCE_MS = 100;
const IDLE_COMPLETE_DEBOUNCE_MS = 750;

function getRuntime(state: ChatStore, sessionId: string) {
  return state.sessionStateById[sessionId];
}

function getMessages(state: ChatStore, sessionId: string) {
  return state.messagesBySession[sessionId] ?? [];
}

function isHandoffIdle(runtime: SessionChatRuntime | undefined): boolean {
  return runtime?.chatState === "idle" && !runtime.streamingMessageId;
}

function getSnapshot(
  state: ChatStore,
  sessionId: string,
  handoff: SessionWindowHandoff,
): SessionHandoffPayload {
  return {
    sessionId,
    fromLabel: handoff.fromLabel,
    toLabel: handoff.toLabel,
    messages: getMessages(state, sessionId),
    sessionState: getRuntime(state, sessionId),
    queuedMessages: state.queuedMessageBySession[sessionId] ?? [],
  };
}

function getReadySourceHandoffs(
  handoffs: Record<string, SessionWindowHandoff>,
  currentWindowLabel: string | null,
): SourceHandoff[] {
  if (!currentWindowLabel) {
    return [];
  }

  return Object.entries(handoffs)
    .filter(
      ([, handoff]) =>
        handoff.fromLabel === currentWindowLabel && handoff.destinationReady,
    )
    .map(([sessionId, handoff]) => ({ sessionId, handoff }));
}

function sourceHandoffSignature(sourceHandoffs: SourceHandoff[]): string {
  return sourceHandoffs
    .map(
      ({ sessionId, handoff }) =>
        `${sessionId}\u0000${handoff.fromLabel}\u0000${handoff.toLabel}`,
    )
    .sort()
    .join("\u0001");
}

export function useSessionHandoffSource(
  options: UseSessionHandoffSourceOptions = {},
) {
  const enabled = options.enabled ?? true;
  const [currentWindowLabel, setCurrentWindowLabel] = useState(
    options.currentWindowLabel ?? null,
  );
  const handoffs = useSessionWindowStore((s) => s.handoffs);
  const readySourceHandoffSignature = useMemo(() => {
    if (!enabled) {
      return "";
    }
    return sourceHandoffSignature(
      getReadySourceHandoffs(handoffs, currentWindowLabel),
    );
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
    if (!enabled || !currentWindowLabel || !readySourceHandoffSignature) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const sourceHandoffs = getReadySourceHandoffs(
      useSessionWindowStore.getState().handoffs,
      currentWindowLabel,
    );

    for (const { sessionId, handoff } of sourceHandoffs) {
      let didComplete = false;
      let publishTimer: ReturnType<typeof setTimeout> | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let publishedAtLeastOnce = false;

      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const publishSnapshot = async (
        state = useChatStore.getState(),
        final = false,
      ) => {
        const snapshot = getSnapshot(state, sessionId, handoff);
        if (final) {
          await finishSessionHandoff(sessionId, snapshot);
        } else {
          await publishSessionHandoffSnapshot(sessionId, snapshot);
        }
        publishedAtLeastOnce = true;
      };

      const schedulePublish = () => {
        if (didComplete || publishTimer) {
          return;
        }

        publishTimer = setTimeout(() => {
          publishTimer = null;
          void publishSnapshot(useChatStore.getState()).catch((error) => {
            console.error("Failed to publish session handoff snapshot:", error);
          });
        }, SNAPSHOT_COALESCE_MS);
      };

      const scheduleCompleteIfIdle = (state = useChatStore.getState()) => {
        clearIdleTimer();
        const runtime = getRuntime(state, sessionId);
        if (didComplete || !publishedAtLeastOnce || !isHandoffIdle(runtime)) {
          return;
        }

        idleTimer = setTimeout(() => {
          idleTimer = null;
          didComplete = true;
          void publishSnapshot(useChatStore.getState(), true).catch((error) => {
            didComplete = false;
            console.error("Failed to finish session handoff:", error);
          });
        }, IDLE_COMPLETE_DEBOUNCE_MS);
      };

      void publishSnapshot()
        .then(() => {
          scheduleCompleteIfIdle();
        })
        .catch((error) => {
          console.error(
            "Failed to publish initial session handoff snapshot:",
            error,
          );
        });

      const unsubscribe = useChatStore.subscribe((state, previousState) => {
        const messages = getMessages(state, sessionId);
        const previousMessages = getMessages(previousState, sessionId);
        const runtime = getRuntime(state, sessionId);
        const previousRuntime = getRuntime(previousState, sessionId);
        const queuedMessages = state.queuedMessageBySession[sessionId];
        const previousQueuedMessages =
          previousState.queuedMessageBySession[sessionId];

        if (
          messages === previousMessages &&
          runtime === previousRuntime &&
          queuedMessages === previousQueuedMessages
        ) {
          return;
        }

        clearIdleTimer();

        schedulePublish();
        scheduleCompleteIfIdle(state);
      });

      cleanups.push(() => {
        if (publishTimer) {
          clearTimeout(publishTimer);
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        unsubscribe();
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [currentWindowLabel, enabled, readySourceHandoffSignature]);
}
