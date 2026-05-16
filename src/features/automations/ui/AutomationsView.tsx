import { useEffect, useMemo, useRef, useState } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconBell,
  IconChevronRight,
  IconCheck,
  IconClock,
  IconCopy,
  IconDots,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import {
  type AutomationTile,
  type AutomationTileResult,
  type CreateAutomationTileRequest,
  type UpdateAutomationTileRequest,
  createAutomationTile,
  deleteAutomationTile,
  getAutomationSessionMessages,
  getAutomationTile,
  getAutomationTileResults,
  getAutomationTiles,
  updateAutomationTile,
} from "@/features/automations/api/kgooseAutomations";
import { canCreateTileType } from "@/features/automations/lib/creatableTileTypes";
import { AutomationBuilderPanel } from "@/features/automations/ui/AutomationBuilderPanel";
import { MessageTimeline } from "@/features/chat/ui/MessageTimeline";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Input } from "@/shared/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Separator } from "@/shared/ui/separator";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Spinner } from "@/shared/ui/spinner";
import { Switch } from "@/shared/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { PageHeader, PageShell } from "@/shared/ui/page-shell";
import { cn } from "@/shared/lib/cn";

const AUTOMATIONS_REFETCH_INTERVAL_MS = 15_000;

type AutomationSurfaceMode = "overview" | "history";
type SchedulePreset =
  | "none"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

const WEEKDAY_OPTIONS = [
  { value: "0", labelKey: "edit.weekdays.sunday" },
  { value: "1", labelKey: "edit.weekdays.monday" },
  { value: "2", labelKey: "edit.weekdays.tuesday" },
  { value: "3", labelKey: "edit.weekdays.wednesday" },
  { value: "4", labelKey: "edit.weekdays.thursday" },
  { value: "5", labelKey: "edit.weekdays.friday" },
  { value: "6", labelKey: "edit.weekdays.saturday" },
] as const;

const FALLBACK_TIME_ZONE_OPTIONS = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
] as const;

