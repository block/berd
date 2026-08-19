export function graphemeCount(value: string, locale = "en"): number {
  return Array.from(
    new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(value),
  ).length;
}
