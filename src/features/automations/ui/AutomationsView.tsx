import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBell,
  IconChevronRight,
  IconCheck,
  IconClock,
  IconCopy,
  IconDots,
  IconPencil,
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
import { Textarea } from "@/shared/ui/textarea";
import { PageShell } from "@/shared/ui/page-shell";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import { cn } from "@/shared/lib/cn";
import type {
  AppNavigationUpdateOptions,
  AutomationNavigationRoute,
  AutomationRunLocation,
} from "@/app/types/appNavigation";

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

function parseTimestamp(value: string | undefined) {
  if (!value || value === "0") {
    return new Date(Number.NaN);
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue)
    ? new Date(numericValue)
    : new Date(value);
}

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function formatRunActivityTime(
  value: string | undefined,
  labels: {
    never: string;
    today: string;
    yesterday: string;
    relativeDay: (day: string, time: string) => string;
  },
) {
  const date = parseTimestamp(value);
  if (Number.isNaN(date.getTime())) {
    return value || labels.never;
  }

  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const dayDifference = Math.floor(
    (startOfLocalDay(new Date()).getTime() - startOfLocalDay(date).getTime()) /
      86_400_000,
  );

  if (dayDifference === 0) {
    return labels.relativeDay(labels.today, time);
  }
  if (dayDifference === 1) {
    return labels.relativeDay(labels.yesterday, time);
  }
  if (dayDifference > 1 && dayDifference < 7) {
    const weekday = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
    }).format(date);
    return labels.relativeDay(weekday, time);
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
    return { key: "schedule.cron.hourly" };
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
    return { key: "schedule.cron.daily", values: { time } };
  }
  if (dayOfWeek === "1-5" || dayOfWeek === "MON-FRI") {
    return { key: "schedule.cron.weekdays", values: { time } };
  }
  if (dayOfWeek === "0" || dayOfWeek === "SUN") {
    return { key: "schedule.cron.sunday", values: { time } };
  }
  if (dayOfWeek === "1" || dayOfWeek === "MON") {
    return { key: "schedule.cron.monday", values: { time } };
  }
  if (dayOfWeek === "2" || dayOfWeek === "TUE") {
    return { key: "schedule.cron.tuesday", values: { time } };
  }
  if (dayOfWeek === "3" || dayOfWeek === "WED") {
    return { key: "schedule.cron.wednesday", values: { time } };
  }
  if (dayOfWeek === "4" || dayOfWeek === "THU") {
    return { key: "schedule.cron.thursday", values: { time } };
  }
  if (dayOfWeek === "5" || dayOfWeek === "FRI") {
    return { key: "schedule.cron.friday", values: { time } };
  }
  if (dayOfWeek === "6" || dayOfWeek === "SAT") {
    return { key: "schedule.cron.saturday", values: { time } };
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

export function formatSchedule(
  tile: AutomationTile,
  labels: {
    noSchedule: string;
    paused: string;
    pausedWithReason: (reason: string) => string;
    cron: (key: string, values?: Record<string, string>) => string;
  },
) {
  if (tile.schedulePaused) {
    return tile.pausedReason
      ? labels.pausedWithReason(tile.pausedReason)
      : labels.paused;
  }
  const cronSchedule = formatCronSchedule(tile.schedule);
  return cronSchedule
    ? labels.cron(cronSchedule.key, cronSchedule.values)
    : tile.schedule || labels.noSchedule;
}

export function latestRunTimestampFromTile(tile: AutomationTile) {
  const normalizedStatus = String(tile.latestRunStatus ?? "").toLowerCase();
  if (normalizedStatus.includes("success")) {
    return tile.lastSuccessAt;
  }
  return undefined;
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

type SelectedAutomationRun = AutomationRunLocation;

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

export function getOutputSummary(data: Record<string, unknown> | undefined) {
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
        "inline-flex items-center gap-1 text-xs text-placeholder",
        className,
      )}
    >
      {overviewActivityIcon(status)}
      {label}
    </span>
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
        "group grid w-full gap-3 rounded-md px-3 py-3.5 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring-focus md:grid-cols-[minmax(0,1fr)_auto] md:items-center",
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
          <AutomationActivityLabel status={runStatus} timestamp={lastRunAt} />
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
        <Spinner className="size-5 text-text-primary" />
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
  selectedRun,
  onSelectRun,
  onOpenAutomation,
}: {
  automations: AutomationTile[];
  selectedRun: SelectedAutomationRun | null;
  onSelectRun: (run: SelectedAutomationRun) => void;
  onOpenAutomation: (run: SelectedAutomationRun) => void;
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
  const selectedRunItem = selectedRun
    ? runs.find(
        (run) =>
          run.automation.id === selectedRun.automationId &&
          run.runKey === selectedRun.runKey,
      )
    : undefined;

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
    <section
      aria-label={t("history.runs")}
      className={cn(
        "min-h-0",
        selectedRunItem &&
          "grid gap-4 xl:grid-cols-[minmax(300px,460px)_minmax(0,1fr)]",
      )}
    >
      <div className="space-y-1">
        {runs.map(({ automation, result, runKey }) => (
          <HistoryRunRow
            key={`${automation.id}:${runKey}`}
            automation={automation}
            result={result}
            selected={
              automation.id === selectedRun?.automationId &&
              runKey === selectedRun?.runKey
            }
            showAutomationTitle
            onSelect={() => {
              if (automation.id) {
                onSelectRun({ automationId: automation.id, runKey });
              }
            }}
          />
        ))}
      </div>
      {selectedRunItem ? (
        <RunOutput
          result={selectedRunItem.result}
          action={
            <Button
              type="button"
              size="xs"
              variant="outline-flat"
              onClick={() => {
                if (selectedRun) onOpenAutomation(selectedRun);
              }}
              rightIcon={<IconArrowRight aria-hidden="true" />}
            >
              {t("history.goToAutomation")}
            </Button>
          }
        />
      ) : null}
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
  const runTimeLabel = formatRunActivityTime(result.created, {
    never: t("fallbacks.never"),
    today: t("overview.relativeDays.todayStandalone"),
    yesterday: t("overview.relativeDays.yesterdayStandalone"),
    relativeDay: (day, time) =>
      t("overview.relativeDays.withTime", { day, time }),
  });

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full gap-1.5 rounded-md px-3 py-3 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring-focus",
        selected && "bg-muted text-foreground",
      )}
      aria-pressed={selected}
      aria-label={showAutomationTitle ? `${title}, ${runTimeLabel}` : undefined}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {showAutomationTitle ? title : runTimeLabel}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          {overviewActivityIcon(result.runStatus)}
          {formatStatus(result.runStatus, t("fallbacks.unknown"))}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {showAutomationTitle ? (
          <>
            <span>{runTimeLabel}</span>
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

function RunOutput({
  result,
  action,
}: {
  result: AutomationTileResult;
  action?: ReactNode;
}) {
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
        {action}
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
          <Spinner className="size-5 text-text-primary" />
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
  const [isEditingInstructions, setIsEditingInstructions] = useState(false);
  const [instructionsSaveState, setInstructionsSaveState] = useState<
    "idle" | "requested" | "saving" | "savedPendingRefresh"
  >("idle");
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
  const previousTileIdRef = useRef(tile.id);
  const instructionsDraftRef = useRef(instructionsDraft);
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
  const latestRunAt = latestRunTimestampFromTile(tile);
  useEffect(() => {
    instructionsDraftRef.current = instructionsDraft;
  }, [instructionsDraft]);

  useEffect(() => {
    const nextSchedule = parseScheduleForm(tile.schedule);
    const nextInstructions = instructionsToText(tile);
    const tileIdChanged = previousTileIdRef.current !== tile.id;
    previousTileIdRef.current = tile.id;

    setTitleDraft(tile.title ?? "");
    if (
      tileIdChanged ||
      (!isEditingInstructions && instructionsSaveState === "idle") ||
      (instructionsSaveState === "savedPendingRefresh" &&
        nextInstructions.trim() === instructionsDraftRef.current.trim())
    ) {
      setInstructionsDraft(nextInstructions);
    }
    if (tileIdChanged) {
      setIsEditingInstructions(false);
      setInstructionsSaveState("idle");
    }
    setSchedulePreset(nextSchedule.preset);
    setScheduleTime(nextSchedule.time);
    setScheduleWeekday(nextSchedule.weekday);
    setCustomSchedule(nextSchedule.customSchedule);
    setTimeZoneDraft(automationTimeZone(tile));
    setNotificationsDraft(tile.enableNotifications ?? false);
    setLocalError(null);
  }, [tile, instructionsSaveState, isEditingInstructions]);

  useEffect(() => {
    if (instructionsSaveState === "requested" && isSaving) {
      setInstructionsSaveState("saving");
      return;
    }

    if (instructionsSaveState !== "saving" || isSaving) {
      return;
    }

    if (mutationError) {
      setInstructionsSaveState("idle");
      return;
    }

    setInstructionsSaveState("savedPendingRefresh");
    setIsEditingInstructions(false);
  }, [instructionsSaveState, isSaving, mutationError]);

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
    setInstructionsSaveState("requested");
    onSave({
      ...request,
      updateInstructions: true,
      instructions: nextInstructions,
    });
  };

  const startEditingInstructions = () => {
    setInstructionsDraft(instructionsToText(tile));
    setInstructionsSaveState("idle");
    setLocalError(null);
    setIsEditingInstructions(true);
  };

  const cancelEditingInstructions = () => {
    setInstructionsDraft(instructionsToText(tile));
    setInstructionsSaveState("idle");
    setLocalError(null);
    setIsEditingInstructions(false);
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
    request.schedule = nextSchedule;
    if (nextSchedule || nextTimeZone !== (tile.timeZone ?? "")) {
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
  const instructionsText = instructionsDraft.trim();
  const instructionsChanged =
    instructionsDraft.trim() !== instructionsToText(tile).trim();
  const isSavingInstructions =
    instructionsSaveState === "requested" || instructionsSaveState === "saving";
  const detailActions = (
    <>
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
        <div className="rounded-md border border-border-danger/40 bg-background-danger px-3 py-2 text-sm text-text-danger">
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
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-medium text-foreground">
                    {t("details.latestResult")}
                  </h2>
                  <AutomationActivityLabel
                    status={latestRunStatus}
                    timestamp={latestRunAt}
                  />
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

              <section className="space-y-3 border-t border-border pt-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-medium text-foreground">
                    {t("details.instructions")}
                  </h2>
                  {isEditingInstructions ? (
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={cancelEditingInstructions}
                        disabled={isSavingInstructions}
                      >
                        {t("actions.cancel")}
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        onClick={saveInstructions}
                        disabled={
                          isSavingInstructions ||
                          !instructionsChanged ||
                          !textToInstructions(instructionsDraft).length
                        }
                      >
                        {isSavingInstructions
                          ? t("actions.saving")
                          : t("actions.saveChanges")}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline-flat"
                      size="xs"
                      onClick={startEditingInstructions}
                      disabled={isSaving}
                      aria-label={t("details.editInstructions")}
                      leftIcon={<IconPencil aria-hidden="true" />}
                    >
                      {t("actions.edit")}
                    </Button>
                  )}
                </div>
                {isEditingInstructions ? (
                  <Textarea
                    aria-label={t("edit.fields.instructions")}
                    value={instructionsDraft}
                    onChange={(event) =>
                      setInstructionsDraft(event.target.value)
                    }
                    disabled={isSavingInstructions}
                    placeholder={t("details.noInstructions")}
                    rows={12}
                    className="min-h-[360px] resize-y rounded-md text-[14px] leading-relaxed"
                  />
                ) : instructionsText ? (
                  <div className="min-h-40 whitespace-pre-wrap rounded-md border border-transparent px-1 py-0 text-sm leading-relaxed text-foreground">
                    {instructionsText}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    {t("details.noInstructions")}
                  </div>
                )}
              </section>
            </div>

            <aside className="border-t border-border pt-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8">
              <section className="space-y-4">
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

interface AutomationsWorkbenchProps {
  route?: AutomationNavigationRoute;
  onRouteChange?: (
    route: AutomationNavigationRoute,
    options?: AppNavigationUpdateOptions,
  ) => void;
}

export function AutomationsWorkbench({
  route,
  onRouteChange,
}: AutomationsWorkbenchProps = {}) {
  const { t } = useTranslation("automations");
  const queryClient = useQueryClient();
  const isRouteControlled = route !== undefined;
  const [internalRoute, setInternalRoute] = useState<AutomationNavigationRoute>(
    { surface: "overview" },
  );
  const currentRoute = route ?? internalRoute;
  const surfaceMode: AutomationSurfaceMode =
    currentRoute.surface === "history" ? "history" : "overview";
  const detailAutomationId =
    currentRoute.surface === "detail" ? currentRoute.automationId : null;
  const detailTab =
    currentRoute.surface === "detail" ? currentRoute.tab : "details";
  const selectedRunKey =
    currentRoute.surface === "detail" ? currentRoute.selectedRunKey : null;
  const selectedGlobalRun =
    currentRoute.surface === "history" ? currentRoute.selectedRun : null;
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

  const setNavigationRoute = useCallback(
    (
      nextRoute: AutomationNavigationRoute,
      options?: AppNavigationUpdateOptions,
    ) => {
      if (!isRouteControlled) {
        setInternalRoute(nextRoute);
      }
      onRouteChange?.(nextRoute, options);
    },
    [isRouteControlled, onRouteChange],
  );

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
      if (!automationsQuery.isLoading && currentRoute.surface !== "overview") {
        setNavigationRoute({ surface: "overview" }, { replace: true });
      }
      return;
    }

    if (
      detailAutomationId &&
      !automations.some((tile) => tile.id === detailAutomationId) &&
      detailAutomationId !== pendingCreatedAutomationId
    ) {
      setNavigationRoute({ surface: "overview" }, { replace: true });
    }

    if (
      pendingCreatedAutomationId &&
      automations.some((tile) => tile.id === pendingCreatedAutomationId)
    ) {
      setNavigationRoute(
        {
          surface: "detail",
          automationId: pendingCreatedAutomationId,
          tab: "details",
          selectedRunKey: null,
        },
        { replace: true },
      );
      setBuilderOpen(false);
      setPendingCreatedAutomationId(null);
    }
  }, [
    automations,
    automationsQuery.isLoading,
    currentRoute.surface,
    detailAutomationId,
    pendingCreatedAutomationId,
    setNavigationRoute,
  ]);

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
    setNavigationRoute({
      surface: "detail",
      automationId,
      tab: "details",
      selectedRunKey: null,
    });
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
    setNavigationRoute({
      surface: "detail",
      automationId,
      tab: "details",
      selectedRunKey: null,
    });
  };

  const openRunDetail = (automationId: string, runKey: string) => {
    setBuilderOpen(false);
    setMutationError(null);
    setDeleteAutomationId(null);
    setNavigationRoute({
      surface: "detail",
      automationId,
      tab: "history",
      selectedRunKey: runKey,
    });
  };

  const closeDetail = () => {
    setDeleteAutomationId(null);
    setMutationError(null);
    setNavigationRoute({ surface: "overview" });
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
      setNavigationRoute({ surface: "overview" }, { replace: true });
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

  const openBuilder = useCallback(() => {
    setBuilderOpen(true);
    setNavigationRoute({ surface: "overview" }, { replace: true });
    setMutationError(null);
  }, [setNavigationRoute]);

  const { refetch: refetchAutomations } = automationsQuery;
  const setTopBarActions = useSetTopBarActions();

  useEffect(() => {
    if (detailAutomationId) {
      setTopBarActions(null);
      return;
    }
    setTopBarActions(
      <>
        <Button
          type="button"
          variant="outline-flat"
          size="xs"
          onClick={() => refetchAutomations()}
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
      </>,
    );
    return () => setTopBarActions(null);
  }, [
    detailAutomationId,
    openBuilder,
    refetchAutomations,
    setTopBarActions,
    t,
  ]);

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
                  onActiveTabChange={(tab) => {
                    if (!detailAutomationId) return;
                    setNavigationRoute({
                      surface: "detail",
                      automationId: detailAutomationId,
                      tab,
                      selectedRunKey,
                    });
                  }}
                  onSelectRun={(runKey) => {
                    if (!detailAutomationId) return;
                    setNavigationRoute({
                      surface: "detail",
                      automationId: detailAutomationId,
                      tab: detailTab,
                      selectedRunKey: runKey,
                    });
                  }}
                  onBack={closeDetail}
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
                const nextMode = value as AutomationSurfaceMode;
                setNavigationRoute(
                  nextMode === "history"
                    ? { surface: "history", selectedRun: null }
                    : { surface: "overview" },
                );
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
                    selectedRun={selectedGlobalRun}
                    onSelectRun={(selectedRun) =>
                      setNavigationRoute({
                        surface: "history",
                        selectedRun,
                      })
                    }
                    onOpenAutomation={({ automationId, runKey }) =>
                      openRunDetail(automationId, runKey)
                    }
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
