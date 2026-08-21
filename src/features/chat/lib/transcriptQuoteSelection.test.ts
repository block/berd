import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import {
  getQuoteAffordancePosition,
  stagedQuoteFromSelection,
} from "./transcriptQuoteSelection";

function message(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
  };
}

function select(
  start: Text,
  startOffset: number,
  end: Text,
  endOffset: number,
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection();
  if (!selection) throw new Error("selection unavailable");
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("stagedQuoteFromSelection", () => {
  it("captures rendered text with lightweight provenance", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-quote-message-id="m1" data-quote-message-role="assistant"><div data-quote-surface="true">A durable quote callback</div></div>`;
    document.body.append(root);
    const text = root.querySelector("[data-quote-surface]")?.firstChild as Text;
    expect(
      stagedQuoteFromSelection({
        id: "q1",
        messages: [message("m1", "irrelevant markdown")],
        root,
        selection: select(text, 2, text, 15),
      }),
    ).toEqual({
      id: "q1",
      kind: "quote",
      excerpt: "durable quote",
      source: { messageId: "m1", role: "assistant" },
    });
  });

  it("allows projected fragments of one logical message", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-quote-message-id="m1" data-quote-message-role="assistant"><div data-quote-surface="true"><p>first fragment</p></div></div>
      <div data-quote-message-id="m1" data-quote-message-role="assistant"><div data-quote-surface="true"><p>second fragment</p></div></div>`;
    document.body.append(root);
    const paragraphs = root.querySelectorAll("p");
    expect(
      stagedQuoteFromSelection({
        id: "q1",
        messages: [message("m1", "canonical")],
        root,
        selection: select(
          paragraphs[0].firstChild as Text,
          0,
          paragraphs[1].firstChild as Text,
          15,
        ),
      })?.excerpt,
    ).toBe("first fragment\n\nsecond fragment");
  });

  it("rejects selections crossing logical messages", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-quote-message-id="m1"><div data-quote-surface="true">first</div></div>
      <div data-quote-message-id="m2"><div data-quote-surface="true">second</div></div>`;
    document.body.append(root);
    const surfaces = root.querySelectorAll("[data-quote-surface]");
    expect(
      stagedQuoteFromSelection({
        messages: [message("m1", "first"), message("m2", "second")],
        root,
        selection: select(
          surfaces[0].firstChild as Text,
          0,
          surfaces[1].firstChild as Text,
          6,
        ),
      }),
    ).toBeNull();
  });
});

describe("getQuoteAffordancePosition", () => {
  it("centers over all inline segments on the first selected line", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "getBoundingClientRect", {
      value: () => rect(0, 0, 800, 600),
    });
    const range = document.createRange();
    Object.defineProperty(range, "getClientRects", {
      value: () => [rect(100, 100, 100, 20), rect(200, 100, 300, 20)],
    });
    expect(getQuoteAffordancePosition(range, root)).toEqual({
      left: 300,
      top: 92,
    });
  });
});
