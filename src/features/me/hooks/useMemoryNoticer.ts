import { useEffect } from "react";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { SessionExecutionTarget } from "@/features/chat/lib/sessionExecutionTarget";
import { scheduleNoticerPass } from "../lib/noticerTrigger";

export function noticerTargetForCompletedTurn(
  before: string | undefined,
  now: string | undefined,
  target: SessionExecutionTarget | undefined,
): { providerId: string; modelId: string } | null {
  if (
    now !== "idle" ||
    (before !== "streaming" && before !== "thinking") ||
    target?.harnessId !== "goose" ||
    !target.modelProviderId ||
    !target.modelId
  )
    return null;
  return { providerId: target.modelProviderId, modelId: target.modelId };
}

/**
 * Schedule memory extraction when a foreground assistant turn finishes.
 *
 * Completion is store state, not send-path control flow: queued sends,
 * cancellation and lifecycle transitions all converge here. This mirrors the
 * existing completion-notification owner instead of coupling memory to
 * `dispatchPrompt` internals.
 */
export function useMemoryNoticer(): void {
  useEffect(() => {
    return useChatStore.subscribe(
      (state) => state.sessionStateById,
      (current, previous) => {
        const ids = new Set([
          ...Object.keys(current),
          ...Object.keys(previous),
        ]);
        for (const sessionId of ids) {
          const now = current[sessionId]?.chatState;
          const before = previous[sessionId]?.chatState;
          const target = noticerTargetForCompletedTurn(
            before,
            now,
            useChatSessionStore.getState().getSession(sessionId)
              ?.executionTarget,
          );
          if (!target) continue;
          scheduleNoticerPass(
            sessionId,
            () => useChatStore.getState().messagesBySession[sessionId] ?? [],
            target,
          );
        }
      },
    );
  }, []);
}
