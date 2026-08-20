import { segmentGraphemes } from "@/shared/lib/graphemeCount";

function segmentWithIntl(
  value: string,
  locale: string,
  granularity: "grapheme" | "word",
): { segment: string; isWordLike?: boolean }[] | null {
  if (typeof Intl.Segmenter !== "function") return null;
  const segmenter = new Intl.Segmenter(locale, { granularity });
  return Array.from(segmenter.segment(value), ({ segment, isWordLike }) => ({
    segment,
    isWordLike,
  }));
}

export function segmentCardGraphemes(value: string, locale = "en"): string[] {
  return segmentGraphemes(value, locale);
}

/** Returns locale-aware word runs while allowing no-space scripts to wrap. */
export function segmentCardWrapUnits(value: string, locale = "en"): string[] {
  const segments = segmentWithIntl(value, locale, "word");
  if (!segments) return value.match(/\s+|\S+/gu) ?? [];

  return segments.map(({ segment }) => segment);
}

export function truncateCardGraphemes(
  value: string,
  maxGraphemes: number,
  locale = "en",
): string {
  return segmentCardGraphemes(value, locale).slice(0, maxGraphemes).join("");
}
