import { Brain } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AddedMemoryEntry } from "@/features/me/lib/meMemoryWrites";
import { Button } from "@/shared/ui/button";

/**
 * "Added to memory" — shown in the chat that produced the fact.
 *
 * Memory is written automatically now, so this isn't an ask; it's the
 * disclosure. The card is the only reason automatic writes are honest:
 * the user sees exactly what landed, where it went, and can take it back
 * in one click. A toast would be wrong here — it vanishes in seconds,
 * which is too little standing for something that just edited a file the
 * user owns.
 *
 * Delete removes the bullet from the memory file *and* tombstones it, so
 * nothing re-adds it later.
 */
export function AddedMemoryCard({
  entry,
  onAcknowledge,
  onDelete,
}: {
  entry: AddedMemoryEntry;
  onAcknowledge: (entry: AddedMemoryEntry) => void;
  onDelete: (entry: AddedMemoryEntry) => void;
}) {
  const { t } = useTranslation("settings");
  const destination = entry.topic
    ? t("me.added.inTopic", { topic: entry.topic })
    : t("me.added.inGeneral");

  return (
    <div
      data-role="added-memory-card"
      className="flex items-start justify-between gap-4 rounded-md border bg-muted/50 px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Brain
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">
            {t("me.added.title")}
          </p>
          <p className="mt-1 text-xs text-foreground">{entry.content}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{destination}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <Button size="xs" variant="ghost" onClick={() => onDelete(entry)}>
          {t("me.added.delete")}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => onAcknowledge(entry)}>
          {t("me.added.ok")}
        </Button>
      </div>
    </div>
  );
}
