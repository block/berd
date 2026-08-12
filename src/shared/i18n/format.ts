import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getCurrentLocale } from "./locale";

const FORMATTER_CACHE_LIMIT = 128;
const numberFormatterCache = new Map<string, Intl.NumberFormat>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormatterCache = new Map<string, Intl.RelativeTimeFormat>();

function stableOptionsKey(options: object | undefined): string {
  if (!options) {
    return "";
  }

  return JSON.stringify(
    Object.entries(options).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function getCachedFormatter<T>(
  cache: Map<string, T>,
  key: string,
  create: () => T,
): T {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const formatter = create();
  cache.set(key, formatter);
  if (cache.size > FORMATTER_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  return formatter;
}

function getNumberFormatter(
  locale: string,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  return getCachedFormatter(
    numberFormatterCache,
    `${locale}\u0000${stableOptionsKey(options)}`,
    () => new Intl.NumberFormat(locale, options),
  );
}

function getDateTimeFormatter(
  locale: string,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return getCachedFormatter(
    dateTimeFormatterCache,
    `${locale}\u0000${stableOptionsKey(options)}`,
    () => new Intl.DateTimeFormat(locale, options),
  );
}

function getRelativeTimeFormatter(
  locale: string,
  options?: Intl.RelativeTimeFormatOptions,
): Intl.RelativeTimeFormat {
  return getCachedFormatter(
    relativeTimeFormatterCache,
    `${locale}\u0000${stableOptionsKey(options)}`,
    () => new Intl.RelativeTimeFormat(locale, options),
  );
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale: string = getCurrentLocale(),
): string {
  return getNumberFormatter(locale, options).format(value);
}

export function formatDate(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
  locale: string = getCurrentLocale(),
): string {
  return getDateTimeFormatter(locale, options).format(toDate(value));
}

export function formatDateParts(
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
  locale: string = getCurrentLocale(),
): Intl.DateTimeFormatPart[] {
  return getDateTimeFormatter(locale, options).formatToParts(toDate(value));
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options?: Intl.RelativeTimeFormatOptions,
  locale: string = getCurrentLocale(),
): string {
  return getRelativeTimeFormatter(locale, options).format(value, unit);
}

export function formatRelativeTimeToNow(
  value: Date | string | number,
  locale: string = getCurrentLocale(),
  options: Intl.RelativeTimeFormatOptions = {
    numeric: "auto",
    style: "short",
  },
): string {
  const date = toDate(value);
  const diffMs = date.getTime() - Date.now();
  const diffSeconds = Math.round(diffMs / 1000);

  if (Math.abs(diffSeconds) < 45) {
    return formatRelativeTime(0, "second", options, locale);
  }

  const diffMinutes = Math.round(diffMs / 60_000);
  if (Math.abs(diffMinutes) < 45) {
    return formatRelativeTime(diffMinutes, "minute", options, locale);
  }

  const diffHours = Math.round(diffMs / 3_600_000);
  if (Math.abs(diffHours) < 24) {
    return formatRelativeTime(diffHours, "hour", options, locale);
  }

  const diffDays = Math.round(diffMs / 86_400_000);
  if (Math.abs(diffDays) < 7) {
    return formatRelativeTime(diffDays, "day", options, locale);
  }

  return formatDate(
    date,
    {
      month: "short",
      day: "numeric",
    },
    locale,
  );
}

export function getTimeParts(
  value: Date | string | number,
  locale: string = getCurrentLocale(),
  options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  },
): {
  hour: string;
  minute: string;
  dayPeriod?: string;
} {
  const parts = formatDateParts(value, options, locale);

  return {
    hour: parts.find((part) => part.type === "hour")?.value ?? "",
    minute: parts.find((part) => part.type === "minute")?.value ?? "",
    dayPeriod: parts.find((part) => part.type === "dayPeriod")?.value,
  };
}

export function useLocaleFormatting() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? getCurrentLocale();

  return useMemo(
    () => ({
      locale,
      formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
        formatNumber(value, options, locale),
      formatDate: (
        value: Date | string | number,
        options?: Intl.DateTimeFormatOptions,
      ) => formatDate(value, options, locale),
      formatDateParts: (
        value: Date | string | number,
        options?: Intl.DateTimeFormatOptions,
      ) => formatDateParts(value, options, locale),
      formatRelativeTime: (
        value: number,
        unit: Intl.RelativeTimeFormatUnit,
        options?: Intl.RelativeTimeFormatOptions,
      ) => formatRelativeTime(value, unit, options, locale),
      formatRelativeTimeToNow: (
        value: Date | string | number,
        options?: Intl.RelativeTimeFormatOptions,
      ) => formatRelativeTimeToNow(value, locale, options),
      getTimeParts: (
        value: Date | string | number,
        options?: Intl.DateTimeFormatOptions,
      ) => getTimeParts(value, locale, options),
    }),
    [locale],
  );
}
