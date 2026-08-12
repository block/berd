import { useEffect } from "react";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  loadPersistedChatWorkspaceMetadata,
  subscribeToChatWorkspaceMetadata,
} from "@/features/chat/stores/workspaceAttachmentPersistence";

/** Keeps renderer-local session stores aligned through per-session updates. */
export function useWorkspaceAttachmentSync(): void {
  useEffect(
    () =>
      subscribeToChatWorkspaceMetadata((changedSessionIds) => {
        if (!changedSessionIds) return;
        const changed = new Set(changedSessionIds);
        useChatSessionStore.setState((state) => {
          const activeWorkspaceBySession = {
            ...state.activeWorkspaceBySession,
          };
          for (const sessionId of changed) {
            const metadata = loadPersistedChatWorkspaceMetadata(sessionId);
            const active = activeWorkspaceBySession[sessionId];
            if (
              active &&
              !metadata?.workspaceAttachments.some(
                (attachment) => attachment.path === active.path,
              )
            ) {
              delete activeWorkspaceBySession[sessionId];
            }
          }
          return {
            activeWorkspaceBySession,
            sessions: state.sessions.map((session) => {
              if (!changed.has(session.id)) return session;
              const metadata = loadPersistedChatWorkspaceMetadata(session.id);
              if (!metadata) {
                delete activeWorkspaceBySession[session.id];
                return {
                  ...session,
                  workspaceAttachments: [],
                  activeWorkspaceId: null,
                };
              }
              const activeAttachment = metadata.activeWorkspaceId
                ? metadata.workspaceAttachments.find(
                    (attachment) =>
                      attachment.id === metadata.activeWorkspaceId,
                  )
                : undefined;
              if (activeAttachment) {
                activeWorkspaceBySession[session.id] = {
                  path: activeAttachment.path,
                  branch: activeAttachment.branch ?? null,
                };
              }
              return {
                ...session,
                workspaceAttachments: metadata.workspaceAttachments,
                activeWorkspaceId: metadata.activeWorkspaceId ?? null,
                workingDir: metadata.workingDir ?? session.workingDir,
              };
            }),
          };
        });
      }),
    [],
  );
}
