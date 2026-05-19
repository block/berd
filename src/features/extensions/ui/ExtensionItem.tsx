import { useTranslation } from "react-i18next";
import { IconAlertTriangle, IconSettings } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { isAlwaysOnAllowed } from "../lib/keepEnabled";
import { getDisplayName, type ExtensionEntry } from "../types";

interface ExtensionItemProps {
  extension: ExtensionEntry;
  onConfigure?: (extension: ExtensionEntry) => void;
  onReset?: (configKey: string) => void;
  className?: string;
}

function getSubtitle(ext: ExtensionEntry): string {
  if (ext.description) return ext.description;
  if (ext.type === "stdio") return ext.cmd;
  if (ext.type === "streamable_http") return ext.uri;
  return ext.type;
}

function isUserManagedExtension(ext: ExtensionEntry): boolean {
  return (
    (ext.type === "stdio" || ext.type === "streamable_http") && !ext.bundled
  );
}

function isEditable(ext: ExtensionEntry): boolean {
  return isUserManagedExtension(ext);
}

export function ExtensionItem({
  extension,
  onConfigure,
  onReset,
  className,
}: ExtensionItemProps) {
  const { t } = useTranslation("settings");
  const editable = isEditable(extension);
  const displayName = getDisplayName(extension);
  const showAlwaysOnWarning =
    extension.enabled && !isAlwaysOnAllowed(extension.config_key);

  return (
    <div
      className={cn(
        "flex min-h-20 items-center justify-between gap-3 border-b border-border-soft-divider py-4",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {displayName}
        </span>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {getSubtitle(extension)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {showAlwaysOnWarning && (
          <span className="inline-flex items-center gap-1 text-xs text-text-warning">
            <IconAlertTriangle className="size-3.5" aria-hidden="true" />
            {t("extensions.alwaysOn.label")}
          </span>
        )}
        {showAlwaysOnWarning && onReset && (
          <Button
            type="button"
            variant="outline-flat"
            size="xs"
            onClick={() => onReset(extension.config_key)}
            aria-label={t("extensions.alwaysOn.resetAria", {
              name: displayName,
            })}
            title={t("extensions.alwaysOn.tooltip")}
          >
            {t("extensions.alwaysOn.reset")}
          </Button>
        )}
        {editable && onConfigure && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onConfigure(extension)}
            aria-label={t("extensions.configure", {
              name: displayName,
            })}
          >
            <IconSettings className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
