import {
  defaultTimeZone,
  supportedTimeZones,
  type SchedulePreset,
} from "@/features/automations/lib/automationFormatting";

export type BuilderbotScheduleForm = {
  preset: SchedulePreset;
  time: string;
  weekday: string;
  customSchedule: string;
};

const DEFAULT_SCHEDULE_FORM: BuilderbotScheduleForm = {
  preset: "none",
  time: "09:00",
  weekday: "1",
  customSchedule: "",
};

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function builderbotDefaultTimeZone() {
  return defaultTimeZone();
}

export function builderbotTimeZoneOptions(currentTimeZone: string) {
  return [
    ...new Set([
      currentTimeZone,
      builderbotDefaultTimeZone(),
      ...supportedTimeZones(),
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((timeZone) => ({ value: timeZone, label: timeZone }));
}

function parseNumberPart(value: string | undefined, min: number, max: number) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

function formatTime(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function partsForDate(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: Math.max(0, WEEKDAY_NAMES.indexOf(parts.weekday ?? "Sun")),
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = partsForDate(date, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - date.getTime();
}

function zonedTimeToUtc(
  dateParts: Pick<DateParts, "year" | "month" | "day">,
  time: string,
  timeZone: string,
) {
  const [hourPart = "9", minutePart = "0"] = time.split(":");
  const hour = parseNumberPart(hourPart, 0, 23) ?? 9;
  const minute = parseNumberPart(minutePart, 0, 59) ?? 0;
  const localAsUtc = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    hour,
    minute,
  );
  let utc = localAsUtc - timeZoneOffsetMs(new Date(localAsUtc), timeZone);
  utc = localAsUtc - timeZoneOffsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

function addDays(
  dateParts: Pick<DateParts, "year" | "month" | "day">,
  days: number,
) {
  const date = new Date(
    Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + days),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localDateForWeekday(
  weekday: number,
  timeZone: string,
  referenceDate: Date,
) {
  const referenceParts = partsForDate(referenceDate, timeZone);
  const delta = (weekday - referenceParts.weekday + 7) % 7;
  return addDays(referenceParts, delta);
}

function utcDateForWeekday(
  weekday: number,
  referenceDate: Date,
  hour: number,
  minute: number,
) {
  const reference = new Date(
    Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate(),
      hour,
      minute,
    ),
  );
  const delta = (weekday - reference.getUTCDay() + 7) % 7;
  return new Date(reference.getTime() + delta * 86_400_000);
}

function expandDayOfWeek(value: string) {
  if (value === "*") return null;
  if (/^[0-6]$/.test(value)) return [Number(value)];

  const range = value.match(/^([0-6])-([0-6])$/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start <= end) {
      return Array.from(
        { length: end - start + 1 },
        (_, index) => start + index,
      );
    }
  }

  const list = value.split(",").map((part) => Number(part));
  return list.every((part) => Number.isInteger(part) && part >= 0 && part <= 6)
    ? [...new Set(list)].sort((a, b) => a - b)
    : undefined;
}

function weekdayExpression(days: number[]) {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length === 1) return String(unique[0]);
  const contiguous = unique.every(
    (day, index) => index === 0 || day === unique[index - 1] + 1,
  );
  return contiguous
    ? `${unique[0]}-${unique[unique.length - 1]}`
    : unique.join(",");
}

function localDaysFromUtcDays(
  days: number[],
  hour: number,
  minute: number,
  timeZone: string,
  referenceDate: Date,
) {
  return days
    .map(
      (day) =>
        partsForDate(
          utcDateForWeekday(day, referenceDate, hour, minute),
          timeZone,
        ).weekday,
    )
    .sort((a, b) => a - b);
}

function isWeekdays(days: number[]) {
  return days.length === 5 && days.every((day, index) => day === index + 1);
}

export function parseBuilderbotCronSchedule(
  value: string | undefined,
  timeZone = builderbotDefaultTimeZone(),
  referenceDate = new Date(),
): BuilderbotScheduleForm {
  const trimmed = value?.trim() ?? "";
  const fallback = { ...DEFAULT_SCHEDULE_FORM, customSchedule: trimmed };
  if (!trimmed) return fallback;

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return { ...fallback, preset: "custom" };
  }

  const [minutePart, hourPart, dayOfMonth, month, dayOfWeek] = parts;
  if (
    minutePart === "0" &&
    hourPart === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return { ...fallback, preset: "hourly" };
  }

  const minute = parseNumberPart(minutePart, 0, 59);
  const hour = parseNumberPart(hourPart, 0, 23);
  const days = expandDayOfWeek(dayOfWeek);
  if (
    minute === null ||
    hour === null ||
    days === undefined ||
    dayOfMonth !== "*" ||
    month !== "*"
  ) {
    return { ...fallback, preset: "custom" };
  }

  const localParts = partsForDate(
    new Date(
      Date.UTC(
        referenceDate.getUTCFullYear(),
        referenceDate.getUTCMonth(),
        referenceDate.getUTCDate(),
        hour,
        minute,
      ),
    ),
    timeZone,
  );
  const time = formatTime(localParts.hour, localParts.minute);

  if (days === null) {
    return { ...fallback, preset: "daily", time };
  }

  const localDays = localDaysFromUtcDays(
    days,
    hour,
    minute,
    timeZone,
    referenceDate,
  );
  if (isWeekdays(localDays)) {
    return { ...fallback, preset: "weekdays", time };
  }
  if (localDays.length === 1) {
    return {
      ...fallback,
      preset: "weekly",
      weekday: String(localDays[0]),
      time,
    };
  }

  return { ...fallback, preset: "custom" };
}

export function buildBuilderbotCronSchedule(
  form: BuilderbotScheduleForm,
  timeZone = builderbotDefaultTimeZone(),
  referenceDate = new Date(),
) {
  if (form.preset === "none") return "";
  if (form.preset === "custom") return form.customSchedule.trim();
  if (form.preset === "hourly") return "0 * * * *";

  const referenceParts = partsForDate(referenceDate, timeZone);
  const utcForLocalDate = (
    dateParts: Pick<DateParts, "year" | "month" | "day">,
  ) => zonedTimeToUtc(dateParts, form.time, timeZone);

  if (form.preset === "weekdays") {
    const utcDates = [1, 2, 3, 4, 5].map((weekday) =>
      utcForLocalDate(localDateForWeekday(weekday, timeZone, referenceDate)),
    );
    const [firstDate] = utcDates;
    return `${firstDate.getUTCMinutes()} ${firstDate.getUTCHours()} * * ${weekdayExpression(
      utcDates.map((date) => date.getUTCDay()),
    )}`;
  }

  if (form.preset === "weekly") {
    const weekday = /^[0-6]$/.test(form.weekday) ? Number(form.weekday) : 1;
    const utcDate = utcForLocalDate(
      localDateForWeekday(weekday, timeZone, referenceDate),
    );
    return `${utcDate.getUTCMinutes()} ${utcDate.getUTCHours()} * * ${utcDate.getUTCDay()}`;
  }

  const utcDate = utcForLocalDate(referenceParts);
  return `${utcDate.getUTCMinutes()} ${utcDate.getUTCHours()} * * *`;
}
