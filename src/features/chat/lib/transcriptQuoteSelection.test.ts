import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import {
  getQuoteAffordancePosition,
  stagedQuoteFromSelection,
} from "./transcriptQuoteSelection";

function makeMessage(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
  };
}

function renderPlainTextMessage(id: string, text: string) {
  const root = document.createElement("div");
  root.innerHTML = `<div data-quote-message-id="${id}"><div data-quote-content-block-index="0"></div></div>`;
  const block = root.querySelector<HTMLElement>(
    "[data-quote-content-block-index]",
  );
  if (!block) throw new Error("missing text block");
  block.textContent = text;
  document.body.append(root);
  return { root, block, node: block.firstChild as Text };
}

function selectionFor(node: Text, start: number, end: number): Selection {
  const selection = window.getSelection();
  if (!selection) throw new Error("selection unavailable");
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function makeRect(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("getQuoteAffordancePosition", () => {
  it("centers the pill over the selection's first line, not the bounding box", () => {
    // A multi-line drag: the first line starts mid-paragraph (narrow rect on
    // the right), later lines span the full width. The bounding rect's center
    // sits far left of the swept text — the pre-fix behavior this test pins.
    const root = document.createElement("div");
    Object.defineProperty(root, "getBoundingClientRect", {
      value: () => makeRect({ left: 0, top: 0, width: 800, height: 600 }),
    });
    const firstLine = makeRect({ left: 500, top: 100, width: 200, height: 20 });
    const secondLine = makeRect({ left: 0, top: 120, width: 800, height: 20 });
    const range = document.createRange();
    Object.defineProperty(range, "getClientRects", {
      value: () => [firstLine, secondLine],
    });
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => makeRect({ left: 0, top: 100, width: 800, height: 40 }),
    });

    const position = getQuoteAffordancePosition(range, root);

    // First line center: 500 + 200/2 = 600. Bounding-box center would be 400.
    expect(position).toEqual({ left: 600, top: 92 });
  });

  it("unions inline segments sharing the first line before centering", () => {
    // A selection starting inside a bold span produces one rect per inline
    // segment: bold portion, then plain text — both on the same visual
    // line. Centering on rects[0] alone (the pre-fix behavior) parks the
    // pill over just the bold words instead of the swept line.
    const root = document.createElement("div");
    Object.defineProperty(root, "getBoundingClientRect", {
      value: () => makeRect({ left: 0, top: 0, width: 800, height: 600 }),
    });
    const boldSegment = makeRect({
      left: 100,
      top: 100,
      width: 100,
      height: 20,
    });
    const plainSegment = makeRect({
      left: 200,
      top: 100,
      width: 300,
      height: 20,
    });
    const secondLine = makeRect({ left: 0, top: 120, width: 800, height: 20 });
    const range = document.createRange();
    Object.defineProperty(range, "getClientRects", {
      value: () => [boldSegment, plainSegment, secondLine],
    });
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => makeRect({ left: 0, top: 100, width: 800, height: 40 }),
    });

    const position = getQuoteAffordancePosition(range, root);

    // First-line union spans 100..500, center 300. rects[0] alone would
    // give 150; the bounding box would give 400.
    expect(position).toEqual({ left: 300, top: 92 });
  });

  it("falls back to the bounding rect when getClientRects is unavailable", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "getBoundingClientRect", {
      value: () => makeRect({ left: 0, top: 0, width: 800, height: 600 }),
    });
    const range = document.createRange();
    Object.defineProperty(range, "getClientRects", { value: undefined });
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => makeRect({ left: 100, top: 50, width: 200, height: 20 }),
    });

    expect(getQuoteAffordancePosition(range, root)).toEqual({
      left: 200,
      top: 42,
    });
  });
});

describe("stagedQuoteFromSelection", () => {
  it("maps a plain-text DOM selection to its canonical message range", () => {
    const text = "A durable quote callback";
    const { root, node } = renderPlainTextMessage("message-1", text);

    const quote = stagedQuoteFromSelection({
      id: "quote-1",
      messages: [makeMessage("message-1", text)],
      root,
      selection: selectionFor(node, 2, 15),
    });

    expect(quote).toEqual({
      id: "quote-1",
      kind: "quote",
      excerpt: "durable quote",
      sources: [
        {
          messageId: "message-1",
          role: "assistant",
          contentBlockIndex: 0,
          start: 2,
          end: 15,
        },
      ],
    });
  });

  it("maps a selected numbered-list sentence back into the canonical Markdown source", () => {
    const selected =
      "Ask reviewers to separate product concerns from visual polish.";
    const canonical = [
      "1. Set a clear critique goal upfront.",
      `2. ${selected}`,
      "3. End with explicit decisions and owners.",
    ].join("\n");
    const message = makeMessage("message-1", canonical);
    const { root, block } = renderPlainTextMessage(
      "message-1",
      [
        "Set a clear critique goal upfront.",
        selected,
        "End with explicit decisions and owners.",
      ].join(""),
    );
    const node = block.firstChild as Text;
    const renderedStart = block.textContent?.indexOf(selected) ?? -1;
    const canonicalStart = canonical.indexOf(selected);

    expect(
      stagedQuoteFromSelection({
        id: "quote-1",
        messages: [message],
        root,
        selection: selectionFor(
          node,
          renderedStart,
          renderedStart + selected.length,
        ),
      }),
    ).toEqual({
      id: "quote-1",
      kind: "quote",
      excerpt: selected,
      sources: [
        {
          messageId: "message-1",
          role: "assistant",
          contentBlockIndex: 0,
          start: canonicalStart,
          end: canonicalStart + selected.length,
        },
      ],
    });
  });

  it("maps a selection that crosses message boundaries into one quote", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-quote-message-id="message-1"><div data-quote-content-block-index="0">first</div></div>
      <div data-quote-message-id="message-2"><div data-quote-content-block-index="0">second</div></div>
    `;
    document.body.append(root);
    const nodes = root.querySelectorAll("[data-quote-content-block-index]");
    const range = document.createRange();
    range.setStart(nodes[0].firstChild as Text, 0);
    range.setEnd(nodes[1].firstChild as Text, 6);
    const selection = window.getSelection();
    if (!selection) throw new Error("selection unavailable");
    selection.removeAllRanges();
    selection.addRange(range);

    expect(
      stagedQuoteFromSelection({
        id: "quote-1",
        messages: [
          makeMessage("message-1", "first"),
          makeMessage("message-2", "second"),
        ],
        root,
        selection,
      }),
    ).toEqual({
      id: "quote-1",
      kind: "quote",
      excerpt: "first\n\nsecond",
      sources: [
        {
          messageId: "message-1",
          role: "assistant",
          contentBlockIndex: 0,
          start: 0,
          end: 5,
        },
        {
          messageId: "message-2",
          role: "assistant",
          contentBlockIndex: 0,
          start: 0,
          end: 6,
        },
      ],
    });
  });
});
