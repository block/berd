import { truncateAgentCardTitle } from "./agentShareCardSpec";

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
): string {
  const suffix = addEllipsis ? "…" : "";
  if (measure(`${text}${suffix}`) <= maxWidth) return `${text}${suffix}`;

  const characters = Array.from(text);
  while (
    characters.length > 0 &&
    measure(`${characters.join("")}${suffix}`) > maxWidth
  ) {
    characters.pop();
  }
  return `${characters.join("")}${suffix}`;
}

export function wrapAgentCardText(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: TextWidthMeasure,
): string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const fittedWord =
      measure(word) > maxWidth
        ? fitAgentCardText(word, maxWidth, measure, true)
        : word;
    const candidate = line ? `${line} ${fittedWord}` : fittedWord;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) lines.push(line);
    if (lines.length === maxLines) {
      lines[maxLines - 1] = fitAgentCardText(
        lines[maxLines - 1],
        maxWidth,
        measure,
        true,
      );
      return lines;
    }
    line = fittedWord;
  }

  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;

  const clamped = lines.slice(0, maxLines);
  clamped[maxLines - 1] = fitAgentCardText(
    clamped[maxLines - 1] ?? "",
    maxWidth,
    measure,
    true,
  );
  return clamped;
}

export function deriveAgentShareCardTextLayout(
  displayName: string,
  description: string,
  measureTitle: TextWidthMeasure,
  measureDescription: TextWidthMeasure,
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
        );
  const descriptionLines = wrapAgentCardText(
    description,
    AGENT_CARD_DESCRIPTION_MAX_WIDTH,
    AGENT_CARD_DESCRIPTION_MAX_LINES,
    measureDescription,
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
