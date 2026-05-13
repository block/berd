import { Download, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUpdaterContext } from "@/features/updates/hooks/useUpdater";
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

  if (!INDICATOR_STATUSES.has(status)) {
    return null;
  }

  const isReady = status === "ready";
  const isBusy = status === "downloading" || status === "installing";
  const label = t(
    isReady ? "updates.indicator.ready" : "updates.indicator.inProgress",
  );

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-[24px] translate-y-px"
      onClick={() => {
        if (isReady) void relaunch();
      }}
      disabled={!isReady}
      aria-label={label}
      title={label}
    >
      {isBusy ? (
        <Spinner decorative className="size-[16px]" />
      ) : isReady ? (
        <RotateCcw aria-hidden="true" className="size-[16px]" />
      ) : (
        <Download aria-hidden="true" className="size-[16px]" />
      )}
    </Button>
  );
}
