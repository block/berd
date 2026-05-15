import { ArrowUpCircle, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUpdaterContext } from "@/features/updates/hooks/useUpdater";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";

const INDICATOR_STATUSES = new Set([
  "available",
  "downloading",
  "installing",
  "ready",
]);

export function UpdateIndicator() {
  const { t } = useTranslation("settings");
  const { status, relaunch } = useUpdaterContext();
  const shouldPreviewReadyUpdate =
    import.meta.env.DEV &&
    import.meta.env.MODE === "development" &&
    import.meta.env.VITE_PREVIEW_READY_UPDATE === "true";
  const displayStatus = shouldPreviewReadyUpdate ? "ready" : status;

  if (!INDICATOR_STATUSES.has(displayStatus)) {
    return null;
  }

  const isReady = displayStatus === "ready";
  const isBusy =
    displayStatus === "downloading" || displayStatus === "installing";
  const label = t(
    isReady ? "updates.indicator.ready" : "updates.indicator.inProgress",
  );
  const readyActionLabel = t("updates.actions.update");

  return (
    <Button
      type="button"
      variant="ghost"
      size={isReady ? "xxs" : "icon-sm"}
      className={cn(
        "translate-y-px",
        isReady
          ? "h-6 px-2 text-xs bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
          : "size-[24px]",
      )}
      leftIcon={
        isReady ? (
          <ArrowUpCircle aria-hidden="true" className="size-[14px]" />
        ) : undefined
      }
      onClick={() => {
        if (shouldPreviewReadyUpdate) return;
        if (isReady) void relaunch();
      }}
      disabled={!isReady}
      aria-label={isReady ? readyActionLabel : label}
      title={label}
    >
      {isBusy ? (
        <Spinner decorative className="size-[16px]" />
      ) : isReady ? (
        readyActionLabel
      ) : (
        <Download aria-hidden="true" className="size-[16px]" />
      )}
    </Button>
  );
}
