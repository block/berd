import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import {
  AUTOMATION_TILES_QUERY_KEY,
  AUTOMATION_TILES_STALE_TIME_MS,
  automationTileQueryKey,
  fetchAutomationTileDetail,
  fetchAutomationTilesList,
} from "@/features/automations/api/automationTilesQuery";
import {
  getOutputSummary,
  latestRunTimestampFromTile,
} from "@/features/automations/lib/automationFormatting";
import { useProfileCapability } from "@/shared/profile/capabilities";
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

function resolveCardState(tile: AutomationTile): CardState {
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
  const automationsEnabled = useProfileCapability("automations");
  const automationId = getAutomationId(instance.state);

  // One shared list query per home screen instead of a `get_automation_tile`
  // per pin: the list response carries everything the widget renders, and the
  // shared key is what lets AutomationsView mutations invalidate pins.
  const { data: listData } = useQuery({
    queryKey: AUTOMATION_TILES_QUERY_KEY,
    queryFn: fetchAutomationTilesList,
    enabled: automationsEnabled,
    staleTime: AUTOMATION_TILES_STALE_TIME_MS,
  });

  const listTile = automationId
    ? listData?.find((t) => t.id === automationId)
    : listData?.[0];

  // The list can lag a just-created/duplicated automation — the same
  // propagation gap AutomationsView bridges with `pendingCreatedAutomationId`
  // and its delayed refetch — and a pin created from the detail page in that
  // window carries an id the list has not published yet. So a resolved list
  // that misses the pinned id is not proof the automation is gone.
  const listMissesPinnedTile =
    Boolean(automationId) && listData !== undefined && !listTile;

  // List/detail parity guard: every run-outcome field rendered below is
  // optional on AutomationTile, so a backend that stopped populating the list
  // response would render as "never ran"/"no output" instead of failing
  // loudly. A list entry without `latestRenderedData` is indistinguishable
  // from that, so double-check it against `get_automation_tile` (sharing
  // AutomationsView's detail cache entry) and prefer the detail fields; for a
  // genuinely never-run tile the confirm fetch returns the same bare fields.
  // The same confirm covers the propagation window above, so a missing entry
  // fails loudly only once the detail endpoint agrees the tile is gone. Tiles
  // with a rendered payload skip this, keeping the common-case home screen at
  // one IPC call.
  const detailTileId =
    listTile?.id ?? (listMissesPinnedTile ? automationId : null);
  const shouldConfirmWithDetail =
    Boolean(detailTileId) && !listTile?.latestRenderedData;
  const { data: detailData, isError: detailConfirmErrored } = useQuery({
    queryKey: automationTileQueryKey(detailTileId),
    queryFn: () => fetchAutomationTileDetail(detailTileId ?? ""),
    enabled: automationsEnabled && shouldConfirmWithDetail,
    staleTime: AUTOMATION_TILES_STALE_TIME_MS,
  });

  // react-query keeps the last snapshot across background refetch errors, so
  // "unresolved" means the confirm fetch has never succeeded for this tile —
  // the only window where the slim entry's fields are unverified.
  const detailConfirmUnresolved = shouldConfirmWithDetail && !detailData;

  // Once a confirm is required the detail envelope is the sole source of
  // truth: a settled-but-empty envelope (tile deleted or no longer generic
  // between the list and detail calls) must not fall back to the unverified
  // slim entry it exists to check.
  const tile = shouldConfirmWithDetail
    ? detailData?.tileInfo && { ...listTile, ...detailData.tileInfo }
    : listTile;

  const handleClick = useWidgetActivationGuard(shouldIgnoreActivation, () => {
    if (tile?.id) onOpenAutomation?.(tile.id);
  });

  const handleUnavailableClick = useWidgetActivationGuard(
    shouldIgnoreActivation,
    () => {
      // No-op: nothing to open when the underlying automation is unavailable.
    },
  );

  // While the confirm fetch is in flight neither unverified state may render:
  // the slim entry would show exactly the "Never run"/"No output" a slimmed
  // payload fakes, and a missing entry would claim the automation is gone
  // while it may just be lagging the list. Show a neutral shell instead,
  // mirroring SkillPinWidget's pending state.
  if (detailConfirmUnresolved && !detailConfirmErrored) {
    return (
      <div aria-hidden="true" className="h-full w-full rounded-md bg-card" />
    );
  }

  // Nothing left to render once the confirm settled: an errored fetch leaves
  // us unable to tell a slimmed payload apart from a never-run tile, and an
  // empty envelope (or an empty list with no pinned id) means the automation
  // really is gone. Fail loudly rather than render unverified fields;
  // invalidation or a later refetch recovers the pin.
  if (!tile || detailConfirmUnresolved) {
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
          className="truncate pb-px text-foreground"
          style={{
            fontSize:
              "clamp(0.875rem, calc(0.875rem * var(--widget-text-scale, var(--widget-scale, 1))), 1.625rem)",
            lineHeight:
              "clamp(1.25rem, calc(1.3 * var(--widget-text-scale, var(--widget-scale, 1)) * 0.875rem), 2.25rem)",
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
