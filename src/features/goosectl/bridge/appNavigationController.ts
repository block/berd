export type CommandFailureReason =
  | "session_not_found"
  | "blocked_unsaved_changes"
  | "focus_failed"
  | "backend_archive_failed";
export type CommandOutcome =
  | { ok: true }
  | { ok: false; reason: CommandFailureReason };

export interface AppContext {
  view: string;
  activeSessionId: string | null;
  activeProjectId: string | null;
}

export interface AppNavigationController {
  /** Open an existing session in the main window. Resolves after the guarded
   *  navigation completes, or {ok:false} if blocked/cancelled. */
  openSession(sessionId: string): Promise<CommandOutcome>;
  /** Archive a session AND run AppShell's cleanup (clear chat state,
   *  navigate home if it was active). */
  archiveSessionWithCleanup(sessionId: string): Promise<CommandOutcome>;
  /** What the user is looking at: current view, active session, and the
   *  active session's project. AppShell owns the view state. */
  getAppContext(): AppContext;
}

let controller: AppNavigationController | null = null;

export function registerAppNavigationController(
  c: AppNavigationController,
): void {
  controller = c;
}

/**
 * Clears the registered controller. Pass the instance being unregistered so a
 * re-registering effect's cleanup cannot clear its successor; omit it to
 * clear unconditionally.
 */
export function clearAppNavigationController(
  c?: AppNavigationController,
): void {
  if (c === undefined || controller === c) {
    controller = null;
  }
}

export function getAppNavigationController(): AppNavigationController {
  if (!controller) {
    throw new Error(
      "AppNavigationController not registered (main window not mounted)",
    );
  }
  return controller;
}
