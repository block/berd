export function segmentGraphemes(value: string, locale = "en"): string[] {
  if (typeof Intl.Segmenter !== "function") return Array.from(value);
  return Array.from(
    new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(value),
    ({ segment }) => segment,
  );
}

export function graphemeCount(value: string, locale = "en"): number {
  return segmentGraphemes(value, locale).length;
}
