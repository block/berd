// Transcript display shaping (the "wall of ⚙ rows" polish):
// pure functions between the reducer's messages and the JSX.
//
// Why: goosed emits each tool call as its own assistant message, so a
// replayed agent session (session resume replays EVERYTHING) renders as
// dozens of consecutive `⚙ shell · cd … — completed` rows drowning the
// conversation. Grouping is display-only — the reducer's message list
// stays wire truth.

import type { ChatMessage, ToolActivity } from "./chatModels";

export type TranscriptItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "toolRun"; key: string; tools: ToolActivity[] };

/** Groups consecutive tool-only messages into a single toolRun item.
 *  A message with any non-tool content (text, image) breaks the run and
 *  renders as a normal message row. */
export function groupTranscript(messages: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const message of messages) {
    const toolOnly =
      message.content.length > 0 &&
      message.content.every((c) => c.type === "tool");
    if (!toolOnly) {
      items.push({ kind: "message", message });
      continue;
    }
    const tools = message.content.flatMap((c) =>
      c.type === "tool" ? [c.tool] : [],
    );
    const last = items[items.length - 1];
    if (last && last.kind === "toolRun") {
      mergeTools(last.tools, tools);
    } else {
      items.push({
        kind: "toolRun",
        key: `tools-${message.id}`,
        tools: [...tools],
      });
    }
  }
  return items;
}

function mergeTools(target: ToolActivity[], incoming: ToolActivity[]): void {
  for (const next of incoming) {
    const index = target.findIndex((tool) => tool.id === next.id);
    if (index === -1) {
      target.push(next);
      continue;
    }
    const previous = target[index];
    target[index] = {
      ...previous,
      ...next,
      // Replay often has toolRequest(name) followed by toolResponse(result)
      // with the SAME id but no name. Preserve the real request name.
      name: next.name === "Tool result" ? previous.name : next.name,
      result: next.result ?? previous.result,
    };
  }
}

export function isSettled(tool: ToolActivity): boolean {
  return tool.status === "completed" || tool.status === "failed";
}

export function toolGlyph(status: ToolActivity["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  return "⋯";
}

export function toolResultText(tool: ToolActivity): string | null {
  const result = tool.result?.trim();
  return result && result.length > 0 ? result : null;
}

export function toolDisplayName(tool: ToolActivity): string {
  return tool.name.replace(/\s+/g, " ").trim() || "Tool";
}

/** Display-strips the perch wire preamble from a replayed user message.
 *
 *  Live sends echo the user's BARE words — the preamble is
 *  wire-only. But session resume replays wire truth, so the bracket line
 *  (and the guidance sentence on first sends) reappears in the user
 *  bubble. WE authored that text, so stripping it for display is honest —
 *  the user's own words are never touched: anything that doesn't match
 *  the exact preamble shape passes through verbatim. */
export function stripWirePreamble(text: string): string {
  if (!text.startsWith("[Perched on: ")) return text;
  const gap = text.indexOf("\n\n");
  if (gap === -1) return text; // preamble-only or unexpected shape: show as-is
  return text.slice(gap + 2);
}
