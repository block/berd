import { useCallback, useContext, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { updateWorkingDir } from "@/shared/api/acpApi";
import { ensureDirectory } from "@/shared/api/system";
import { releaseWorkspaceSendAfterUserEdit } from "@/features/chat/lib/firstWorkspaceSend";
import { supersedePendingSessionWorkspaceActivation } from "@/features/chat/lib/sessionWorkspaceActivation";
import { clearSessionLoadWarningNotice } from "@/features/chat/lib/sessionActivation";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

interface ChangeSessionFolderOptions {
  /** Initial directory the picker opens at. */
  defaultPath?: string | null;
  /** Also record the chosen folder as a workspace attachment
      (multi-workspace project chats). */
  attachWorkspace?: boolean;
}

/**
 * Single owner of the "re-point this chat at a different folder" flow: opens
 * the native directory picker, updates the live session working dir, patches
 * the local session/workspace state, and resolves any missing-folder recovery
 * notice the session loader added. Used by the context panel's workspace menu
 * and by the missing-folder notification's "Change folder" action so both
 * paths cannot drift apart.
 *
 * Re-points the current chat only. The default folder for new general chats
 * lives in Settings and is intentionally not touched here.
 */
export function useChangeSessionFolder(
  sessionId: string,
  options: ChangeSessionFolderOptions = {},
): { changeFolder: () => Promise<void>; isChangingFolder: boolean } {
  const { defaultPath, attachWorkspace: shouldAttachWorkspace = false } =
    options;
  // Optional so hosts without a QueryClientProvider (popped-out windows,
  // some test harnesses) can still change the folder; they just skip the
  // git-state cache invalidation.
  const queryClient = useContext(QueryClientContext);
  const { t } = useTranslation("chat");
  const [isChangingFolder, setIsChangingFolder] = useState(false);
  // Re-entrancy guard: not every caller can disable its trigger while the
  // native picker is open (the transcript notice button, for example), so a
  // double-click must not stack two pickers or race two working-dir updates.
  const changeInFlightRef = useRef(false);

  const changeFolder = useCallback(async () => {
    if (changeInFlightRef.current) {
      return;
    }
    changeInFlightRef.current = true;
    setIsChangingFolder(true);

    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        defaultPath: defaultPath ?? undefined,
        directory: true,
        multiple: false,
        title: t("contextPanel.folder.changeDialogTitle"),
      });

      if (typeof selected !== "string") {
        return;
      }

      await ensureDirectory(selected);
      await supersedePendingSessionWorkspaceActivation(sessionId);
      await updateWorkingDir(sessionId, selected);
      const sessionStore = useChatSessionStore.getState();
      sessionStore.patchSession(sessionId, { workingDir: selected });
      sessionStore.setActiveWorkspace(sessionId, {
        path: selected,
        branch: null,
      });
      if (shouldAttachWorkspace) {
        sessionStore.attachWorkspace(sessionId, {
          path: selected,
          branch: null,
          kind: "directory",
          source: "selected",
        });
      }
      releaseWorkspaceSendAfterUserEdit(sessionId);
      // The chat now points at a folder the user just picked, so the
      // loader's missing-folder recovery notice is resolved.
      clearSessionLoadWarningNotice(sessionId);
      // Git mutations can affect any cached path, so invalidate every cached
      // path, not just the one currently showing.
      if (queryClient) {
        await Promise.all([
          queryClient
            .invalidateQueries({ queryKey: ["git-state"] })
            .catch(() => undefined),
          queryClient
            .invalidateQueries({ queryKey: ["changed-files"] })
            .catch(() => undefined),
        ]);
      }
      toast.success(t("contextPanel.folder.changeSuccess"));
    } catch (error) {
      console.warn("Failed to change working folder:", error);
      toast.error(t("contextPanel.errors.folderChange"));
    } finally {
      changeInFlightRef.current = false;
      setIsChangingFolder(false);
    }
  }, [defaultPath, queryClient, sessionId, shouldAttachWorkspace, t]);

  return { changeFolder, isChangingFolder };
}
