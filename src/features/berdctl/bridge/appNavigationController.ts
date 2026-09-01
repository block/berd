export const MUTATION_DEADLINE_MARGIN_MS = 3_000;

export type CommandFailureReason =
  | "session_not_found"
  | "target_session_running"
  | "blocked_unsaved_changes"
  | "cleanup_requires_discard"
  | "git_inspection_failed"
  | "focus_failed"
  | "workspace_cleanup_failed"
  | "timed_out"
  | "voice_stop_failed"
  | "backend_archive_failed";
export type CommandOutcome =
  | {
      ok: true;
      cleanupIncomplete?: Extract<
        CommandFailureReason,
        "target_session_running" | "workspace_cleanup_failed" | "timed_out"
      >;
    }
  | {
      ok: false;
      reason: CommandFailureReason;
      /** Backend error detail (e.g. the ACP error `data` payload) to relay to
       *  the caller; omitted for refusal reasons that are self-explanatory. */
      detail?: string;
    };

export interface AppContext {
  view: string;
  activeSessionId: string | null;
  activeProjectId: string | null;
}

export type ArchiveCleanupPolicy = "confirm" | "reject" | "discard";

export interface AppNavigationController {
  /** Open an existing session in the main window. Resolves after the guarded
   *  navigation completes, or {ok:false} if blocked/cancelled. */
  openSession(sessionId: string): Promise<CommandOutcome>;
  /** Archive a session through AppShell's shared Git-cleanup transaction. */
  archiveSession(
    sessionId: string,
    cleanupPolicy: ArchiveCleanupPolicy,
    deadlineMs?: number,
  ): Promise<CommandOutcome>;
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
