import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as Accordion from "@radix-ui/react-accordion";
import { IconChevronRight } from "@tabler/icons-react";
import type {
  AutomationTile,
  AutomationTileResult,
} from "@/features/automations/api/kgooseAutomations";
import {
  automationTitle,
  formatRunActivityTime,
  formatStatus,
  getOutputSummary,
} from "@/features/automations/lib/automationFormatting";
import { cn } from "@/shared/lib/cn";
import { InlineMarkdownText } from "@/shared/ui/inline-markdown-text";

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

export function ExpandableHistoryRow({
  automation,
  result,
  value,
  showAutomationTitle = false,
  children,
}: {
  automation: AutomationTile;
  result: AutomationTileResult;
  value: string;
  showAutomationTitle?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation("automations");
  const summary = getOutputSummary(result.tileData);
  const title = automationTitle(automation, t("fallbacks.untitledAutomation"));
  const statusLabel = formatStatus(result.runStatus, t("fallbacks.unknown"));
  const runTimeLabel = formatRunActivityTime(result.created, {
    never: t("fallbacks.never"),
    today: t("overview.relativeDays.todayStandalone"),
    yesterday: t("overview.relativeDays.yesterdayStandalone"),
    relativeDay: (day, time) =>
      t("overview.relativeDays.withTime", { day, time }),
  });

  return (
    <Accordion.Item
      value={value}
      className="w-full overflow-hidden rounded-md border-b-0 bg-card"
    >
      <Accordion.Header className="flex">
        <Accordion.Trigger
          className={cn(
            "group/accordion-trigger flex min-h-[117px] w-full items-start px-6 py-5 text-left hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          aria-label={
            showAutomationTitle ? `${title}, ${runTimeLabel}` : undefined
          }
        >
          <span className="grid min-w-0 flex-1 gap-2">
            <span className="flex min-w-0 items-start justify-between gap-4">
              <span className="min-w-0">
                <span className="block truncate text-base font-normal text-foreground">
                  {showAutomationTitle ? title : runTimeLabel}
                </span>
                <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      "size-[7px] shrink-0 rounded-full",
                      statusDotClass(result.runStatus),
                    )}
                    role="img"
                    aria-label={statusLabel}
                  />
                  {showAutomationTitle ? runTimeLabel : statusLabel}
                </span>
              </span>
              <IconChevronRight
                className="mt-7 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/accordion-trigger:rotate-90"
                aria-hidden="true"
              />
            </span>
            <InlineMarkdownText className="line-clamp-2 text-sm text-muted-foreground">
              {summary ?? result.sessionId ?? t("history.noSessionId")}
            </InlineMarkdownText>
            {showAutomationTitle ? (
              <span className="text-xs text-muted-foreground">
                {statusLabel}
              </span>
            ) : null}
          </span>
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
        <div className="min-w-0 px-6 pt-1 pb-6">{children}</div>
      </Accordion.Content>
    </Accordion.Item>
  );
}
