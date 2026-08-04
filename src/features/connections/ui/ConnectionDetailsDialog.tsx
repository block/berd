import { useTranslation } from "react-i18next";
import { Link2 } from "lucide-react";
import type { ConnectionGridItem } from "@/features/connections/lib/connectionGrid";
import {
  itemDescription,
  itemName,
} from "@/features/connections/lib/connectionGrid";
import { isAlwaysOnAllowed } from "@/features/extensions/lib/keepEnabled";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { OAuthConnectionActions, OAuthStatusBadge } from "./ConnectionCards";

interface ConnectionDetailsDialogProps {
  item: ConnectionGridItem | null;
  onClose: () => void;
  onReset: (configKey: string) => void;
}

export function ConnectionDetailsDialog({
  item,
  onClose,
  onReset,
}: ConnectionDetailsDialogProps) {
  const { t } = useTranslation("settings");

  if (!item) return null;

  const name = itemName(item);
  const description = itemDescription(item);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center">
              {item.kind === "oauth" ? (
                <item.entry.Icon className="h-4.5 w-4.5" />
              ) : (
                <Link2
                  className="size-4.5 text-foreground"
                  aria-hidden="true"
                />
              )}
            </div>
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2">
                <span className="truncate">{name}</span>
                {item.kind === "oauth" ? (
                  <OAuthStatusBadge status={item.status} />
                ) : null}
              </DialogTitle>
            </div>
          </div>
        </DialogHeader>
        <DialogDescription>{description}</DialogDescription>
        {item.kind === "extension" && item.extension.type === "stdio" ? (
          <p className="truncate font-mono text-xs text-muted-foreground">
            {[item.extension.cmd, ...item.extension.args].join(" ")}
          </p>
        ) : null}
        {item.kind === "extension" &&
        item.extension.type === "streamable_http" ? (
          <p className="truncate font-mono text-xs text-muted-foreground">
            {item.extension.uri}
          </p>
        ) : null}
        <DialogFooter>
          {item.kind === "oauth" ? (
            <OAuthConnectionActions entry={item.entry} status={item.status} />
          ) : item.extension.enabled &&
            !isAlwaysOnAllowed(item.extension.config_key) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onReset(item.extension.config_key);
                onClose();
              }}
              tooltip={t("extensions.alwaysOn.tooltip")}
            >
              {t("extensions.alwaysOn.reset")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