function formatStatus(
  value: string | number | undefined,
  unknownLabel: string,
) {
  if (value === undefined || value === null) {
    return unknownLabel;
  }

  return String(value)
    .replace(/^TILE_RUN_STATUS_/, "")
    .replace(/^TILE_STATUS_/, "")
    .replace(/^TILE_TYPE_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusVariant(
  value: string | number | undefined,
): "default" | "secondary" | "destructive" | "outline" {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("failed")) return "destructive";
  if (normalized.includes("input") || normalized.includes("configuration")) {
    return "secondary";
  }
  if (normalized.includes("inactive")) return "outline";
  if (normalized.includes("success") || normalized.includes("active")) {
    return "default";
  }
  if (normalized.includes("running") || normalized.includes("pending")) {
    return "secondary";
  }
  return "outline";
}

function overviewActivityIcon(value: string | number | undefined) {
  const normalized = String(value ?? "").toLowerCase();
  if (!normalized) {
    return (
      <IconClock
        className="size-3.5 shrink-0"
        style={{ color: "var(--text-muted)" }}
        aria-hidden="true"
      />
    );
  }
  if (
    normalized.includes("failed") ||
    normalized.includes("input") ||
    normalized.includes("configuration")
  ) {
    return (
      <IconAlertTriangle
        className="size-3.5 shrink-0"
        style={{ color: "var(--text-danger)" }}
        aria-hidden="true"
      />
    );
  }
  if (normalized.includes("success") || normalized.includes("active")) {
    return (
      <IconCheck
        className="size-3.5 shrink-0"
        style={{ color: "var(--text-success)" }}
        aria-hidden="true"
      />
    );
  }
  return (
    <IconClock
      className="size-3.5 shrink-0"
      style={{ color: "var(--text-muted)" }}
      aria-hidden="true"
    />
  );
}

function formatTimestamp(value: string | undefined, neverLabel: string) {
  if (!value || value === "0") {
    return neverLabel;
  }

  const numericValue = Number(value);
  const date = Number.isFinite(numericValue)
    ? new Date(numericValue)
    : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatCronTime(hour: number, minute: number) {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function formatScheduleInputTime(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatCronSchedule(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return null;

  const [minutePart, hourPart, dayOfMonth, month, dayOfWeek] = parts;
  if (
    minutePart === "0" &&
    hourPart === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return "Hourly";
  }

  const minute = Number(minutePart);
  const hour = Number(hourPart);
  if (
    !Number.isInteger(minute) ||
    !Number.isInteger(hour) ||
    minute < 0 ||
    minute > 59 ||
    hour < 0 ||
    hour > 23 ||
    dayOfMonth !== "*" ||
    month !== "*"
  ) {
    return null;
  }

  const time = formatCronTime(hour, minute);
  if (dayOfWeek === "*") {
    return `Daily at ${time}`;
  }
  if (dayOfWeek === "1-5" || dayOfWeek === "MON-FRI") {
    return `Weekdays at ${time}`;
  }
  if (dayOfWeek === "0" || dayOfWeek === "SUN") {
    return `Sundays at ${time}`;
  }
  if (dayOfWeek === "1" || dayOfWeek === "MON") {
    return `Mondays at ${time}`;
  }
  if (dayOfWeek === "2" || dayOfWeek === "TUE") {
    return `Tuesdays at ${time}`;
  }
  if (dayOfWeek === "3" || dayOfWeek === "WED") {
    return `Wednesdays at ${time}`;
  }
  if (dayOfWeek === "4" || dayOfWeek === "THU") {
    return `Thursdays at ${time}`;
  }
  if (dayOfWeek === "5" || dayOfWeek === "FRI") {
    return `Fridays at ${time}`;
  }
  if (dayOfWeek === "6" || dayOfWeek === "SAT") {
    return `Saturdays at ${time}`;
  }

  return null;
}

function parseScheduleForm(value: string | undefined): {
  preset: SchedulePreset;
  time: string;
  weekday: string;
  customSchedule: string;
} {
  const trimmed = value?.trim() ?? "";
  const fallback = {
    preset: "none" as SchedulePreset,
    time: "09:00",
    weekday: "1",
    customSchedule: trimmed,
  };
  if (!trimmed) return fallback;

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return { ...fallback, preset: "custom", customSchedule: trimmed };
  }

  const [minutePart, hourPart, dayOfMonth, month, dayOfWeek] = parts;
  if (
    minutePart === "0" &&
    hourPart === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return { ...fallback, preset: "hourly", customSchedule: trimmed };
  }

  const minute = Number(minutePart);
  const hour = Number(hourPart);
  if (
    !Number.isInteger(minute) ||
    !Number.isInteger(hour) ||
    minute < 0 ||
    minute > 59 ||
    hour < 0 ||
    hour > 23 ||
    dayOfMonth !== "*" ||
    month !== "*"
  ) {
    return { ...fallback, preset: "custom", customSchedule: trimmed };
  }

  const time = formatScheduleInputTime(hour, minute);
  if (dayOfWeek === "*") {
    return { ...fallback, preset: "daily", time, customSchedule: trimmed };
  }
  if (dayOfWeek === "1-5" || dayOfWeek === "MON-FRI") {
    return { ...fallback, preset: "weekdays", time, customSchedule: trimmed };
  }
  const weekdayMap: Record<string, string> = {
    SUN: "0",
    MON: "1",
    TUE: "2",
    WED: "3",
    THU: "4",
    FRI: "5",
    SAT: "6",
  };
  const weekday = weekdayMap[dayOfWeek] ?? dayOfWeek;
  if (/^[0-6]$/.test(weekday)) {
    return {
      ...fallback,
      preset: "weekly",
      time,
      weekday,
      customSchedule: trimmed,
    };
  }

  return { ...fallback, preset: "custom", customSchedule: trimmed };
}

function buildScheduleFromForm({
  preset,
  time,
  weekday,
  customSchedule,
}: {
  preset: SchedulePreset;
  time: string;
  weekday: string;
  customSchedule: string;
}) {
  if (preset === "none") return "";
  if (preset === "custom") return customSchedule.trim();
  if (preset === "hourly") return "0 * * * *";

  const [hourPart = "9", minutePart = "0"] = time.split(":");
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const safeHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9;
  const safeMinute =
    Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0;

  if (preset === "weekdays") {
    return `${safeMinute} ${safeHour} * * 1-5`;
  }
  if (preset === "weekly") {
    const safeWeekday = /^[0-6]$/.test(weekday) ? weekday : "1";
    return `${safeMinute} ${safeHour} * * ${safeWeekday}`;
  }
  return `${safeMinute} ${safeHour} * * *`;
}

function formatSchedule(
  tile: AutomationTile,
  labels: {
    noSchedule: string;
    paused: string;
    pausedWithReason: (reason: string) => string;
  },
) {
  if (tile.schedulePaused) {
    return tile.pausedReason
      ? labels.pausedWithReason(tile.pausedReason)
      : labels.paused;
  }
  return (
    formatCronSchedule(tile.schedule) ?? tile.schedule ?? labels.noSchedule
  );
}

function automationTitle(tile: AutomationTile, untitledLabel: string) {
  return tile.title?.trim() || untitledLabel;
}

function getRunKey(result: AutomationTileResult, index: number) {
  return [
    result.tileResultTimestamp,
    result.created,
    result.updated,
    result.sessionId,
    result.runStatus,
    index,
  ]
    .map((value) => (value == null ? "" : String(value)))
    .join("|");
}

type KeyedAutomationRun = {
  automation: AutomationTile;
  result: AutomationTileResult;
  runKey: string;
};

function runTimestamp(result: AutomationTileResult) {
  const value = result.created ?? result.tileResultTimestamp ?? result.updated;
  if (!value || value === "0") return 0;
  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) return numericValue;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortAutomationResults(results: AutomationTileResult[]) {
  return [...results].sort((a, b) => runTimestamp(b) - runTimestamp(a));
}

function keyAutomationResults(results: AutomationTileResult[]) {
  return sortAutomationResults(results).map((result, index) => ({
    result,
    runKey: getRunKey(result, index),
  }));
}

function getOutputSummary(data: Record<string, unknown> | undefined) {
  if (!data) return null;
  const summary = data.summary;
  if (typeof summary === "string" && summary.trim()) {
    return summary;
  }
  const text = data.text ?? data.markdown ?? data.output;
  if (typeof text === "string" && text.trim()) {
    return text;
  }
  return null;
}

function JsonPreview({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function AutomationOverviewRow({
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
  };
  const latestResultSummary = getOutputSummary(tile.latestRenderedData);
  const title = automationTitle(tile, t("fallbacks.untitledAutomation"));
  const schedule = formatSchedule(tile, scheduleLabels);
  const runStatus =
    tile.latestRunStatus ?? (tile.lastSuccessAt ? "success" : undefined);
  const lastRunAt = runStatus
    ? (tile.updated ?? tile.lastSuccessAt)
    : undefined;
  const lastActivity = lastRunAt
    ? t("overview.lastActivity", {
        time: formatTimestamp(lastRunAt, t("fallbacks.never")),
      })
    : t("overview.neverRun");

  return (
    <button
      type="button"
      className={cn(
        "group grid w-full gap-3 rounded-md px-3 py-3.5 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[minmax(0,1fr)_auto] md:items-center",
        selected && "bg-muted text-foreground",
      )}
      onClick={onOpenDetail}
      aria-label={title}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
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
          <span className="mt-1 block truncate text-sm text-muted-foreground">
            {latestResultSummary}
          </span>
        ) : null}

        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="truncate md:hidden">{schedule}</span>
          <span className="md:hidden" aria-hidden="true">
            ·
          </span>
          <span className="inline-flex items-center gap-1">
            {overviewActivityIcon(runStatus)}
            {lastActivity}
          </span>
        </span>
      </span>

      <span className="hidden max-w-48 truncate text-right text-sm text-muted-foreground md:block">
        {schedule}
      </span>
    </button>
  );
}

function instructionsToText(tile: AutomationTile) {
  return (tile.instructions ?? tile.humanReadableInstructions ?? []).join("\n");
}

function duplicateTitle(tile: AutomationTile, copySuffix: string) {
  return `${automationTitle(tile, "Untitled automation")} ${copySuffix}`;
}

function buildDuplicateAutomationRequest(
  tile: AutomationTile,
  copySuffix: string,
): CreateAutomationTileRequest | undefined {
  if (!canCreateTileType(tile.type)) {
    return undefined;
  }

  const instructions = tile.instructions?.length
    ? tile.instructions
    : (tile.humanReadableInstructions ?? []);

  return {
    type: tile.type,
    title: duplicateTitle(tile, copySuffix),
    schedule: tile.schedule,
    timeZone: automationTimeZone(tile),
    instructions,
    allowHumanInput: tile.allowHumanInput,
    enableNotifications: tile.enableNotifications,
  };
}

function canDuplicateAutomation(tile: AutomationTile) {
  return canCreateTileType(tile.type);
}

function textToInstructions(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function defaultTimeZone() {
  return typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";
}

function automationTimeZone(tile: AutomationTile) {
  return tile.timeZone ?? defaultTimeZone();
}

function supportedTimeZones() {
  const supportedValuesOf = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;

  if (typeof supportedValuesOf === "function") {
    return supportedValuesOf("timeZone");
  }

  return [...FALLBACK_TIME_ZONE_OPTIONS];
}

function AutomationHistory({
  tile,
  tileId,
  selectedRunKey,
  onSelectRun,
}: {
  tile: AutomationTile;
  tileId: string;
  selectedRunKey: string | null;
  onSelectRun: (runKey: string) => void;
}) {
  const { t } = useTranslation("automations");
  const historyQuery = useQuery({
    queryKey: ["automationTileResults", tileId],
    queryFn: () => getAutomationTileResults(tileId),
    refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
  });

  if (historyQuery.isLoading) {
    return (
      <div className="flex min-h-48 items-center justify-center">
        <Spinner className="size-5 text-brand" />
      </div>
    );
  }

  if (historyQuery.error) {
    return (
      <EmptyState
        title={t("history.loadErrorTitle")}
        body={historyQuery.error.message}
      />
    );
  }

  const results = keyAutomationResults(historyQuery.data?.tilesResults ?? []);

  if (!results.length) {
    return (
      <EmptyState
        title={t("history.emptyTitle")}
        body={t("history.emptyBody")}
      />
    );
  }

  const selectedRun =
    results.find((item) => item.runKey === selectedRunKey) ?? results[0];

  return (
    <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(260px,360px)_1fr]">
      <div className="space-y-2">
        {results.map(({ result, runKey }) => (
          <HistoryRunRow
            key={runKey}
            automation={tile}
            result={result}
            selected={runKey === selectedRun.runKey}
            onSelect={() => onSelectRun(runKey)}
          />
        ))}
      </div>
      <RunOutput result={selectedRun.result} />
    </div>
  );
}

function AutomationHistoryFeed({
  automations,
  selectedRunKey,
  onOpenRun,
}: {
  automations: AutomationTile[];
  selectedRunKey: string | null;
  onOpenRun: (automationId: string, runKey: string) => void;
}) {
  const { t } = useTranslation("automations");
  const automationTiles = automations.filter((tile) => tile.id);
  const historyQueries = useQueries({
    queries: automationTiles.map((tile) => ({
      queryKey: ["automationTileResults", tile.id, "global"],
      queryFn: () => getAutomationTileResults(tile.id ?? ""),
      refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
      enabled: Boolean(tile.id),
    })),
  });
  const runs = historyQueries
    .flatMap((query, index): KeyedAutomationRun[] => {
      const automation = automationTiles[index];
      if (!automation) return [];
      return keyAutomationResults(query.data?.tilesResults ?? []).map(
        ({ result, runKey }) => ({
          automation,
          result,
          runKey,
        }),
      );
    })
    .sort((a, b) => runTimestamp(b.result) - runTimestamp(a.result));
  const isLoading = historyQueries.some((query) => query.isLoading);
  const firstError = historyQueries.find((query) => query.error)?.error;

  if (isLoading && !runs.length) {
    return (
      <div className="space-y-3">
        <div className="h-12 rounded-md bg-muted" />
        <div className="h-12 rounded-md bg-muted" />
        <div className="h-12 rounded-md bg-muted" />
      </div>
    );
  }

  if (!runs.length && firstError instanceof Error) {
    return (
      <EmptyState
        title={t("history.loadErrorTitle")}
        body={firstError.message}
      />
    );
  }

  if (!runs.length) {
    return (
      <EmptyState
        title={t("history.emptyTitle")}
        body={t("history.emptyBody")}
      />
    );
  }

  return (
    <section aria-label={t("history.runs")}>
      <div className="space-y-1">
        {runs.map(({ automation, result, runKey }) => (
          <HistoryRunRow
            key={`${automation.id}:${runKey}`}
            automation={automation}
            result={result}
            selected={runKey === selectedRunKey}
            showAutomationTitle
            onSelect={() => {
              if (automation.id) onOpenRun(automation.id, runKey);
            }}
          />
        ))}
      </div>
    </section>
  );
}

function HistoryRunRow({
  automation,
  result,
  selected,
  onSelect,
  showAutomationTitle = false,
}: {
  automation: AutomationTile;
  result: AutomationTileResult;
  selected: boolean;
  onSelect: () => void;
  showAutomationTitle?: boolean;
}) {
  const { t } = useTranslation("automations");
  const summary = getOutputSummary(result.tileData);
  const title = automationTitle(automation, t("fallbacks.untitledAutomation"));

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full gap-1.5 rounded-md px-3 py-3 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected && "bg-muted text-foreground",
      )}
      aria-pressed={selected}
      aria-label={
        showAutomationTitle
          ? `${title}, ${formatTimestamp(result.created, t("fallbacks.never"))}`
          : undefined
      }
    >
      <span className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {showAutomationTitle
            ? title
            : formatTimestamp(result.created, t("fallbacks.never"))}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          {overviewActivityIcon(result.runStatus)}
          {formatStatus(result.runStatus, t("fallbacks.unknown"))}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {showAutomationTitle ? (
          <>
            <span>{formatTimestamp(result.created, t("fallbacks.never"))}</span>
            <span aria-hidden="true">/</span>
          </>
        ) : null}
        <span className="truncate">
          {summary ?? result.sessionId ?? t("history.noSessionId")}
        </span>
      </span>
    </button>
  );
}

