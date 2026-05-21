import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconBolt } from "@tabler/icons-react";
import {
  type GetAutomationTileResponse,
  getAutomationTile,
  getAutomationTiles,
} from "@/features/automations/api/kgooseAutomations";
import {
  getOutputSummary,
  latestRunTimestampFromTile,
} from "@/features/automations/lib/automationFormatting";
import { AutomationActivityLabel } from "@/features/automations/ui/AutomationOverviewRow";
import { cn } from "@/shared/lib/cn";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import type { WidgetRenderProps } from "./types";

function getAutomationId(
  state: Record<string, unknown> | undefined,
): string | null {
  return typeof state?.automationId === "string" ? state.automationId : null;
}

/**
 * ACP gap (Tuesday Matt/Kalvin list): latestRunStatus can be "failed" but
 * there is currently no structured error message surfaced on AutomationTile.
 * We fall back to the empty-output i18n string until that field is added.
 */
type CardState = "success" | "failed" | "running" | "never-run" | "paused";

function resolveCardState(
  tile: import("@/features/automations/api/kgooseAutomations").AutomationTile,
): CardState {
  if (tile.schedulePaused) return "paused";
  const normalized = String(tile.latestRunStatus ?? "").toLowerCase();
  if (!normalized && !tile.lastSuccessAt) return "never-run";
  if (normalized.includes("running") || normalized.includes("pending"))
    return "running";
  if (normalized.includes("failed")) return "failed";
  if (normalized.includes("success") || tile.lastSuccessAt) return "success";
  return "never-run";
}

function StatusDot({ state }: { state: CardState }) {
  const dotClass = cn(
    "size-2 rounded-full shrink-0",
    state === "success" && "bg-text-success",
    state === "failed" && "bg-text-danger",
    state === "running" && "bg-text-info animate-pulse",
    (state === "never-run" || state === "paused") && "bg-border-strong",
    state === "paused" && "bg-transparent ring-1 ring-border-strong ring-inset",
  );
  return <span className={dotClass} aria-hidden="true" />;
}

function StatusChip({ state }: { state: CardState }) {
  const { t } = useTranslation("home");

  if (state === "success" || state === "never-run") {
    return null;
  }

  const label =
    state === "failed"
      ? t("widgets.automationOutputPin.states.failed")
      : state === "running"
        ? t("widgets.automationOutputPin.states.running")
        : t("widgets.automationOutputPin.states.paused");

  return (
    <span className="rounded-pill px-2 py-0.5 text-[13px] bg-chip-automation-bg text-chip-automation-fg">
      {label}
    </span>
  );
}

export function AutomationOutputWidget({
  instance,
  shouldIgnoreActivation,
  onOpenAutomation,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const automationId = getAutomationId(instance.state);

  const tileQuery = useQuery<GetAutomationTileResponse>({
    queryKey: ["automation-tile", automationId],
    queryFn: () =>
      automationId
        ? getAutomationTile(automationId)
        : Promise.resolve<GetAutomationTileResponse>({}),
    enabled: Boolean(automationId),
    staleTime: 15_000,
  });

  const listQuery = useQuery({
    queryKey: ["automation-tiles"],
    queryFn: () => getAutomationTiles().then((r) => r.tiles),
    enabled: !automationId,
    staleTime: 15_000,
  });

  const tile =
    tileQuery.data?.tileInfo ??
    (automationId
      ? listQuery.data?.find((t) => t.id === automationId)
      : listQuery.data?.[0]);

  const handleClick = useWidgetActivationGuard(shouldIgnoreActivation, () => {
    if (tile?.id) onOpenAutomation?.(tile.id);
  });

  if (!tile) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-card bg-surface-card p-4">
        <span className="text-[13px] italic text-muted-foreground">
          {t("widgets.automationOutputPin.fallbackTitle")}
        </span>
      </div>
    );
  }

  const cardState = resolveCardState(tile);
  const outputSummary = getOutputSummary(tile.latestRenderedData);
  const runStatus =
    tile.latestRunStatus ?? (tile.lastSuccessAt ? "success" : undefined);
  const lastRunAt = latestRunTimestampFromTile(tile);
  const title =
    tile.title?.trim() || t("widgets.automationOutputPin.fallbackTitle");

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={title}
      className="flex h-full w-full flex-col rounded-card bg-surface-card p-4 text-left text-foreground transition-colors duration-150 hover:bg-surface-tile cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <IconBolt
            className="size-3.5 shrink-0 text-foreground-subtle"
            aria-hidden="true"
          />
          <span className="truncate text-[14px] text-foreground">{title}</span>
        </span>
        <StatusDot state={cardState} />
      </div>

      <div className="mt-2 flex-1 min-h-0">
        {cardState === "failed" && (
          <p className="mb-1 text-[13px] italic text-muted-foreground line-clamp-1">
            {t("widgets.automationOutputPin.lastRunFailedPrefix")}
          </p>
        )}
        {outputSummary ? (
          <p
            className={cn(
              "text-[14px] font-light leading-[1.4] line-clamp-3",
              cardState === "failed"
                ? "text-muted-foreground"
                : "text-foreground-subtle",
            )}
          >
            {outputSummary}
          </p>
        ) : (
          <p className="text-[13px] italic text-muted-foreground">
            {cardState === "never-run"
              ? t("widgets.automationOutputPin.states.neverRun")
              : t("widgets.automationOutputPin.emptyOutput")}
          </p>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 text-[13px] text-muted-foreground pt-2">
        <AutomationActivityLabel status={runStatus} timestamp={lastRunAt} />
        <StatusChip state={cardState} />
      </div>
    </button>
  );
}
