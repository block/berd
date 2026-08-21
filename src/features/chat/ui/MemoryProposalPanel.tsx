import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useAddedMemories } from "@/features/me/hooks/useAddedMemories";
import { showAddedMemoryToast } from "@/features/me/lib/addedMemoryToast";
import { ToastActionButton, ToastActionGroup } from "@/shared/ui/sonner";

/**
 * Announces memories added from this chat as toasts.
 *
 * Memory is written automatically, so this is disclosure: the toast says what
 * landed and offers to undo it while the person is still in the conversation
 * that produced it. Nothing renders inline — an earlier version put cards
 * above the composer, but a transient toast is the right weight for something
 * the user doesn't have to act on.
 *
 * Missing the toast costs nothing: unresolved entries stay in
 * Settings → Memory (with the nav badge) until acknowledged or deleted.
 * Acting here clears them from that list too, since both read one file.
 */
export function MemoryProposalPanel({
  sessionId,
}: {
  sessionId: string | undefined;
}) {
  const { t } = useTranslation("settings");
  const { entries, acknowledge, remove } = useAddedMemories(sessionId);

  useEffect(() => {
    if (!sessionId) return;
    for (const entry of entries) {
      showAddedMemoryToast({
        entry,
        destination: entry.topic
          ? t("me.added.inTopic", { topic: entry.topic })
          : t("me.added.inGeneral"),
        title: t("me.added.title"),
        okLabel: t("me.added.ok"),
        deleteLabel: t("me.added.delete"),
        onAcknowledge: (item) => void acknowledge(item),
        onDelete: (item) => void remove(item),
        renderActions: ({ okLabel, deleteLabel, onOk, onDelete }) => (
          <ToastActionGroup>
            <ToastActionButton
              className="ml-0"
              emphasis="secondary"
              onClick={onDelete}
            >
              {deleteLabel}
            </ToastActionButton>
            <ToastActionButton className="ml-0" onClick={onOk}>
              {okLabel}
            </ToastActionButton>
          </ToastActionGroup>
        ),
      });
    }
  }, [entries, sessionId, acknowledge, remove, t]);

  return null;
}