function RunOutput({ result }: { result: AutomationTileResult }) {
  const { t } = useTranslation("automations");
  const summary = getOutputSummary(result.tileData);
  const sessionQuery = useQuery({
    queryKey: ["automationSessionMessages", result.sessionId],
    queryFn: () => getAutomationSessionMessages(result.sessionId ?? ""),
    enabled: Boolean(result.sessionId),
  });
  const messages = sessionQuery.data?.messages ?? [];

  return (
    <section className="min-w-0 space-y-5 rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t("history.sessionHistory")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {result.sessionId ?? t("history.noSessionId")}
          </p>
        </div>
        <Badge variant={statusVariant(result.runStatus)}>
          {formatStatus(result.runStatus, t("fallbacks.unknown"))}
        </Badge>
      </div>

      {(summary || result.tileData) && (
        <>
          <Separator />
          <section className="space-y-3">
            <h4 className="text-sm font-medium text-foreground">
              {t("history.runOutput")}
            </h4>
            {summary ? (
              <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-sm leading-relaxed text-foreground">
                {summary}
              </p>
            ) : (
              <JsonPreview value={result.tileData} />
            )}
          </section>
        </>
      )}

      <Separator />

      {!result.sessionId ? (
        <p className="text-sm text-muted-foreground">
          {t("history.sessionUnavailable")}
        </p>
      ) : sessionQuery.isLoading ? (
        <div className="flex min-h-32 items-center justify-center">
          <Spinner className="size-5 text-brand" />
        </div>
      ) : sessionQuery.error ? (
        <EmptyState
          title={t("history.sessionLoadErrorTitle")}
          body={sessionQuery.error.message}
        />
      ) : messages.length ? (
        <div className="h-[34rem] overflow-hidden rounded-lg border border-border bg-background">
          <MessageTimeline messages={messages} className="h-full" />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("history.noSessionMessages")}
        </p>
      )}
    </section>
  );
}

