import { useEffect, useRef } from "react";
import {
  isSessionActivelyViewed,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getNotificationPrefs } from "@/features/settings/lib/notificationPrefs";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { isDefaultChatTitle } from "@/features/chat/lib/sessionTitle";
import { showCompletionNotificationToast } from "@/shared/notifications/CompletionNotificationToast";
import {
  getNotificationSoundResource,
  playNotificationSound,
} from "@/shared/notifications/notificationSounds";
import { ASSISTIVE_UX_RULES } from "@/shared/assistive-ux/registry";
import {
  recordAssistiveMomentAccepted,
  recordAssistiveMomentShown,
  shouldShowAssistiveMoment,
} from "@/shared/assistive-ux/runtime";
import { getPlatform } from "@/shared/lib/platform";
import type { Message } from "@/shared/types/messages";

const COMPLETION_NOTIFICATION_CLICKED_EVENT = "completion-notification-clicked";

async function shouldSuppressCompletionNotification(
  sessionId: string,
): Promise<boolean> {
  if (!window.__TAURI_INTERNALS__) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("should_suppress_completion_notification", {
      sessionId,
    });
  } catch {
    return false;
  }
}

function focusCurrentWindow(): void {
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    const appWindow = getCurrentWindow();
    void appWindow.show().catch(() => {});
    void appWindow.unminimize().catch(() => {});
    void appWindow.setFocus().catch(() => {});
  });
}

export function getCompletionOutcome(
  messages: Message[],
): "completed" | "error" | "stopped" {
  for (let i = messages.length - 1; i >= 0; i--) {
    const status = messages[i].metadata?.completionStatus;
    if (status === "error") return "error";
    if (status === "stopped") return "stopped";
    if (status === "completed") return "completed";
  }
  return "completed";
}

export function getNotificationBody(
  outcome: "completed" | "error" | "stopped",
  sessionTitle: string,
): string {
  const name = sessionTitle.trim() || "Agent";
  if (outcome === "error") return `${name} encountered an error`;
  if (outcome === "stopped") return `${name} was stopped`;
  return `${name} finished`;
}

function getChangedSessionIds<T>(
  current: Record<string, T | undefined>,
  previous: Record<string, T | undefined>,
): string[] {
  const ids = new Set([...Object.keys(current), ...Object.keys(previous)]);
  return Array.from(ids).filter(
    (sessionId) => !Object.is(current[sessionId], previous[sessionId]),
  );
}

export function useCompletionNotifications(
  onNavigateToSession: (sessionId: string) => void,
): void {
  const windowFocusedRef = useRef(true);
  // Keep a stable ref so the Zustand subscriber never has a stale callback.
  const navigateRef = useRef(onNavigateToSession);
  useEffect(() => {
    navigateRef.current = onNavigateToSession;
  }, [onNavigateToSession]);

  // Track window focus via Tauri's native API.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          windowFocusedRef.current = focused;
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Handle native notification clicks from the Tauri shell.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ sessionId?: string }>(
          COMPLETION_NOTIFICATION_CLICKED_EVENT,
          (event) => {
            const sessionId = event.payload.sessionId;
            if (!sessionId) return;
            focusCurrentWindow();
            navigateRef.current(sessionId);
          },
        ),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Keep mobile notification actions working where the plugin exposes them.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    if (getPlatform() === "mac") return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/plugin-notification")
      .then(({ onAction }) =>
        onAction((notification) => {
          const sessionId =
            typeof notification.extra?.sessionId === "string"
              ? notification.extra.sessionId
              : undefined;
          if (!sessionId) return;
          focusCurrentWindow();
          navigateRef.current(sessionId);
        }),
      )
      .then((listener) => {
        if (cancelled) void listener.unregister();
        else unlisten = () => void listener.unregister();
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Subscribe to runtime-state changes only. Streaming text writes update the
  // message array, so they should not make notification handling scan sessions.
  // Refs are stable so the dep array is [].
  useEffect(() => {
    const pendingSessions = new Set<string>();
    return useChatStore.subscribe(
      (state) => state.sessionStateById,
      (sessionStateById, previousSessionStateById) => {
        const prefs = getNotificationPrefs();
        if (!prefs.enabled) return;

        for (const sessionId of getChangedSessionIds(
          sessionStateById,
          previousSessionStateById,
        )) {
          const curr = sessionStateById[sessionId]?.chatState;
          const prev = previousSessionStateById[sessionId]?.chatState;
          if (!curr) {
            pendingSessions.delete(sessionId);
            continue;
          }

          // Track when a session enters an active state.
          if (curr === "streaming" || curr === "thinking") {
            pendingSessions.add(sessionId);
          }

          // Fire when a pending session reaches idle.
          if (
            curr === "idle" &&
            prev !== "idle" &&
            (pendingSessions.has(sessionId) ||
              prev === "streaming" ||
              prev === "thinking")
          ) {
            pendingSessions.delete(sessionId);

            const chatStoreState = useChatStore.getState();
            const isViewingThisSession = isSessionActivelyViewed(
              chatStoreState,
              sessionId,
            );
            // Skip if user is already watching this session in a focused window.
            if (isViewingThisSession && windowFocusedRef.current) continue;

            const messages = chatStoreState.messagesBySession[sessionId] ?? [];
            const outcome = getCompletionOutcome(messages);
            const session = useChatSessionStore
              .getState()
              .getSession(sessionId);
            // Use the session title only when it's user-set; fall back to empty
            // string so getNotificationBody uses the "Agent" default.
            const title =
              session && !isDefaultChatTitle(session.title)
                ? session.title
                : "";
            const body = getNotificationBody(outcome, title);
            void shouldSuppressCompletionNotification(sessionId).then(
              (suppress) => {
                if (suppress) return;
                const currentPrefs = getNotificationPrefs();
                if (!currentPrefs.enabled) return;
                const windowFocused = windowFocusedRef.current;
                if (
                  windowFocused &&
                  isSessionActivelyViewed(useChatStore.getState(), sessionId)
                ) {
                  return;
                }
                if (!windowFocused) {
                  if (!currentPrefs.desktop) return;
                  import("@tauri-apps/api/core").then(({ invoke }) => {
                    void invoke("show_completion_notification", {
                      body,
                      sessionId,
                      sound:
                        getNotificationSoundResource(
                          currentPrefs.desktopSound,
                        ) ?? null,
                    });
                  });
                  return;
                }

                if (!currentPrefs.inApp) return;
                playNotificationSound(currentPrefs.inAppSound);
                const shouldShowChangeSound = shouldShowAssistiveMoment(
                  ASSISTIVE_UX_RULES.notificationsChangeSound.id,
                );
                if (shouldShowChangeSound) {
                  recordAssistiveMomentShown(
                    ASSISTIVE_UX_RULES.notificationsChangeSound.id,
                  );
                }
                showCompletionNotificationToast({
                  title: body,
                  outcome,
                  onView: () => navigateRef.current(sessionId),
                  onChangeSound: shouldShowChangeSound
                    ? () => {
                        recordAssistiveMomentAccepted(
                          ASSISTIVE_UX_RULES.notificationsChangeSound.id,
                        );
                        requestOpenSettings("notifications");
                      }
                    : undefined,
                });
              },
            );
          }
        }
      },
    );
  }, []);
}
