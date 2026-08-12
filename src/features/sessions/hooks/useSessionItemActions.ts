import { useEffect, useRef, useState } from "react";
import {
  getDisplaySessionTitle,
  getEditableSessionTitle,
  isSessionTitleUnchanged,
} from "@/features/chat/lib/sessionTitle";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";

interface UseSessionRenameOptions {
  id: string;
  title: string;
  defaultTitle: string;
  onRename?: (id: string, nextTitle: string) => void;
}

/**
 * Inline-rename state shared by session item presentations (card, row).
 * Owns the editing flag, the draft title, and the input focus/select
 * behavior; callers render the input while `editing` is true.
 */
export function useSessionRename({
  id,
  title,
  defaultTitle,
  onRename,
}: UseSessionRenameOptions) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayTitle = getDisplaySessionTitle(title, defaultTitle);
  const editableTitle = getEditableSessionTitle(title, defaultTitle);
  const [draftTitle, setDraftTitle] = useState(editableTitle);

  useEffect(() => {
    setDraftTitle(editableTitle);
  }, [editableTitle]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const startRename = () => {
    setDraftTitle(editableTitle);
    setEditing(true);
  };

  const commitRename = () => {
    const nextTitle = draftTitle.trim();
    setEditing(false);
    if (!nextTitle || isSessionTitleUnchanged(nextTitle, title, defaultTitle)) {
      return;
    }
    onRename?.(id, nextTitle);
  };

  const cancelRename = () => {
    setDraftTitle(editableTitle);
    setEditing(false);
  };

  return {
    editing,
    inputRef,
    displayTitle,
    draftTitle,
    setDraftTitle,
    startRename,
    commitRename,
    cancelRename,
  };
}

export interface UseSessionActionsMenuOptions {
  id: string;
  archivedAt?: string;
  selected?: boolean;
  selectionCount?: number;
  selectionActionsDisabled?: boolean;
  onFork?: (id: string) => void;
  onArchive?: (id: string) => void;
  onArchiveSelected?: () => void;
  onUnarchive?: (id: string) => void;
  onUnarchiveSelected?: () => void;
  onExport?: (id: string) => void;
  onExportSelected?: () => void;
  onOpenInWindow?: (id: string) => void;
  isOpenInWindow?: boolean;
  onPinSelectedToHome?: () => void;
  onUnpinSelectedFromHome?: () => void;
  isSelectionPinnedToHome?: boolean;
  isPinningSelectedToHome?: boolean;
  onMarkSelectedRead?: () => void;
  onMarkSelectedUnread?: () => void;
}

/**
 * Computes the props for `SessionActionsMenuContent` shared by session item
 * presentations (card, row): pin-to-home state, unread state, and the
 * apply-to-selection mapping of the action callbacks. Callers add
 * `onClose`/`onRename` themselves since those are presentation-specific.
 */
export function useSessionActionsMenu({
  id,
  archivedAt,
  selected = false,
  selectionCount = 0,
  selectionActionsDisabled = false,
  onFork,
  onArchive,
  onArchiveSelected,
  onUnarchive,
  onUnarchiveSelected,
  onExport,
  onExportSelected,
  onOpenInWindow,
  isOpenInWindow = false,
  onPinSelectedToHome,
  onUnpinSelectedFromHome,
  isSelectionPinnedToHome = false,
  isPinningSelectedToHome = false,
  onMarkSelectedRead,
  onMarkSelectedUnread,
}: UseSessionActionsMenuOptions) {
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
    unpinFromHome,
  } = usePinToHomeWidget({ kind: "chat", id });
  const hasUnread = useChatStore(
    (state) => state.sessionStateById[id]?.hasUnread ?? false,
  );
  const markSessionRead = useChatStore((state) => state.markSessionRead);
  const markSessionUnread = useChatStore((state) => state.markSessionUnread);
  const shouldApplyToSelection = selected && selectionCount > 1;

  return {
    sessionId: id,
    archived: Boolean(archivedAt),
    hasUnread,
    isPinned: isPinnedToHome,
    isPinning: shouldApplyToSelection
      ? isPinningSelectedToHome
      : isPinningToHome,
    isOpenInWindow,
    selectionCount: shouldApplyToSelection ? selectionCount : 0,
    selectionActionsDisabled,
    onMarkRead: shouldApplyToSelection
      ? onMarkSelectedRead
      : () => markSessionRead(id),
    onMarkUnread: shouldApplyToSelection
      ? onMarkSelectedUnread
      : () => markSessionUnread(id),
    isSelectionPinned: isSelectionPinnedToHome,
    onTogglePin: () => {
      if (shouldApplyToSelection) {
        if (isSelectionPinnedToHome) {
          onUnpinSelectedFromHome?.();
        } else {
          onPinSelectedToHome?.();
        }
        return;
      }
      if (isPinnedToHome) {
        unpinFromHome();
        return;
      }
      void pinToHome();
    },
    onOpenInWindow: onOpenInWindow ? () => onOpenInWindow(id) : undefined,
    onDuplicate: onFork ? () => onFork(id) : undefined,
    // The menu content discriminates between the single and bulk export
    // callbacks itself (showing the item during multi-select only when the
    // bulk variant exists), so both are forwarded rather than pre-collapsed.
    onExport: onExport ? () => onExport(id) : undefined,
    onExportSelected: shouldApplyToSelection ? onExportSelected : undefined,
    onArchive: shouldApplyToSelection
      ? onArchiveSelected
      : onArchive
        ? () => onArchive(id)
        : undefined,
    // Restore follows the same apply-to-selection mapping as Archive and
    // Export. It used to always target the row whose menu was opened, so a
    // menu labelled with a selection count silently moved one chat and left
    // the rest selected and archived.
    onRestore: shouldApplyToSelection
      ? onUnarchiveSelected
      : onUnarchive
        ? () => onUnarchive(id)
        : undefined,
  };
}