function AutomationsOverview({
  automations,
  onOpenDetail,
}: {
  automations: AutomationTile[];
  onOpenDetail: (automationId: string) => void;
}) {
  const { t } = useTranslation("automations");

  return (
    <div className="space-y-8">
      <section aria-label={t("overview.title")}>
        <div className="space-y-1">
          {automations.map((tile) => {
            const key =
              tile.id ??
              automationTitle(tile, t("fallbacks.untitledAutomation"));
            return (
              <AutomationOverviewRow
                key={key}
                tile={tile}
                onOpenDetail={() => {
                  if (tile.id) onOpenDetail(tile.id);
                }}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}

function AutomationDetailPage({
  tile,
  activeTab,
  selectedRunKey,
  mutationError,
  isSaving,
  isDeleting,
  isDuplicating,
  onActiveTabChange,
  onSelectRun,
  onBack,
  onAdd,
  onRefresh,
  onSave,
  onDelete,
  onDuplicate,
}: {
  tile: AutomationTile;
  activeTab: "details" | "history";
  selectedRunKey: string | null;
  mutationError: string | null;
  isSaving: boolean;
  isDeleting: boolean;
  isDuplicating: boolean;
  onActiveTabChange: (tab: "details" | "history") => void;
  onSelectRun: (runKey: string) => void;
  onBack: () => void;
  onAdd: () => void;
  onRefresh: () => void;
  onSave: (request: UpdateAutomationTileRequest) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { t } = useTranslation("automations");
  const title = automationTitle(tile, t("fallbacks.untitledAutomation"));
  const initialSchedule = parseScheduleForm(tile.schedule);
  const [titleDraft, setTitleDraft] = useState(tile.title ?? "");
  const [instructionsDraft, setInstructionsDraft] = useState(
    instructionsToText(tile),
  );
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>(
    initialSchedule.preset,
  );
  const [scheduleTime, setScheduleTime] = useState(initialSchedule.time);
  const [scheduleWeekday, setScheduleWeekday] = useState(
    initialSchedule.weekday,
  );
  const [customSchedule, setCustomSchedule] = useState(
    initialSchedule.customSchedule,
  );
  const [timeZoneDraft, setTimeZoneDraft] = useState(automationTimeZone(tile));
  const [notificationsDraft, setNotificationsDraft] = useState(
    tile.enableNotifications ?? false,
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const timeZoneOptions = useMemo(
    () =>
      [
        ...new Set([
          automationTimeZone(tile),
          defaultTimeZone(),
          ...supportedTimeZones(),
        ]),
      ]
        .sort((a, b) => a.localeCompare(b))
        .map((timeZone) => ({ value: timeZone, label: timeZone })),
    [tile],
  );
  const latestResultSummary = tile.latestRenderedData
    ? getOutputSummary(tile.latestRenderedData)
    : null;
  const latestRunStatus =
    tile.latestRunStatus ?? (tile.lastSuccessAt ? "success" : undefined);
  const latestRunAt = latestRunStatus
    ? (tile.updated ?? tile.lastSuccessAt)
    : undefined;
  const latestRunActivity = latestRunAt
    ? t("overview.lastActivity", {
        time: formatTimestamp(latestRunAt, t("fallbacks.never")),
      })
    : t("overview.neverRun");
  const schedulePreview =
    (formatCronSchedule(
      buildScheduleFromForm({
        preset: schedulePreset,
        time: scheduleTime,
        weekday: scheduleWeekday,
        customSchedule,
      }),
    ) ??
      buildScheduleFromForm({
        preset: schedulePreset,
        time: scheduleTime,
        weekday: scheduleWeekday,
        customSchedule,
      }).trim()) ||
    t("schedule.none");

  useEffect(() => {
    const nextSchedule = parseScheduleForm(tile.schedule);
    setTitleDraft(tile.title ?? "");
    setInstructionsDraft(instructionsToText(tile));
    setSchedulePreset(nextSchedule.preset);
    setScheduleTime(nextSchedule.time);
    setScheduleWeekday(nextSchedule.weekday);
    setCustomSchedule(nextSchedule.customSchedule);
    setTimeZoneDraft(automationTimeZone(tile));
    setNotificationsDraft(tile.enableNotifications ?? false);
    setLocalError(null);
  }, [tile]);

  const baseUpdateRequest = (): UpdateAutomationTileRequest | null => {
    if (!tile.id) return null;
    const request: UpdateAutomationTileRequest = { id: tile.id };
    const trimmedTitle = titleDraft.trim();
    if (trimmedTitle) {
      request.title = trimmedTitle;
    }
    const currentInstructions = textToInstructions(instructionsDraft);
    if (currentInstructions.length) {
      request.instructions = currentInstructions;
    }
    return request;
  };

  const saveTitle = () => {
    const request = baseUpdateRequest();
    if (!request) return;
    const trimmedTitle = titleDraft.trim();
    if (!trimmedTitle || trimmedTitle === (tile.title ?? "")) return;
    setLocalError(null);
    onSave(request);
  };

  const saveInstructions = () => {
    const request = baseUpdateRequest();
    if (!request) return;
    const nextInstructions = textToInstructions(instructionsDraft);
    const originalInstructions = instructionsToText(tile).trim();
    if (instructionsDraft.trim() === originalInstructions) return;
    if (!nextInstructions.length) {
      setLocalError(t("edit.instructionsRequired"));
      return;
    }
    setLocalError(null);
    onSave({
      ...request,
      updateInstructions: true,
      instructions: nextInstructions,
    });
  };

  const saveSchedule = (next: {
    preset?: SchedulePreset;
    time?: string;
    weekday?: string;
    customSchedule?: string;
  }) => {
    const request = baseUpdateRequest();
    if (!request) return;
    const nextState = {
      preset: next.preset ?? schedulePreset,
      time: next.time ?? scheduleTime,
      weekday: next.weekday ?? scheduleWeekday,
      customSchedule: next.customSchedule ?? customSchedule,
    };
    const nextSchedule = buildScheduleFromForm(nextState);
    if (nextSchedule === (tile.schedule ?? "")) return;
    const nextTimeZone = timeZoneDraft.trim() || automationTimeZone(tile);
    setLocalError(null);
    request.updateSchedule = true;
    if (nextSchedule) {
      request.schedule = nextSchedule;
      request.timeZone = nextTimeZone;
    }
    onSave(request);
  };

  const saveTimeZone = (nextTimeZone = timeZoneDraft) => {
    setTimeZoneDraft(nextTimeZone);
    const request = baseUpdateRequest();
    if (!request) return;
    const trimmedTimeZone = nextTimeZone.trim();
    if (!trimmedTimeZone || trimmedTimeZone === (tile.timeZone ?? "")) return;
    const currentSchedule = buildScheduleFromForm({
      preset: schedulePreset,
      time: scheduleTime,
      weekday: scheduleWeekday,
      customSchedule,
    });
    setLocalError(null);
    const updateRequest: UpdateAutomationTileRequest = {
      id: request.id,
      updateSchedule: true,
      timeZone: trimmedTimeZone,
    };
    if (currentSchedule) {
      updateRequest.schedule = currentSchedule;
    }
    onSave(updateRequest);
  };

  const saveNotifications = (enabled: boolean) => {
    setNotificationsDraft(enabled);
    if (!tile.id || enabled === (tile.enableNotifications ?? false)) return;
    const request = baseUpdateRequest();
    if (!request) return;
    setLocalError(null);
    onSave({ ...request, enableNotifications: enabled });
  };

  const currentError = localError ?? mutationError;
  const detailActions = (
    <>
      <Button
        type="button"
        variant="outline-flat"
        size="xs"
        disabled
        title={t("actions.runUnavailable")}
        leftIcon={<IconPlayerPlay aria-hidden="true" />}
      >
        {t("actions.run")}
      </Button>
      <Button
        type="button"
        variant="outline-flat"
        size="xs"
        onClick={onRefresh}
        aria-label={t("actions.refresh")}
        title={t("actions.refresh")}
        leftIcon={<IconRefresh aria-hidden="true" />}
      >
        {t("actions.refreshShort")}
      </Button>
      <Button
        type="button"
        variant="outline-flat"
        size="xs"
        onClick={onAdd}
        aria-label={t("actions.add")}
        title={t("actions.add")}
        leftIcon={<IconPlus aria-hidden="true" />}
      >
        {t("actions.addShort")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-xs"
            variant="outline-flat"
            aria-label={t("actions.more")}
          >
            <IconDots className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{t("actions.more")}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8}>
          <DropdownMenuItem
            disabled={
              isSaving || isDuplicating || !canDuplicateAutomation(tile)
            }
            onSelect={onDuplicate}
          >
            <IconCopy className="size-3.5" aria-hidden="true" />
            {isDuplicating ? t("actions.duplicating") : t("actions.duplicate")}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={isDeleting}
            onSelect={onDelete}
          >
            <IconTrash className="size-3.5" aria-hidden="true" />
            {t("actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <section className="min-w-0 space-y-8">
      <div className="space-y-5 pb-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <button
            type="button"
            onClick={onBack}
            className="hover:text-foreground"
          >
            {t("title")}
          </button>
          <IconChevronRight className="size-4" aria-hidden="true" />
          <span className="truncate text-foreground">{title}</span>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="max-w-3xl">
              <Input
                variant="ghost"
                aria-label={t("edit.fields.title")}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={saveTitle}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                disabled={isSaving}
                className="h-auto px-0 py-0 text-3xl font-medium tracking-tight text-foreground"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {detailActions}
          </div>
        </div>
      </div>

      {currentError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {currentError}
        </div>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          onActiveTabChange(value as "details" | "history")
        }
      >
        <TabsList variant="buttons">
          <TabsTrigger value="details" variant="buttons">
            {t("tabs.details")}
          </TabsTrigger>
          <TabsTrigger value="history" variant="buttons">
            {t("tabs.history")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-6">
          <div className="grid min-h-0 gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0 space-y-8">
              <section className="space-y-3">
                <h2 className="text-sm font-medium text-foreground">
                  {t("details.instructions")}
                </h2>
                <textarea
                  aria-label={t("edit.fields.instructions")}
                  value={instructionsDraft}
                  onChange={(event) => setInstructionsDraft(event.target.value)}
                  onBlur={saveInstructions}
                  disabled={isSaving}
                  placeholder={t("details.noInstructions")}
                  rows={1}
                  className="min-h-[420px] w-full resize-none bg-transparent px-1 py-0 text-[14px] leading-relaxed text-foreground placeholder:font-light placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-60"
                />
              </section>

              <section className="space-y-3 border-t border-border pt-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-medium text-foreground">
                    {t("details.latestResult")}
                  </h2>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    {overviewActivityIcon(latestRunStatus)}
                    {latestRunActivity}
                  </span>
                </div>
                {latestResultSummary ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                    {latestResultSummary}
                  </p>
                ) : tile.latestRenderedData ? (
                  <JsonPreview value={tile.latestRenderedData} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("details.noLatestResult")}
                  </p>
                )}
              </section>
            </div>

            <aside className="border-t border-border pt-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
              <section className="space-y-4">
                <h2 className="text-xs font-medium text-muted-foreground">
                  {t("details.runSettings")}
                </h2>
                <label
                  className="grid gap-2 text-sm"
                  htmlFor="detail-schedule-preset"
                >
                  <span className="text-xs text-muted-foreground">
                    {t("edit.fields.scheduleRepeats")}
                  </span>
                  <Select
                    value={schedulePreset}
                    onValueChange={(value) => {
                      const nextPreset = value as SchedulePreset;
                      setSchedulePreset(nextPreset);
                      saveSchedule({ preset: nextPreset });
                    }}
                    disabled={isSaving}
                  >
                    <SelectTrigger
                      id="detail-schedule-preset"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">
                        {t("edit.schedulePresets.none")}
                      </SelectItem>
                      <SelectItem value="hourly">
                        {t("edit.schedulePresets.hourly")}
                      </SelectItem>
                      <SelectItem value="daily">
                        {t("edit.schedulePresets.daily")}
                      </SelectItem>
                      <SelectItem value="weekdays">
                        {t("edit.schedulePresets.weekdays")}
                      </SelectItem>
                      <SelectItem value="weekly">
                        {t("edit.schedulePresets.weekly")}
                      </SelectItem>
                      <SelectItem value="custom">
                        {t("edit.schedulePresets.custom")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </label>

                {schedulePreset === "weekly" ? (
                  <label
                    className="grid gap-2 text-sm"
                    htmlFor="detail-schedule-day"
                  >
                    <span className="text-xs text-muted-foreground">
                      {t("edit.fields.scheduleDay")}
                    </span>
                    <Select
                      value={scheduleWeekday}
                      onValueChange={(value) => {
                        setScheduleWeekday(value);
                        saveSchedule({ weekday: value });
                      }}
                      disabled={isSaving}
                    >
                      <SelectTrigger
                        id="detail-schedule-day"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WEEKDAY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {t(option.labelKey)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                ) : null}

                {schedulePreset !== "none" &&
                schedulePreset !== "hourly" &&
                schedulePreset !== "custom" ? (
                  <label
                    className="grid gap-2 text-sm"
                    htmlFor="detail-schedule-time"
                  >
                    <span className="text-xs text-muted-foreground">
                      {t("edit.fields.scheduleTime")}
                    </span>
                    <Input
                      id="detail-schedule-time"
                      type="time"
                      value={scheduleTime}
                      onChange={(event) => setScheduleTime(event.target.value)}
                      onBlur={() => saveSchedule({ time: scheduleTime })}
                      disabled={isSaving}
                    />
                  </label>
                ) : null}

                {schedulePreset === "custom" ? (
                  <label
                    className="grid gap-2 text-sm"
                    htmlFor="detail-schedule-custom"
                  >
                    <span className="text-xs text-muted-foreground">
                      {t("edit.fields.scheduleCustom")}
                    </span>
                    <Input
                      id="detail-schedule-custom"
                      value={customSchedule}
                      onChange={(event) =>
                        setCustomSchedule(event.target.value)
                      }
                      onBlur={() => saveSchedule({ customSchedule })}
                      placeholder={t("edit.fields.schedulePlaceholder")}
                      disabled={isSaving}
                    />
                  </label>
                ) : null}

                <p className="text-xs text-muted-foreground">
                  {t("edit.fields.schedulePreview", {
                    schedule: schedulePreview,
                  })}
                </p>

                <label className="grid gap-2 text-sm" htmlFor="detail-timezone">
                  <span className="text-xs text-muted-foreground">
                    {t("details.timeZone")}
                  </span>
                  <SearchableSelect
                    id="detail-timezone"
                    value={timeZoneDraft}
                    options={timeZoneOptions}
                    onValueChange={saveTimeZone}
                    disabled={isSaving}
                    searchPlaceholder={t("edit.fields.timeZoneSearch")}
                    emptyLabel={t("edit.fields.timeZoneEmpty")}
                  />
                </label>

                <label
                  className="flex items-center justify-between gap-3 text-sm"
                  htmlFor="detail-notifications"
                >
                  <span>
                    <span className="block text-foreground">
                      {t("edit.fields.notifications")}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {notificationsDraft
                        ? t("details.notificationsEnabled")
                        : t("details.notificationsDisabled")}
                    </span>
                  </span>
                  <Switch
                    id="detail-notifications"
                    checked={notificationsDraft}
                    onCheckedChange={saveNotifications}
                    disabled={isSaving}
                    aria-label={t("details.notifications")}
                  />
                </label>
              </section>
            </aside>
          </div>
        </TabsContent>

        <TabsContent value="history" className="mt-6">
          {tile.id ? (
            <AutomationHistory
              tile={tile}
              tileId={tile.id}
              selectedRunKey={selectedRunKey}
              onSelectRun={onSelectRun}
            />
          ) : (
            <EmptyState
              title={t("history.unavailableTitle")}
              body={t("history.unavailableBody")}
            />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

export function AutomationsWorkbench() {
  const { t } = useTranslation("automations");
  const queryClient = useQueryClient();
  const [surfaceMode, setSurfaceMode] =
    useState<AutomationSurfaceMode>("overview");
  const [detailAutomationId, setDetailAutomationId] = useState<string | null>(
    null,
  );
  const [detailTab, setDetailTab] = useState<"details" | "history">("details");
  const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [pendingCreatedAutomationId, setPendingCreatedAutomationId] = useState<
    string | null
  >(null);
  const delayedRefetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [deleteAutomationId, setDeleteAutomationId] = useState<string | null>(
    null,
  );
  const [mutationError, setMutationError] = useState<string | null>(null);

  const automationsQuery = useQuery({
    queryKey: ["automationTiles"],
    queryFn: getAutomationTiles,
    refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
  });

  const automations = useMemo(
    () => automationsQuery.data?.tiles ?? [],
    [automationsQuery.data?.tiles],
  );

  useEffect(() => {
    if (!automations.length) {
      setDetailAutomationId(null);
      setSelectedRunKey(null);
      return;
    }

    if (
      detailAutomationId &&
      !automations.some((tile) => tile.id === detailAutomationId) &&
      detailAutomationId !== pendingCreatedAutomationId
    ) {
      setDetailAutomationId(null);
    }

    if (
      pendingCreatedAutomationId &&
      automations.some((tile) => tile.id === pendingCreatedAutomationId)
    ) {
      setDetailAutomationId(pendingCreatedAutomationId);
      setDetailTab("details");
      setSurfaceMode("overview");
      setBuilderOpen(false);
      setSelectedRunKey(null);
      setPendingCreatedAutomationId(null);
    }
  }, [automations, detailAutomationId, pendingCreatedAutomationId]);

  const detailAutomation = automations.find(
    (tile) => tile.id === detailAutomationId,
  );
  const deleteAutomation =
    automations.find((tile) => tile.id === deleteAutomationId) ??
    (detailAutomationId === deleteAutomationId ? detailAutomation : undefined);

  const detailQuery = useQuery({
    queryKey: ["automationTile", detailAutomationId],
    queryFn: () => getAutomationTile(detailAutomationId ?? ""),
    enabled: Boolean(detailAutomationId),
    refetchInterval: AUTOMATIONS_REFETCH_INTERVAL_MS,
  });

  const detailTile = detailQuery.data?.tileInfo ?? detailAutomation;
  const detailTileId = detailTile?.id;
  const deleteAutomationName = deleteAutomation
    ? automationTitle(deleteAutomation, t("fallbacks.untitledAutomation"))
    : t("fallbacks.untitledAutomation");

  const invalidateAutomationQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["automationTiles"] }),
      queryClient.invalidateQueries({ queryKey: ["automationTile"] }),
      queryClient.invalidateQueries({ queryKey: ["automationTileResults"] }),
    ]);
  };

  const selectCreatedAutomation = (automationId: string) => {
    setPendingCreatedAutomationId(automationId);
    setDetailAutomationId(automationId);
    setDetailTab("details");
    setSurfaceMode("overview");
    setSelectedRunKey(null);
  };

  const scheduleDelayedAutomationsRefetch = () => {
    if (delayedRefetchTimeoutRef.current) {
      clearTimeout(delayedRefetchTimeoutRef.current);
    }
    // kgoose list propagation can lag tile creation, so refetch once more
    // after the immediate refresh.
    delayedRefetchTimeoutRef.current = setTimeout(() => {
      void automationsQuery.refetch();
      delayedRefetchTimeoutRef.current = null;
    }, 1_500);
  };

  const openDetail = (automationId: string) => {
    setBuilderOpen(false);
    setMutationError(null);
    setDeleteAutomationId(null);
    setDetailAutomationId(automationId);
    setDetailTab("details");
    setSelectedRunKey(null);
  };

  const openRunDetail = (automationId: string, runKey: string) => {
    setBuilderOpen(false);
    setMutationError(null);
    setDeleteAutomationId(null);
    setDetailAutomationId(automationId);
    setDetailTab("history");
    setSelectedRunKey(runKey);
  };

  const closeDetail = () => {
    setDetailAutomationId(null);
    setDeleteAutomationId(null);
    setMutationError(null);
    setDetailTab("details");
  };

  const updateMutation = useMutation({
    mutationFn: updateAutomationTile,
    onSuccess: async (response) => {
      if (response.success === false) {
        setMutationError(response.errorMsg ?? t("edit.saveError"));
        return;
      }
      setMutationError(null);
      await invalidateAutomationQueries();
    },
    onError: (error) => {
      setMutationError(
        error instanceof Error ? error.message : t("edit.saveError"),
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAutomationTile,
    onSuccess: async (response) => {
      if (response.success === false) {
        setMutationError(response.errorMsg ?? t("delete.error"));
        return;
      }
      setMutationError(null);
      setDeleteAutomationId(null);
      setDetailAutomationId(null);
      setSelectedRunKey(null);
      await invalidateAutomationQueries();
    },
    onError: (error) => {
      setMutationError(
        error instanceof Error ? error.message : t("delete.error"),
      );
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: (tile: AutomationTile) => {
      const request = buildDuplicateAutomationRequest(
        tile,
        t("duplicate.copySuffix"),
      );
      if (!request) {
        throw new Error(t("duplicate.unsupportedType"));
      }
      return createAutomationTile(request);
    },
    onMutate: () => {
      setMutationError(null);
    },
    onSuccess: async (response) => {
      if (response.success === false) {
        setMutationError(response.errorMsg ?? t("duplicate.error"));
        return;
      }
      const automationId = response.tileId ?? response.automationId;
      if (automationId) {
        selectCreatedAutomation(automationId);
      }
      await invalidateAutomationQueries();
      if (automationId) {
        scheduleDelayedAutomationsRefetch();
      }
    },
    onError: (error) => {
      setMutationError(
        error instanceof Error ? error.message : t("duplicate.error"),
      );
    },
  });

  useEffect(() => {
    return () => {
      if (delayedRefetchTimeoutRef.current) {
        clearTimeout(delayedRefetchTimeoutRef.current);
      }
    };
  }, []);

  const openBuilder = () => {
    setBuilderOpen(true);
    setDetailAutomationId(null);
    setDetailTab("details");
    setSelectedRunKey(null);
    setMutationError(null);
  };

  const headerActions = (
    <>
      <Button
        type="button"
        variant="outline-flat"
        size="xs"
        onClick={() => automationsQuery.refetch()}
        aria-label={t("actions.refresh")}
        title={t("actions.refresh")}
        leftIcon={<IconRefresh aria-hidden="true" />}
      >
        {t("actions.refreshShort")}
      </Button>
      <Button
        type="button"
        variant="outline-flat"
        size="xs"
        onClick={openBuilder}
        aria-label={t("actions.add")}
        title={t("actions.add")}
        leftIcon={<IconPlus aria-hidden="true" />}
      >
        {t("actions.add")}
      </Button>
    </>
  );

  return (
    <>
      {builderOpen ? (
        <AutomationBuilderPanel
          onClose={() => setBuilderOpen(false)}
          onAutomationCreated={(automationId) => {
            if (automationId) {
              selectCreatedAutomation(automationId);
              setBuilderOpen(false);
            }
            void automationsQuery.refetch().then(() => {
              if (!automationId) return;
              scheduleDelayedAutomationsRefetch();
            });
          }}
        />
      ) : (
        <PageShell contentClassName="gap-6">
          {!detailAutomationId ? (
            <PageHeader
              title={t("title")}
              description={t("subtitle")}
              titleClassName="font-normal text-foreground"
              actions={headerActions}
            />
          ) : null}

          {detailAutomationId ? (
            detailQuery.isLoading && !detailTile ? (
              <div className="space-y-4">
                <div className="h-7 w-64 rounded-md bg-muted" />
                <div className="h-40 rounded-lg bg-muted" />
              </div>
            ) : detailTile ? (
              <>
                {detailQuery.error ? (
                  <div className="mb-4">
                    <Badge variant="destructive">
                      <IconAlertTriangle aria-hidden="true" />
                      {t("details.stale")}
                    </Badge>
                  </div>
                ) : null}
                <AutomationDetailPage
                  tile={detailTile}
                  activeTab={detailTab}
                  selectedRunKey={selectedRunKey}
                  mutationError={mutationError}
                  isSaving={updateMutation.isPending}
                  isDeleting={deleteMutation.isPending}
                  isDuplicating={duplicateMutation.isPending}
                  onActiveTabChange={setDetailTab}
                  onSelectRun={setSelectedRunKey}
                  onBack={closeDetail}
                  onAdd={openBuilder}
                  onRefresh={() => {
                    void automationsQuery.refetch();
                    void detailQuery.refetch();
                  }}
                  onSave={(request) => updateMutation.mutate(request)}
                  onDelete={() => {
                    if (!detailTileId) return;
                    setMutationError(null);
                    setDeleteAutomationId(detailTileId);
                  }}
                  onDuplicate={() => duplicateMutation.mutate(detailTile)}
                />
              </>
            ) : (
              <EmptyState
                title={t("details.selectTitle")}
                body={t("details.selectBody")}
              />
            )
          ) : (
            <Tabs
              value={surfaceMode}
              onValueChange={(value) => {
                setSurfaceMode(value as AutomationSurfaceMode);
                setSelectedRunKey(null);
              }}
            >
              <TabsList variant="buttons">
                <TabsTrigger value="overview" variant="buttons">
                  {t("tabs.overview")}
                </TabsTrigger>
                <TabsTrigger value="history" variant="buttons">
                  {t("tabs.history")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="mt-6">
                {automationsQuery.isLoading ? (
                  <div className="space-y-3">
                    <div className="h-20 rounded-lg bg-muted" />
                    <div className="h-12 rounded-lg bg-muted" />
                    <div className="h-12 rounded-lg bg-muted" />
                    <div className="h-12 rounded-lg bg-muted" />
                  </div>
                ) : automationsQuery.error ? (
                  <EmptyState
                    title={t("list.loadErrorTitle")}
                    body={automationsQuery.error.message}
                  />
                ) : automations.length ? (
                  <AutomationsOverview
                    automations={automations}
                    onOpenDetail={openDetail}
                  />
                ) : (
                  <EmptyState
                    title={t("list.emptyTitle")}
                    body={t("list.emptyBody")}
                  />
                )}
              </TabsContent>

              <TabsContent value="history" className="mt-6">
                {automations.length ? (
                  <AutomationHistoryFeed
                    automations={automations}
                    selectedRunKey={selectedRunKey}
                    onOpenRun={openRunDetail}
                  />
                ) : (
                  <EmptyState
                    title={t("history.emptyTitle")}
                    body={t("history.emptyBody")}
                  />
                )}
              </TabsContent>
            </Tabs>
          )}
        </PageShell>
      )}

      <ConfirmDialog
        open={Boolean(deleteAutomationId)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteAutomationId(null);
          }
        }}
        title={t("delete.title")}
        description={t("delete.description", {
          name: deleteAutomationName,
        })}
        cancelLabel={t("actions.cancel")}
        confirmLabel={t("actions.delete")}
        loadingLabel={t("actions.deleting")}
        isLoading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteAutomationId) {
            deleteMutation.mutate(deleteAutomationId);
          }
        }}
      />
    </>
  );
}

export function AutomationsView() {
  return <AutomationsWorkbench />;
}
