import { z } from "zod/v4";
import { defineCommand, CommandError } from "../types";

const setSessionFolderCwdSchema = z
  .object({
    session_id: z.string().min(1).describe("Id of the session to update."),
    path: z
      .string()
      .min(1)
      .describe(
        "Existing authorized folder to use as cwd; implicitly attached if needed.",
      ),
  })
  .strict();

export const setSessionFolderCwdCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Select a chat folder as cwd, retaining other attachments",
  description:
    "Use this to select an already attached folder, or when the previous folder should remain additional context. It implicitly attaches the target and changes cwd immediately when idle or safely after the current turn.",
  helpFooter: `For a request to switch or move the chat to a new worktree/folder, prefer \`folder replace\` so the old folder leaves context. Use this command when selecting among attachments or intentionally retaining the old folder.

The path must satisfy the same authorization rules as folder attach. Files and Git state are not moved.

Example:
  berdctl folder set-cwd --session-id <session-id> --path ~/src/repo-worktrees/feature

Result:
  {"ok": true, "path": "...", "kind": "...", "branch": "..."|null, "status": "applied"|"pending"}`,
  schema: setSessionFolderCwdSchema,
  precheck: async (args) => {
    const { refuseWindowedTarget } = await import("../runtime/sessions");
    refuseWindowedTarget(args.session_id, "change the cwd for");
  },
  execute: async (args, ctx) => {
    const [
      { attachSessionFolder, FolderAttachmentError },
      { refusePastDeadline },
      { isSessionRunning },
      { useChatStore },
      { useChatSessionStore },
      { getWorkspaceAttachments, isSameWorkspacePath },
      {
        applyPendingSessionWorkspaceActivation,
        claimSessionWorkspaceIntent,
        clearPendingSessionWorkspaceActivation,
        getPendingSessionWorkspaceActivation,
        isCurrentSessionWorkspaceIntent,
        queueSessionWorkspaceActivation,
        SessionWorkspaceActivationError,
      },
      { loadSessionForBerdctl, refuseRunningTarget, refuseWindowedTarget },
    ] = await Promise.all([
      import("@/features/chat/lib/sessionFolderRegistration"),
      import("../runtime/deadline"),
      import("@/features/chat/lib/sessionActivity"),
      import("@/features/chat/stores/chatStore"),
      import("@/features/chat/stores/chatSessionStore"),
      import("@/features/chat/lib/workspaceAttachments"),
      import("@/features/chat/lib/sessionWorkspaceActivation"),
      import("../runtime/sessions"),
    ]);
    const intentGeneration = claimSessionWorkspaceIntent(args.session_id);
    await loadSessionForBerdctl(args.session_id);
    const beforeAttachSession = useChatSessionStore
      .getState()
      .getSession(args.session_id);
    const beforeAttachAttachments = beforeAttachSession
      ? getWorkspaceAttachments(beforeAttachSession)
      : [];
    const beforeActiveWorkspace =
      useChatSessionStore.getState().activeWorkspaceBySession[args.session_id];
    let attachment: Awaited<ReturnType<typeof attachSessionFolder>>;
    try {
      attachment = await attachSessionFolder(args.session_id, args.path, {
        promoteDefaultCwd: false,
        replaceExistingInSingleWorkspace: true,
        beforeMutation: () => {
          refusePastDeadline(ctx, "the session cwd was not changed");
          refuseWindowedTarget(args.session_id, "change the cwd for");
        },
      });
    } catch (error) {
      if (error instanceof FolderAttachmentError) {
        throw new CommandError("invalid_args", error.message);
      }
      throw error;
    }
    const wasAttached = beforeAttachAttachments.some(
      (candidate) =>
        candidate.source !== "excluded" &&
        isSameWorkspacePath(candidate.path, attachment.path),
    );
    refusePastDeadline(ctx, "the session cwd was not changed");
    refuseWindowedTarget(args.session_id, "change the cwd for");
    const runtime = useChatStore.getState().getSessionRuntime(args.session_id);
    const branch = attachment.branch ?? null;
    if (
      isSessionRunning(runtime.chatState) ||
      runtime.isRunCancellationPending
    ) {
      queueSessionWorkspaceActivation({
        sessionId: args.session_id,
        path: attachment.path,
        branch,
        intentGeneration,
      });
      return {
        ok: true as const,
        path: attachment.path,
        kind: attachment.kind,
        branch,
        status: "pending" as const,
      };
    }
    refuseRunningTarget(args.session_id, "change the cwd for");
    clearPendingSessionWorkspaceActivation(args.session_id);
    const queuedActivation = queueSessionWorkspaceActivation({
      sessionId: args.session_id,
      path: attachment.path,
      branch,
      intentGeneration,
    });
    try {
      const appliedPath = await applyPendingSessionWorkspaceActivation(
        args.session_id,
      );
      if (appliedPath !== attachment.path) {
        throw new CommandError(
          "invalid_args",
          "A newer session cwd request superseded this command.",
        );
      }
    } catch (error) {
      if (!wasAttached && beforeAttachSession) {
        const failedPending = getPendingSessionWorkspaceActivation(
          args.session_id,
        );
        const attemptedRequestId =
          error instanceof SessionWorkspaceActivationError
            ? error.attemptedRequestId
            : queuedActivation.requestId;
        const failedOwnsQueuedActivation =
          attemptedRequestId === queuedActivation.requestId;
        if (
          failedOwnsQueuedActivation &&
          failedPending?.requestId === attemptedRequestId
        ) {
          clearPendingSessionWorkspaceActivation(args.session_id);
        }
        const stillCurrentIntent =
          failedOwnsQueuedActivation &&
          isCurrentSessionWorkspaceIntent(args.session_id, intentGeneration);
        const rollbackStore = useChatSessionStore.getState();
        const rollbackSession = rollbackStore.getSession(args.session_id);
        if (rollbackSession) {
          const currentAttachments = getWorkspaceAttachments(rollbackSession);
          const targetWasIntroduced =
            stillCurrentIntent &&
            currentAttachments.some(
              (candidate) =>
                candidate.source !== "excluded" &&
                isSameWorkspacePath(candidate.path, attachment.path),
            );
          if (targetWasIntroduced) {
            const withoutTarget = currentAttachments.filter(
              (candidate) =>
                !isSameWorkspacePath(candidate.path, attachment.path),
            );
            const restoredAttachments = [...withoutTarget];
            for (const candidate of beforeAttachAttachments) {
              if (
                !restoredAttachments.some((current) =>
                  isSameWorkspacePath(current.path, candidate.path),
                )
              ) {
                restoredAttachments.push(candidate);
              }
            }
            const failedTargetOwnsActiveId =
              rollbackSession.activeWorkspaceId === attachment.id ||
              rollbackSession.activeWorkspaceId == null;
            rollbackStore.patchSession(args.session_id, {
              workspaceAttachments: restoredAttachments,
              ...(failedTargetOwnsActiveId
                ? { activeWorkspaceId: beforeAttachSession.activeWorkspaceId }
                : {}),
            });
          }
          const currentActive =
            rollbackStore.activeWorkspaceBySession[args.session_id];
          if (
            stillCurrentIntent &&
            currentActive &&
            isSameWorkspacePath(currentActive.path, attachment.path)
          ) {
            if (beforeActiveWorkspace) {
              rollbackStore.setActiveWorkspace(
                args.session_id,
                beforeActiveWorkspace,
              );
            } else {
              rollbackStore.clearActiveWorkspace(args.session_id);
            }
          }
        }
      }
      throw error;
    }
    if (!isCurrentSessionWorkspaceIntent(args.session_id, intentGeneration)) {
      throw new CommandError(
        "invalid_args",
        "A newer session cwd request superseded this command.",
      );
    }
    const store = useChatSessionStore.getState();
    store.patchSession(args.session_id, { workingDir: attachment.path });
    store.setActiveWorkspace(args.session_id, {
      path: attachment.path,
      branch,
    });
    return {
      ok: true as const,
      path: attachment.path,
      kind: attachment.kind,
      branch,
      status: "applied" as const,
    };
  },
});
