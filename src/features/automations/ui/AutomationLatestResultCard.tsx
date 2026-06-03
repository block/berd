import { useTranslation } from "react-i18next";
import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import {
  formatRunActivityTime,
  formatStatus,
  getOutputBody,
  latestRunTimestampFromTile,
} from "@/features/automations/lib/automationFormatting";
import { JsonPreview } from "@/features/automations/ui/RunOutput";
import { cn } from "@/shared/lib/cn";
import { MessageResponse } from "@/shared/ui/ai-elements/message";

function statusDotClass(status: string | number | undefined) {
  const normalized = String(status ?? "").toLowerCase();
  if (
    normalized.includes("failed") ||
    normalized.includes("input") ||
    normalized.includes("configuration")
  ) {
    return "bg-destructive";
  }
  if (normalized.includes("success") || normalized.includes("active")) {
    return "bg-success";
  }
  if (normalized.includes("running") || normalized.includes("pending")) {
    return "bg-info";
  }
  return "bg-muted-foreground";
}

export function AutomationLatestResultCard({ tile }: { tile: AutomationTile }) {
  const { t } = useTranslation("automations");
  const summary = tile.latestRenderedData
    ? getOutputBody(tile.latestRenderedData)
    : null;
  const latestRunStatus =
    tile.latestRunStatus ?? (tile.lastSuccessAt ? "success" : undefined);
  const statusLabel = formatStatus(latestRunStatus, t("fallbacks.unknown"));
  const timestamp = latestRunTimestampFromTile(tile);
  const timestampLabel = formatRunActivityTime(timestamp, {
    never: t("fallbacks.never"),
    today: t("overview.relativeDays.todayStandalone"),
    yesterday: t("overview.relativeDays.yesterdayStandalone"),
    relativeDay: (day, time) =>
      t("overview.relativeDays.withTime", { day, time }),
  });

  return (
    <section className="space-y-3 rounded-md bg-card p-4">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-[7px] shrink-0 rounded-full",
            statusDotClass(latestRunStatus),
          )}
          role="img"
          aria-label={statusLabel}
        />
        <span>{timestampLabel}</span>
        <span aria-hidden="true">/</span>
        <span>{statusLabel}</span>
      </div>
      {summary ? (
        <MessageResponse className="min-w-0 text-sm leading-relaxed">
          {summary}
        </MessageResponse>
      ) : tile.latestRenderedData ? (
        <JsonPreview value={tile.latestRenderedData} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("details.noLatestResult")}
        </p>
      )}
    </section>
  );
}
