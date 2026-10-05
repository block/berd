import type { ReactNode } from "react";
import { originalLowercaseOffset } from "@/shared/lib/lowercaseOffset";

/** Literal keyword OR semantics, matching the search service's lowercase
 * comparison and retaining original offsets when Unicode characters expand. */
export function highlightKeywords(text: string, query: string): ReactNode {
  const keywords = [
    ...new Set(query.toLowerCase().trim().split(/\s+/).filter(Boolean)),
  ];
  if (!keywords.length) return text;
  const folded = text.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  for (const keyword of keywords) {
    for (
      let at = folded.indexOf(keyword);
      at !== -1;
      at = folded.indexOf(keyword, at + keyword.length)
    ) {
      ranges.push({
        start: originalLowercaseOffset(text, at),
        end: originalLowercaseOffset(text, at + keyword.length, true),
      });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior && range.start <= prior.end)
      prior.end = Math.max(prior.end, range.end);
    else merged.push(range);
  }
  const parts: ReactNode[] = [];
  let end = 0;
  for (const range of merged) {
    const start = range.start;
    parts.push(text.slice(end, start));
    parts.push(
      <mark
        key={start}
        className="rounded-[2px] bg-warning/10 px-0 text-inherit"
      >
        {text.slice(start, range.end)}
      </mark>,
    );
    end = range.end;
  }
  parts.push(text.slice(end));
  return parts;
}
