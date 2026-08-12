import { useEffect, useRef } from "react";

import type { AppView } from "@/app/types/appNavigation";
import {
  type AppContext,
  type AppNavigationController,
  type ArchiveCleanupPolicy,
  type CommandOutcome,
  clearAppNavigationController,
  registerAppNavigationController,
} from "@/features/berdctl/bridge/appNavigationController";

/** The small set of genuinely AppShell-owned values the controller policy
 *  needs. */
export interface AppNavigationPrimitives {
  /** Run `next` behind the app's unsaved-work guards; `onCancel` when the user declines. */
  guardAppNavigation(next: () => void, onCancel?: () => void): void;
  /** Select a session in the main window without re-entering the guards. */
  selectSessionDirect(sessionId: string): void;
  archiveChat(
    sessionId: string,
    cleanupPolicy: ArchiveCleanupPolicy,
    deadlineMs?: number,
  ): Promise<CommandOutcome>;
  getActiveSessionId(): string | null;
  hasSession(sessionId: string): boolean;
  isSessionOpenInWindow(sessionId: string): boolean;
  focusSessionWindow(sessionId: string): Promise<void>;
  getAppContext(): AppContext;
  activeView: AppView;
  isMultiWindowEnabled: boolean;
}

function focusPopoutWindowOutcome(
  focusSession: (sessionId: string) => Promise<void>,
  sessionId: string,
): Promise<CommandOutcome> {
  return focusSession(sessionId).then(
    () => ({ ok: true as const }),
    // focus_session_window rejects with plain strings, not Errors.
    () => ({ ok: false as const, reason: "focus_failed" }),
  );
}

/**
 * Registers the {@link AppNavigationController} that backs berdctl's
 * navigation commands (session open/archive, info context). The policy
 * bodies live here, in the feature; AppShell only supplies the primitives.
 */
export function useRegisterAppNavigationController(
  primitives: AppNavigationPrimitives,
): void {
  const {
    guardAppNavigation,
    selectSessionDirect,
    archiveChat,
    getActiveSessionId,
    hasSession,
    isSessionOpenInWindow,
    focusSessionWindow,
    getAppContext,
    activeView,
    isMultiWindowEnabled,
  } = primitives;

  // Plain functions (not useCallback): they are only read through
  // appNavigationHandlersRef, which is reassigned every render anyway.
  const openSession = (sessionId: string): Promise<CommandOutcome> => {
    if (isMultiWindowEnabled && isSessionOpenInWindow(sessionId)) {
      // v1 rule: focus the pop-out, do not steal the session into main.
      return focusPopoutWindowOutcome(focusSessionWindow, sessionId);
    }
    // "Already open" only counts when the chat surface is actually showing;
    // the session can stay active while the user is on settings/search etc.
    if (activeView === "chat" && sessionId === getActiveSessionId()) {
      return Promise.resolve({ ok: true });
    }
    if (!hasSession(sessionId)) {
      return Promise.resolve({ ok: false, reason: "session_not_found" });
    }
    return new Promise((resolve) => {
      guardAppNavigation(
        () => {
          selectSessionDirect(sessionId);
          resolve({ ok: true });
        },
        () => resolve({ ok: false, reason: "blocked_unsaved_changes" }),
      );
    });
  };

  const archiveSession = (
    sessionId: string,
    cleanupPolicy: ArchiveCleanupPolicy,
    deadlineMs?: number,
  ): Promise<CommandOutcome> => {
    if (!hasSession(sessionId)) {
      return Promise.resolve({ ok: false, reason: "session_not_found" });
    }
    return archiveChat(sessionId, cleanupPolicy, deadlineMs);
  };

  // Render-assigned ref (mirror AppShell's closeAgentBuilderSessionRef) so the
  // registered controller stays a single stable instance across re-renders
  // while always delegating to the latest handler closures.
  const appNavigationHandlers: AppNavigationController = {
    openSession,
    archiveSession,
    getAppContext,
  };
  const appNavigationHandlersRef = useRef(appNavigationHandlers);
  appNavigationHandlersRef.current = appNavigationHandlers;

  useEffect(() => {
    const controller: AppNavigationController = {
      openSession: (sessionId) =>
        appNavigationHandlersRef.current.openSession(sessionId),
      archiveSession: (sessionId, cleanupPolicy, deadlineMs) =>
        appNavigationHandlersRef.current.archiveSession(
          sessionId,
          cleanupPolicy,
          deadlineMs,
        ),
      getAppContext: () => appNavigationHandlersRef.current.getAppContext(),
    };
    registerAppNavigationController(controller);
    return () => clearAppNavigationController(controller);
  }, []);
}
