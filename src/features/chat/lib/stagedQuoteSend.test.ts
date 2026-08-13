import { describe, expect, it } from "vitest";
import type {
  Message,
  StagedQuoteItem,
  StagedQuoteSourceRange,
} from "@/shared/types/messages";
import {
  buildStagedQuoteDispatchPrompt,
  stagedItemSnapshotsMatch,
  stagedQuoteSourceIsLive,
} from "./stagedQuoteSend";

function makeSource(
  overrides: Partial<StagedQuoteSourceRange> = {},
): StagedQuoteSourceRange {
  return {
    messageId: "message-1",
    role: "assistant",
    contentBlockIndex: 0,
    start: 0,
    end: 12,
    ...overrides,
  };
}

function makeQuote(overrides: Partial<StagedQuoteItem> = {}): StagedQuoteItem {
  return {
    id: "quote-1",
    kind: "quote",
    excerpt: "quoted words",
    sources: [makeSource()],
    ...overrides,
  };
}

function makeMessage(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
  };
}

describe("buildStagedQuoteDispatchPrompt", () => {
  it("returns undefined without quotes", () => {
    expect(buildStagedQuoteDispatchPrompt([], () => true)).toBeUndefined();
  });

  it("anchors when every source is live", () => {
    const prompt = buildStagedQuoteDispatchPrompt([makeQuote()], () => true);
    expect(prompt).toContain("<quoted-passage-anchor>");
    expect(prompt).toContain("quoted words");
    expect(prompt).toContain("appears verbatim earlier");
    expect(prompt).not.toContain("<quoted-passage>");
  });

  it("sends the full excerpt when a source is gone", () => {
    const prompt = buildStagedQuoteDispatchPrompt([makeQuote()], () => false);
    expect(prompt).toContain("<quoted-passage>");
    expect(prompt).toContain("quoted words");
    expect(prompt).not.toContain("<quoted-passage-anchor>");
  });

  it("decides per quote, not session-wide", () => {
    const liveQuote = makeQuote({ id: "quote-live" });
    const lostQuote = makeQuote({
      id: "quote-lost",
      excerpt: "lost words",
      sources: [makeSource({ messageId: "message-gone" })],
    });
    const prompt = buildStagedQuoteDispatchPrompt(
      [liveQuote, lostQuote],
      (source) => source.messageId === "message-1",
    );
    expect(prompt).toContain("<quoted-passage-anchor>");
    expect(prompt).toContain("<quoted-passage>");
    expect(prompt).toContain("lost words");
  });

  it("keeps short anchored excerpts whole", () => {
    const prompt = buildStagedQuoteDispatchPrompt([makeQuote()], () => true);
    expect(prompt).not.toContain("[…]");
  });

  it("elides long anchored excerpts to head and tail", () => {
    const head = "The opening sentence of a very long quoted passage. ";
    const tail = " And the closing sentence that ends the passage.";
    const excerpt = head + "middle ".repeat(120) + tail;
    const prompt = buildStagedQuoteDispatchPrompt(
      [makeQuote({ excerpt })],
      () => true,
    );
    expect(prompt).toContain("[…]");
    expect(prompt).toContain("The opening sentence");
    expect(prompt).toContain("ends the passage.");
    // The elided body is much shorter than the original excerpt.
    expect(prompt?.length ?? 0).toBeLessThan(excerpt.length);
  });

  it("never elides full excerpts for lost sources", () => {
    const excerpt = "word ".repeat(200).trim();
    const prompt = buildStagedQuoteDispatchPrompt(
      [makeQuote({ excerpt })],
      () => false,
    );
    expect(prompt).toContain(excerpt);
    expect(prompt).not.toContain("[…]");
  });

  it("treats a quote with no sources as not anchorable", () => {
    const prompt = buildStagedQuoteDispatchPrompt(
      [makeQuote({ sources: [] })],
      () => true,
    );
    expect(prompt).toContain("<quoted-passage>");
    expect(prompt).not.toContain("<quoted-passage-anchor>");
  });
});

describe("stagedQuoteSourceIsLive", () => {
  it("accepts a source whose block still contains the range", () => {
    expect(
      stagedQuoteSourceIsLive(
        [makeMessage("message-1", "quoted words and more")],
        makeSource(),
      ),
    ).toBe(true);
  });

  it("rejects a missing message", () => {
    expect(
      stagedQuoteSourceIsLive(
        [makeMessage("other-message", "quoted words")],
        makeSource(),
      ),
    ).toBe(false);
  });

  it("rejects a missing or non-text block", () => {
    expect(
      stagedQuoteSourceIsLive(
        [makeMessage("message-1", "quoted words")],
        makeSource({ contentBlockIndex: 3 }),
      ),
    ).toBe(false);
  });

  it("rejects a block rewritten shorter than the quoted range", () => {
    expect(
      stagedQuoteSourceIsLive(
        [makeMessage("message-1", "short")],
        makeSource({ end: 12 }),
      ),
    ).toBe(false);
  });
});

describe("stagedItemSnapshotsMatch", () => {
  it("matches identical snapshots and rejects drift", () => {
    const items = [makeQuote()];
    expect(stagedItemSnapshotsMatch(items, [makeQuote()])).toBe(true);
    expect(stagedItemSnapshotsMatch(items, [makeQuote({ id: "other" })])).toBe(
      false,
    );
    expect(stagedItemSnapshotsMatch(items, [])).toBe(false);
  });
});
