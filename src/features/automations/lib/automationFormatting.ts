import { createElement } from "react";
import { IconAlertTriangle, IconCheck, IconClock } from "@tabler/icons-react";
import type {
  AutomationTile,
  AutomationTileResult,
  CreateAutomationTileRequest,
} from "@/features/automations/api/kgooseAutomations";
import { canCreateTileType } from "@/features/automations/lib/creatableTileTypes";
import type { AutomationRunLocation } from "@/app/types/appNavigation";

export type SchedulePreset =
  | "none"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

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

export function formatStatus(
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

export function statusVariant(
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

export function overviewActivityIcon(value: string | number | undefined) {
  const normalized = String(value ?? "").toLowerCase();
  if (!normalized) {
    return createElement(IconClock, {
      className: "size-3.5 shrink-0",
      style: { color: "var(--muted-foreground)" },
      "aria-hidden": "true",
    });
  }
  if (
    normalized.includes("failed") ||
    normalized.includes("input") ||
    normalized.includes("configuration")
  ) {
    return createElement(IconAlertTriangle, {
      className: "size-3.5 shrink-0",
      style: { color: "var(--destructive)" },
      "aria-hidden": "true",
    });
  }
  if (normalized.includes("success") || normalized.includes("active")) {
    return createElement(IconCheck, {
      className: "size-3.5 shrink-0",
      style: { color: "var(--success)" },
      "aria-hidden": "true",
    });
  }
  return createElement(IconClock, {
    className: "size-3.5 shrink-0",
    style: { color: "var(--muted-foreground)" },
    "aria-hidden": "true",
  });
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

export function formatRunActivityTime(
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

export function formatCronSchedule(value: string | undefined) {
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

export function parseScheduleForm(value: string | undefined): {
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

export function buildScheduleFromForm({
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

export function automationTitle(tile: AutomationTile, untitledLabel: string) {
  return tile.title?.trim() || untitledLabel;
}

export function getRunKey(result: AutomationTileResult, index: number) {
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

export type KeyedAutomationRun = {
  automation: AutomationTile;
  result: AutomationTileResult;
  runKey: string;
};

export type SelectedAutomationRun = AutomationRunLocation;

export function runTimestamp(result: AutomationTileResult) {
  const value = result.created ?? result.tileResultTimestamp ?? result.updated;
  if (!value || value === "0") return 0;
  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) return numericValue;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortAutomationResults(results: AutomationTileResult[]) {
  return [...results].sort((a, b) => runTimestamp(b) - runTimestamp(a));
}

export function keyAutomationResults(results: AutomationTileResult[]) {
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

export function getOutputBody(data: Record<string, unknown> | undefined) {
  if (!data) return null;
  const body =
    data.details ?? data.body ?? data.text ?? data.markdown ?? data.output;
  if (typeof body === "string" && body.trim()) {
    return body;
  }
  const summary = data.summary;
  if (typeof summary === "string" && summary.trim()) {
    return summary;
  }
  return null;
}

export function instructionsToText(tile: AutomationTile) {
  return (tile.instructions ?? tile.humanReadableInstructions ?? []).join("\n");
}

export function duplicateTitle(tile: AutomationTile, copySuffix: string) {
  return `${automationTitle(tile, "Untitled automation")} ${copySuffix}`;
}

export function buildDuplicateAutomationRequest(
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

export function canDuplicateAutomation(tile: AutomationTile) {
  return canCreateTileType(tile.type);
}

export function textToInstructions(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function defaultTimeZone() {
  return typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";
}

export function automationTimeZone(tile: AutomationTile) {
  return tile.timeZone ?? defaultTimeZone();
}

export function supportedTimeZones() {
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
