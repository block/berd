import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { listMeHistory, type MeHistoryEntry } from "@/shared/api/system";
import { Button } from "@/shared/ui/button";

/**
 * The change history for the store, collapsed by default.
 *
 * Deliberately quiet: nobody opens Settings to read a changelog, and the
 * answers it gives ("did something I deleted come back?") are only wanted
 * occasionally. So it sits at the bottom behind a disclosure, and reads
 * straight from the trail Berd already records rather than keeping a log of
 * its own.
 */
export function MemoryHistory({ filePath }: { filePath: string }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<MeHistoryEntry[] | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await listMeHistory(filePath));
    } catch {
      // An absent or unreadable history is an empty timeline, not an error.
      setEntries([]);
    }
  }, [filePath]);

  useEffect(() => {
    if (open && entries === null) void load();
  }, [open, entries, load]);

  return (
    <div className="pt-2">
      <Button
        variant="ghost"
        size="xs"
        flush
        onClick={() => setOpen((value) => !value)}
      >
        {open ? t("me.history.hide") : t("me.history.show")}
      </Button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {entries === null && (
            <p className="text-xs text-muted-foreground">
              {t("me.history.loading")}
            </p>
          )}
          {entries?.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t("me.history.empty")}
            </p>
          )}
          {entries?.map((entry) => (
            <div
              key={`${entry.timestampMs}-${entry.message}`}
              className="flex items-baseline justify-between gap-4 text-xs"
            >
              <span className="min-w-0 text-foreground">{entry.message}</span>
              <span className="shrink-0 text-muted-foreground">
                {entry.author} ·{" "}
                {new Date(entry.timestampMs).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
