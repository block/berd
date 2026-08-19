import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { listMeHistory, type MeHistoryEntry } from "@/shared/api/system";
import { Button } from "@/shared/ui/button";
import { SettingsSection } from "@/shared/ui/settings-section";

/**
 * The change history for the store.
 *
 * Built like the Topics section: a description and its action in the section
 * header, with the content below a rule. Read-only — the history records what
 * happened rather than offering something to revise — so it borrows the
 * documents' inset panel for shape, not for editing.
 *
 * Lives at the bottom and starts closed. Nobody opens Settings to read a
 * changelog; the question it answers ("did something I deleted come back?")
 * comes up occasionally.
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
    <SettingsSection title={t("me.history.title")}>
      {/* pr-4 matches SettingsRow's own right padding, so the action lines up
          with the View buttons in the sections above. */}
      <div className="flex items-center justify-between gap-6 pr-4 pb-3">
        <p className="max-w-prose text-xs text-muted-foreground">
          {t("me.history.description")}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t("me.history.hide") : t("me.history.show")}
        </Button>
      </div>
      {open && (
        <div className="pt-3">
          <div className="rounded-md border bg-muted/50 px-4 py-3">
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
            {entries && entries.length > 0 && (
              <ul className="space-y-1.5">
                {entries.map((entry) => (
                  <li
                    key={`${entry.timestampMs}-${entry.message}`}
                    className="flex items-baseline justify-between gap-4 text-xs"
                  >
                    <span className="min-w-0 text-foreground">
                      {entry.message}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {entry.author} ·{" "}
                      {new Date(entry.timestampMs).toLocaleDateString(
                        undefined,
                        { month: "short", day: "numeric" },
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
