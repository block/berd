import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  type GetAutomationTileResponse,
  getAutomationTile,
  getAutomationTiles,
} from "@/features/automations/api/kgooseAutomations";
import {
  getOutputSummary,
  latestRunTimestampFromTile,
} from "@/features/automations/lib/automationFormatting";
import { cn } from "@/shared/lib/cn";
import { useLocaleFormatting } from "@/shared/i18n";
import { InlineMarkdownText } from "@/shared/ui/inline-markdown-text";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import type { WidgetRenderProps } from "./types";

function getAutomationId(
  state: Record<string, unknown> | undefined,
): string | null {
  return typeof state?.automationId === "string" ? state.automationId : null;
}

/**
 * The widget renders five logical states; the upstream tile only exposes
 * `latestRunStatus` (string|number) + `schedulePaused` + `lastSuccessAt`, so we
 * normalize here to the four status-dot tokens the design system speaks.
 *
 * ACP gap (Tuesday Matt/Kalvin list): `latestRunStatus` can be "failed" but
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

function statusDotClass(state: CardState): string {
  switch (state) {
    case "success":
      return "bg-success";
    case "failed":
      return "bg-destructive";
    case "running":
      return "bg-info";
    case "paused":
    case "never-run":
      return "bg-muted-foreground";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function statusLabelKey(state: CardState): string {
  switch (state) {
    case "success":
      return "widgets.automationOutputPin.states.completed";
    case "failed":
      return "widgets.automationOutputPin.states.failed";
    case "running":
      return "widgets.automationOutputPin.states.running";
    case "paused":
      return "widgets.automationOutputPin.states.paused";
    case "never-run":
      return "widgets.automationOutputPin.states.neverRun";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

export function AutomationOutputWidget({
  instance,
  shouldIgnoreActivation,
  onOpenAutomation,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const { formatRelativeTimeToNow } = useLocaleFormatting();
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

  const handleUnavailableClick = useWidgetActivationGuard(
    shouldIgnoreActivation,
    () => {
      // No-op: nothing to open when the underlying automation is unavailable.
    },
  );

  if (!tile) {
    return (
      <button
        type="button"
        onClick={handleUnavailableClick}
        className="flex h-full w-full items-center justify-center bg-card text-muted-foreground rounded-md cursor-pointer"
      >
        <span
          style={{
            fontSize:
              "clamp(0.8125rem, calc(0.875rem * var(--widget-scale, 1)), 1.5rem)",
            lineHeight:
              "clamp(0.95rem, calc(0.9375rem * var(--widget-scale, 1)), 1.6rem)",
          }}
        >
          {t("widgets.automationOutputPin.unavailable")}
        </span>
      </button>
    );
  }

  const cardState = resolveCardState(tile);
  const outputSummary = getOutputSummary(tile.latestRenderedData);
  const lastRunAt = latestRunTimestampFromTile(tile);
  const title =
    tile.title?.trim() || t("widgets.automationOutputPin.fallbackTitle");

  const statusLabel = t(statusLabelKey(cardState));

  const relativeTime = lastRunAt ? formatRelativeTimeToNow(lastRunAt) : null;

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={title}
      className="flex h-full w-full flex-col overflow-hidden rounded-md bg-card text-left text-foreground transition-colors duration-150 hover:bg-muted cursor-pointer"
      style={{
        padding: "clamp(0.75rem, calc(1rem * var(--widget-scale, 1)), 1.75rem)",
      }}
    >
      <div
        className="flex flex-col"
        style={{
          gap: "clamp(0.2rem, calc(0.25rem * var(--widget-scale, 1)), 0.5rem)",
        }}
      >
        <span
          className="truncate text-foreground"
          style={{
            fontSize:
              "clamp(0.875rem, calc(0.875rem * var(--widget-text-scale, var(--widget-scale, 1))), 1.625rem)",
            lineHeight:
              "clamp(1rem, calc(0.9375rem * var(--widget-text-scale, var(--widget-scale, 1))), 1.7rem)",
          }}
        >
          {title}
        </span>
        <span
          className="flex min-w-0 items-center text-foreground/40"
          style={{
            gap: "clamp(0.3rem, calc(0.375rem * var(--widget-scale, 1)), 0.7rem)",
            fontSize:
              "clamp(0.6875rem, calc(0.625rem * var(--widget-text-scale, var(--widget-scale, 1))), 1.0625rem)",
          }}
        >
          <span
            aria-hidden="true"
            className={cn(
              "rounded-full shrink-0",
              statusDotClass(cardState),
              cardState === "running" && "animate-pulse",
            )}
            style={{
              width:
                "clamp(0.35rem, calc(0.375rem * var(--widget-scale, 1)), 0.625rem)",
              height:
                "clamp(0.35rem, calc(0.375rem * var(--widget-scale, 1)), 0.625rem)",
            }}
          />
          <span className="truncate">
            {statusLabel}
            {relativeTime ? ` • ${relativeTime}` : null}
          </span>
        </span>
      </div>

      <div
        className="mt-auto min-h-0 max-h-[calc(100%-3.5rem)] overflow-y-auto"
        style={{
          paddingTop:
            "clamp(0.75rem, calc(1rem * var(--widget-scale, 1)), 1.75rem)",
        }}
      >
        {outputSummary ? (
          <InlineMarkdownText
            className="block text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]"
            style={{
              fontSize:
                "clamp(0.8125rem, calc(0.75rem * var(--widget-text-scale, var(--widget-scale, 1))), 1.375rem)",
              lineHeight: "1.4",
            }}
          >
            {outputSummary}
          </InlineMarkdownText>
        ) : (
          <p
            className="italic text-muted-foreground"
            style={{
              fontSize:
                "clamp(0.8125rem, calc(0.75rem * var(--widget-text-scale, var(--widget-scale, 1))), 1.375rem)",
            }}
          >
            {t("widgets.automationOutputPin.noOutput")}
          </p>
        )}
      </div>
    </button>
  );
}
