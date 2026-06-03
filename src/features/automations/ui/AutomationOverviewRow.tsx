import { useTranslation } from "react-i18next";
import { IconBell } from "@tabler/icons-react";
import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import {
  automationTitle,
  formatStatus,
  formatRunActivityTime,
  formatSchedule,
  getOutputSummary,
  latestRunTimestampFromTile,
} from "@/features/automations/lib/automationFormatting";
import { cn } from "@/shared/lib/cn";
import { InlineMarkdownText } from "@/shared/ui/inline-markdown-text";

function activityDotClass(status: string | number | undefined) {
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

export function AutomationActivityLabel({
  status,
  timestamp,
  className,
}: {
  status: string | number | undefined;
  timestamp: string | undefined;
  className?: string;
}) {
  const { t } = useTranslation("automations");
  const label = timestamp
    ? t("overview.lastActivity", {
        time: formatRunActivityTime(timestamp, {
          never: t("fallbacks.never"),
          today: t("overview.relativeDays.today"),
          yesterday: t("overview.relativeDays.yesterday"),
          relativeDay: (day, time) =>
            t("overview.relativeDays.withTime", { day, time }),
        }),
      })
    : t("overview.neverRun");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <span
        className={cn(
          "size-[7px] shrink-0 rounded-full",
          activityDotClass(status),
        )}
        role="img"
        aria-label={formatStatus(status, t("overview.neverRun"))}
      />
      {label}
    </span>
  );
}

export function AutomationOverviewRow({
  tile,
  onOpenDetail,
  selected = false,
}: {
  tile: AutomationTile;
  onOpenDetail: () => void;
  selected?: boolean;
}) {
  const { t } = useTranslation("automations");
  const scheduleLabels = {
    noSchedule: t("schedule.none"),
    paused: t("schedule.paused"),
    pausedWithReason: (reason: string) =>
      t("schedule.pausedWithReason", { reason }),
    cron: (key: string, values?: Record<string, string>) => t(key, values),
  };
  const latestResultSummary = getOutputSummary(tile.latestRenderedData);
  const title = automationTitle(tile, t("fallbacks.untitledAutomation"));
  const schedule = formatSchedule(tile, scheduleLabels);
  const runStatus =
    tile.latestRunStatus ?? (tile.lastSuccessAt ? "success" : undefined);
  const lastRunAt = latestRunTimestampFromTile(tile);

  return (
    <button
      type="button"
      className={cn(
        "group grid min-h-[86px] w-full gap-3 rounded-md bg-card px-6 py-5 text-left transition-[background-color,box-shadow,border-color] duration-200 hover:shadow-card hover:ring-1 hover:ring-inset hover:ring-border/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[minmax(0,1fr)_auto] md:items-center",
        selected && "ring-1 ring-inset ring-foreground",
      )}
      onClick={onOpenDetail}
      aria-label={title}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-base font-normal text-foreground">
            {title}
          </span>
          {tile.enableNotifications ? (
            <IconBell
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-label={t("details.notificationsEnabled")}
            />
          ) : null}
        </span>

        {latestResultSummary ? (
          <InlineMarkdownText className="mt-2 block truncate text-sm text-muted-foreground">
            {latestResultSummary}
          </InlineMarkdownText>
        ) : null}

        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="truncate md:hidden">{schedule}</span>
          <span className="md:hidden" aria-hidden="true">
            ·
          </span>
          <AutomationActivityLabel status={runStatus} timestamp={lastRunAt} />
        </span>
      </span>

      <span className="hidden max-w-56 truncate text-right text-sm text-muted-foreground md:block">
        {schedule}
      </span>
    </button>
  );
}
