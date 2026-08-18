import { toast } from "sonner";

import type { AddedMemoryEntry } from "./meMemoryWrites";

/**
 * "Added to memory" toasts.
 *
 * Memory is written automatically, so this is disclosure rather than an ask:
 * the toast tells the user what landed and offers to take it back. It's the
 * in-the-moment surface — the noticer runs seconds after a conversation goes
 * quiet, so the person is usually still right there.
 *
 * Resolving here (OK or Delete) clears the entry from Settings → Memory too;
 * letting the toast time out leaves it in that list, which is the point. The
 * toast is a chance to react, not the only chance — nothing gets lost if the
 * user misses it.
 */

/** Long enough to read and act on, short enough not to camp on the screen. */
const TOAST_DURATION_MS = 10_000;

/** Entries already shown, so a re-poll doesn't re-toast the same memory. */
const shown = new Set<string>();

export function resetAddedMemoryToasts(): void {
  shown.clear();
}

export function showAddedMemoryToast({
  entry,
  destination,
  title,
  okLabel,
  deleteLabel,
  onAcknowledge,
  onDelete,
  renderActions,
}: {
  entry: AddedMemoryEntry;
  /** "In Home" / "General preference" — where the entry landed. */
  destination: string;
  title: string;
  okLabel: string;
  deleteLabel: string;
  onAcknowledge: (entry: AddedMemoryEntry) => void;
  onDelete: (entry: AddedMemoryEntry) => void;
  /**
   * Builds the action element. Injected so this module stays free of JSX
   * (and of the toast chrome components), which keeps it unit-testable.
   */
  renderActions: (args: {
    okLabel: string;
    deleteLabel: string;
    onOk: () => void;
    onDelete: () => void;
  }) => React.ReactNode;
}): void {
  if (shown.has(entry.id)) return;
  shown.add(entry.id);

  let toastId: string | number | undefined;
  const dismiss = () => {
    if (toastId !== undefined) toast.dismiss(toastId);
  };

  toastId = toast(title, {
    description: `${entry.content} · ${destination}`,
    duration: TOAST_DURATION_MS,
    action: renderActions({
      okLabel,
      deleteLabel,
      onOk: () => {
        dismiss();
        onAcknowledge(entry);
      },
      onDelete: () => {
        dismiss();
        onDelete(entry);
      },
    }),
  });
}
