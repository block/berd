import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import { buildTranscriptItems } from "./buildTranscriptItems";
import type { TranscriptAssistantContentFragmentItem } from "./transcriptItemTypes";

/**
 * Fragment source coordinates must stay honest even when a chunk's text
 * does not occur verbatim in the canonical source. The known case is an
 * unterminated fenced code block at a streaming tail: the chunker
 * synthesizes a closing fence, so that chunk's text cannot be located in
 * the source. Such a fragment is deliberately unquotable (-1 coordinates),
 * and — critically — must not poison the search cursor for later chunks.
 */

function makeAssistantMessage(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
  };
}

function fragmentItems(messages: Message[]) {
  return buildTranscriptItems({
    messages,
    streamingMessageId: null,
    nowBucket: "2026-08-13",
    localeKey: "en",
    calendarRevisionToken: "test",
  }).filter(
    (item): item is TranscriptAssistantContentFragmentItem =>
      item.kind === "assistant-content-fragment",
  );
}

describe("assistant fragment source coordinates", () => {
  it("maps every fragment to its verbatim source range", () => {
    // Fragmentation engages at 60+ lines; blank lines between paragraphs
    // count, so 40 paragraphs produce 79 lines.
    const text = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i} with some content to fill the line.`,
    ).join("\n\n");
    const items = fragmentItems([makeAssistantMessage("m1", text)]);

    expect(items.length).toBeGreaterThan(1);
    for (const item of items) {
      const { sourceTextStart, sourceTextEnd } = item.fragment;
      expect(sourceTextStart).toBeGreaterThanOrEqual(0);
      expect(text.slice(sourceTextStart, sourceTextEnd)).toBe(
        item.fragment.content[0].type === "text"
          ? item.fragment.content[0].text
          : "",
      );
    }
  });

  it("marks a synthesized-fence chunk unquotable instead of carrying bogus coordinates", () => {
    // An unterminated fence (streaming tail) swallows all remaining lines
    // and gets a synthesized closing fence, so the chunk's text does not
    // occur verbatim in the source. Paragraphs come first so the message
    // still fragments into multiple chunks.
    const paragraphs = Array.from(
      { length: 15 },
      (_, i) => `Paragraph ${i} before the code block starts.`,
    ).join("\n\n");
    const codeLines = Array.from(
      { length: 10 },
      (_, i) => `const line${i} = ${i};`,
    ).join("\n");
    const text = `${paragraphs}\n\n\`\`\`ts\n${codeLines}`;
    const items = fragmentItems([makeAssistantMessage("m1", text)]);

    expect(items.length).toBeGreaterThan(1);
    const synthesized = items.filter(
      (item) => item.fragment.sourceTextStart < 0,
    );
    const located = items.filter((item) => item.fragment.sourceTextStart >= 0);

    // The unterminated-fence chunk cannot be located in the source.
    expect(synthesized.length).toBe(1);
    // It is explicitly unquotable: both coordinates are -1, never a bogus
    // "start of -1 plus text length" range (the pre-fix behavior).
    expect(synthesized[0].fragment.sourceTextEnd).toBe(-1);

    // Every locatable fragment still slices back to its own text.
    expect(located.length).toBeGreaterThan(0);
    for (const item of located) {
      const { sourceTextStart, sourceTextEnd } = item.fragment;
      expect(text.slice(sourceTextStart, sourceTextEnd)).toBe(
        item.fragment.content[0].type === "text"
          ? item.fragment.content[0].text
          : "",
      );
    }
  });
});
