import { truncateAgentCardTitle } from "./agentShareCardSpec";
import {
  segmentCardGraphemes,
  segmentCardWrapUnits,
} from "./agentShareCardText";

export const AGENT_CARD_TITLE_MAX_WIDTH = 997;
export const AGENT_CARD_DESCRIPTION_MAX_WIDTH = 997;
export const AGENT_CARD_DESCRIPTION_MAX_LINES = 3;
export const AGENT_CARD_THREE_LINE_SHIFT = 52;

export type TextWidthMeasure = (text: string) => number;

export interface AgentShareCardTextLayout {
  title: string;
  descriptionLines: string[];
  contentShift: number;
}

export function fitAgentCardText(
  text: string,
  maxWidth: number,
  measure: TextWidthMeasure,
  addEllipsis = false,
  locale = "en",
): string {
  const suffix = addEllipsis ? "…" : "";
  if (measure(`${text}${suffix}`) <= maxWidth) return `${text}${suffix}`;

  const graphemes = segmentCardGraphemes(text, locale);
  while (
    graphemes.length > 0 &&
    measure(`${graphemes.join("")}${suffix}`) > maxWidth
  ) {
    graphemes.pop();
  }
  return `${graphemes.join("")}${suffix}`;
}

function pushLine(
  lines: string[],
  line: string,
  maxLines: number,
  maxWidth: number,
  measure: TextWidthMeasure,
  hasRemainingContent: boolean,
  locale: string,
): boolean {
  if (!line) return false;
  if (lines.length < maxLines - 1) {
    lines.push(line.trimEnd());
    return false;
  }
  lines.push(
    hasRemainingContent
      ? fitAgentCardText(line.trimEnd(), maxWidth, measure, true, locale)
      : line.trimEnd(),
  );
  return true;
}

export function wrapAgentCardText(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: TextWidthMeasure,
  locale = "en",
): string[] {
  const units = segmentCardWrapUnits(text.trim(), locale);
  const lines: string[] = [];
  let line = "";

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (!unit) continue;
    const candidate = `${line}${unit}`;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (!line) {
      const graphemes = segmentCardGraphemes(unit, locale);
      for (const grapheme of graphemes) {
        if (line && measure(`${line}${grapheme}`) > maxWidth) {
          if (
            pushLine(lines, line, maxLines, maxWidth, measure, true, locale)
          ) {
            return lines;
          }
          line = "";
        }
        line += grapheme;
      }
      continue;
    }

    if (pushLine(lines, line, maxLines, maxWidth, measure, true, locale)) {
      return lines;
    }
    line = unit.trimStart();
    if (measure(line) > maxWidth) {
      const graphemes = segmentCardGraphemes(line, locale);
      line = "";
      for (const grapheme of graphemes) {
        if (line && measure(`${line}${grapheme}`) > maxWidth) {
          if (
            pushLine(lines, line, maxLines, maxWidth, measure, true, locale)
          ) {
            return lines;
          }
          line = "";
        }
        line += grapheme;
      }
    }
  }

  pushLine(lines, line, maxLines, maxWidth, measure, false, locale);
  return lines;
}

export function deriveAgentShareCardTextLayout(
  displayName: string,
  description: string,
  measureTitle: TextWidthMeasure,
  measureDescription: TextWidthMeasure,
  locale = "en",
): AgentShareCardTextLayout {
  const rawTitle = truncateAgentCardTitle(displayName);
  const title =
    measureTitle(rawTitle) <= AGENT_CARD_TITLE_MAX_WIDTH
      ? rawTitle
      : fitAgentCardText(
          rawTitle,
          AGENT_CARD_TITLE_MAX_WIDTH,
          measureTitle,
          true,
          locale,
        );
  const descriptionLines = wrapAgentCardText(
    description,
    AGENT_CARD_DESCRIPTION_MAX_WIDTH,
    AGENT_CARD_DESCRIPTION_MAX_LINES,
    measureDescription,
    locale,
  );
  return {
    title,
    descriptionLines,
    contentShift:
      descriptionLines.length === AGENT_CARD_DESCRIPTION_MAX_LINES
        ? AGENT_CARD_THREE_LINE_SHIFT
        : 0,
  };
}
