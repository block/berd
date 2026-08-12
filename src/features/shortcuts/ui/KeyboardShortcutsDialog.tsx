import { useTranslation } from "react-i18next";

import {
  resolveShortcutGroups,
  useShortcutPreferences,
} from "@/features/shortcuts/lib/shortcutRegistry";
import { keyboardShortcutDisplayParts } from "@/shared/keyboard/keyboardShortcut";
import { getPlatform } from "@/shared/lib/platform";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Kbd } from "@/shared/ui/kbd";

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: KeyboardShortcutsDialogProps) {
  const { t } = useTranslation("shortcuts");
  const isMac = getPlatform() === "mac";
  // Subscribe to shortcut preferences so override changes while the dialog
  // is open re-render the resolved groups.
  void useShortcutPreferences();
  const groups = open ? resolveShortcutGroups() : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-5">
        <DialogHeader>
          <DialogTitle>{t("dialog.title")}</DialogTitle>
          <DialogDescription>{t("dialog.dismissHint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.category} className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t(`categories.${group.category}`)}
              </h3>
              <ul className="divide-y divide-border rounded-md bg-background">
                {group.shortcuts.map((shortcut) => (
                  <li
                    key={shortcut.id}
                    className="flex items-center justify-between gap-4 px-3 py-2"
                  >
                    <span className="text-sm">
                      {t(shortcut.descriptionKey)}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {keyboardShortcutDisplayParts(
                        shortcut.shortcut,
                        isMac,
                      ).map((part) => (
                        <Kbd key={part}>{part}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
