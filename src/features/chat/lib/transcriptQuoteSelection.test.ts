import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import { stagedQuoteFromSelection } from "./transcriptQuoteSelection";

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
          contentBlockIndex: 0,
          start: 2,
          end: 15,
        },
      ],
    });
  });

  it("refuses transformed markdown until the canonical mapper supports it", () => {
    const message = makeMessage("message-1", "**bold** text");
    const { root, block } = renderPlainTextMessage("message-1", "bold text");
    const node = block.firstChild as Text;

    expect(
      stagedQuoteFromSelection({
        id: "quote-1",
        messages: [message],
        root,
        selection: selectionFor(node, 0, 4),
      }),
    ).toBeNull();
  });

  it("refuses a selection that crosses message boundaries", () => {
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
    ).toBeNull();
  });
});
