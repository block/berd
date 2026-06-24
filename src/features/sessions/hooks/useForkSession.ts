import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { acpSessionToChatSession } from "@/features/chat/lib/acpSessionMapping";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { acpDuplicateSession } from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";

function isSessionNotFoundError(error: unknown): boolean {
  return formatAcpErrorMessage(error, "").includes(
    "not found in sessions or threads",
  );
}

/**
 * Fork (duplicate) a chat session: copy its conversation history into a new
 * session, insert it into the store, and surface success/failure as a toast.
 *
 * Shared by the Session History grid and the sidebar chat-row menu so both
 * entry points behave identically. `onForked` runs after a successful fork
 * (e.g. to open the new session).
 */
export function useForkSession(options?: {
  onForked?: (sessionId: string) => void;
}): (sessionId: string) => Promise<void> {
  const { t } = useTranslation(["sessions", "common"]);
  const onForked = options?.onForked;

  return useCallback(
    async (sessionId: string) => {
      const session = useChatSessionStore.getState().getSession(sessionId);
      if (!session) return;
      const sourceName = getDisplaySessionTitle(
        session.title,
        t("common:session.defaultTitle"),
      );
      try {
        const forked = await acpDuplicateSession(
          sessionId,
          session.workingDir ?? "~",
          t("history.copyTitle", { title: sourceName }),
        );
        useChatSessionStore
          .getState()
          .addSession(acpSessionToChatSession(forked));
        toast.success(t("history.forked", { title: sourceName }));
        onForked?.(forked.sessionId);
      } catch (error) {
        console.error("Fork failed:", error);
        if (isSessionNotFoundError(error)) {
          useChatSessionStore.getState().removeSession(sessionId);
        }
        toast.error(formatAcpErrorMessage(error, t("history.forkFailed")));
      }
    },
    [onForked, t],
  );
}
