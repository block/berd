import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

import {
  clearMeHistory,
  listMeHistory,
  type MeHistoryEntry,
} from "@/shared/api/system";
import { cn } from "@/shared/lib/cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button, buttonVariants } from "@/shared/ui/button";
import { SettingsSection } from "@/shared/ui/settings-section";

/**
 * The change history for the store.
 *
 * Built like the Topics section: an expandable row whose details hold the
 * log as plain text rows. Read-only — the history records what happened
 * rather than offering something to revise.
 *
 * Lives at the bottom and starts closed. Nobody opens Settings to read a
 * changelog; the question it answers ("did something I deleted come back?")
 * comes up occasionally.
 */
export function MemoryHistory({ filePath }: { filePath: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<MeHistoryEntry[] | null>(null);
  const [confirming, setConfirming] = useState(false);

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

  const clear = useCallback(async () => {
    setConfirming(false);
    await clearMeHistory(filePath).catch(() => {});
    setEntries([]);
  }, [filePath]);

  return (
    <SettingsSection>
      {/* One child, so the section content's divider can't draw a rule
          between the header and the opened log. The section header itself
          is the disclosure: clicking it (or its chevron) toggles the log. */}
      <div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the chevron button is the accessible toggle; the header click is a convenience */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users toggle via the chevron button */}
        <div
          className="cursor-pointer space-y-3"
          onClick={() => setOpen((value) => !value)}
        >
          <div className="flex items-center justify-between gap-4 pr-4">
            {/* Mirrors the SettingsSection title treatment; the chevron
                needs to sit beside it, so the section can't own the h2. */}
            <h2 className="font-display text-base font-medium tracking-tight text-foreground">
              {t("settings:me.history.title")}
            </h2>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-expanded={open}
              aria-label={
                open ? t("settings:me.closeTopic") : t("settings:me.openTopic")
              }
              onClick={(event) => {
                event.stopPropagation();
                setOpen((value) => !value);
              }}
            >
              <ChevronDown
                aria-hidden="true"
                className={cn(open && "rotate-180")}
              />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings:me.history.description")}
          </p>
        </div>

        {open && (
          <div className="mt-8 space-y-3">
            {/* Right-aligned above the content, where the document panels
                put Preview/Edit — same row, same xs height. */}
            {entries && entries.length > 0 && (
              <div className="flex items-center justify-end">
                <Button
                  size="xs"
                  variant="outline"
                  destructive
                  onClick={() => setConfirming(true)}
                >
                  {t("settings:me.history.clear")}
                </Button>
              </div>
            )}

            {entries === null && (
              <p className="text-xs text-muted-foreground">
                {t("settings:me.history.loading")}
              </p>
            )}
            {entries?.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("settings:me.history.empty")}
              </p>
            )}
            {entries && entries.length > 0 && (
              /* max-h-80 matches the trusted-domains list in Security —
                 the same shape, a scrollable list of rows inside a section.
                 overscroll-contain keeps the page still once the log ends. */
              <ul className="max-h-80 divide-y divide-border overflow-y-auto overscroll-contain pr-1">
                {entries.map((entry) => (
                  <li
                    key={`${entry.timestampMs}-${entry.message}`}
                    className="flex items-baseline justify-between gap-4 py-2.5 text-xs"
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
        )}

        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings:me.history.clearConfirm.title")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings:me.history.clearConfirm.description")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("common:actions.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                className={buttonVariants({
                  variant: "primary",
                  destructive: true,
                })}
                onClick={() => void clear()}
              >
                {t("settings:me.history.clear")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </SettingsSection>
  );
}
