import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import {
  quoteMessageAttributes,
  quoteTextBlockAttributes,
  stagedQuoteFromSelection,
} from "./transcriptQuoteSelection";

/**
 * Integration coverage for renderer-produced canonical source segments:
 * real Streamdown rendering with `sourceSegments`, real DOM selections,
 * and the production mapper — no hand-built segment markup.
 */

function makeMessage(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
  };
}

function renderMarkdownMessage(id: string, markdown: string) {
  const utils = render(
    <div {...quoteMessageAttributes(id)}>
      <div {...quoteTextBlockAttributes(0)}>
        <MessageResponse mode="static" sourceSegments>
          {markdown}
        </MessageResponse>
      </div>
    </div>,
  );
  const root = utils.container as HTMLElement;
  const block = root.querySelector<HTMLElement>(
    "[data-quote-content-block-index]",
  );
  if (!block) throw new Error("missing text block");
  return { root, block };
}

function renderMarkdownTranscript(
  messages: readonly { id: string; markdown: string }[],
) {
  const utils = render(
    <div>
      {messages.map((message) => (
        <div key={message.id} {...quoteMessageAttributes(message.id)}>
          <div {...quoteTextBlockAttributes(0)}>
            <MessageResponse mode="static" sourceSegments>
              {message.markdown}
            </MessageResponse>
          </div>
        </div>
      ))}
    </div>,
  );
  return { root: utils.container as HTMLElement };
}

function findTextNode(root: Node, match: string): { node: Text; at: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const at = (node.data ?? "").indexOf(match);
    if (at >= 0) return { node, at };
  }
  throw new Error(`text not found in DOM: ${match}`);
}

function selectBetween(
  root: HTMLElement,
  startText: string,
  endText: string,
): Selection {
  const start = findTextNode(root, startText);
  const end = findTextNode(root, endText);
  const range = document.createRange();
  range.setStart(start.node, start.at);
  range.setEnd(end.node, end.at + endText.length);
  const selection = window.getSelection();
  if (!selection) throw new Error("selection unavailable");
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("stagedQuoteFromSelection with renderer source segments", () => {
  it("maps a selection spanning two numbered list items to canonical source", () => {
    const canonical = [
      "1. Set a clear critique goal upfront.",
      "2. Ask reviewers to separate product concerns from visual polish.",
      "3. End with explicit decisions and owners.",
    ].join("\n");
    const { root } = renderMarkdownMessage("message-1", canonical);

    const selection = selectBetween(
      root,
      "Ask reviewers",
      "explicit decisions and owners.",
    );
    const quote = stagedQuoteFromSelection({
      id: "quote-1",
      messages: [makeMessage("message-1", canonical)],
      root,
      selection,
    });

    expect(quote).not.toBeNull();
    expect(quote?.sources).toHaveLength(1);
    const source = quote?.sources[0];
    const excerpt = canonical.slice(source?.start, source?.end);
    expect(excerpt.startsWith("Ask reviewers")).toBe(true);
    expect(excerpt.endsWith("explicit decisions and owners.")).toBe(true);
    // The canonical excerpt keeps the source's own list marker between items.
    expect(excerpt).toContain("3. End with");
    expect(quote?.excerpt).toBe(excerpt);
  });

  it("maps a selection inside bold text to canonical offsets excluding markers", () => {
    const canonical = "Prefer **structured staged items** over pasted text.";
    const { root } = renderMarkdownMessage("message-1", canonical);

    const selection = selectBetween(root, "structured", "staged items");
    const quote = stagedQuoteFromSelection({
      id: "quote-1",
      messages: [makeMessage("message-1", canonical)],
      root,
      selection,
    });

    expect(quote?.excerpt).toBe("structured staged items");
    expect(quote?.sources[0]).toMatchObject({
      messageId: "message-1",
      contentBlockIndex: 0,
      start: canonical.indexOf("structured"),
      end: canonical.indexOf("staged items") + "staged items".length,
    });
  });

  it("maps repeated phrases to the occurrence actually selected", () => {
    const canonical = [
      "- Retry the request.",
      "- Check the logs.",
      "- Retry the request.",
    ].join("\n");
    const { root } = renderMarkdownMessage("message-1", canonical);

    // Select the second occurrence by walking to the last matching text node.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let lastMatch: Text | null = null;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if ((node.data ?? "").includes("Retry the request.")) lastMatch = node;
    }
    if (!lastMatch) throw new Error("missing repeated phrase");
    const at = lastMatch.data.indexOf("Retry the request.");
    const range = document.createRange();
    range.setStart(lastMatch, at);
    range.setEnd(lastMatch, at + "Retry the request.".length);
    const selection = window.getSelection();
    if (!selection) throw new Error("selection unavailable");
    selection.removeAllRanges();
    selection.addRange(range);

    const quote = stagedQuoteFromSelection({
      id: "quote-1",
      messages: [makeMessage("message-1", canonical)],
      root,
      selection,
    });

    expect(quote?.excerpt).toBe("Retry the request.");
    // The last occurrence starts after the first one.
    expect(quote?.sources[0]?.start).toBe(
      canonical.lastIndexOf("Retry the request."),
    );
  });

  it("maps a selection spanning a paragraph and a list across Streamdown blocks", () => {
    const canonical = [
      "Consider these steps before shipping.",
      "",
      "1. Write the failing test.",
      "2. Fix the bug.",
    ].join("\n");
    const { root } = renderMarkdownMessage("message-1", canonical);

    const selection = selectBetween(root, "these steps", "failing test.");
    const quote = stagedQuoteFromSelection({
      id: "quote-1",
      messages: [makeMessage("message-1", canonical)],
      root,
      selection,
    });

    expect(quote).not.toBeNull();
    const source = quote?.sources[0];
    const excerpt = canonical.slice(source?.start, source?.end);
    expect(excerpt.startsWith("these steps")).toBe(true);
    expect(excerpt.endsWith("failing test.")).toBe(true);
  });

  it("maps a selection inside a link label to the label's canonical range", () => {
    const canonical = "Read the [style guide](https://example.com) first.";
    const { root } = renderMarkdownMessage("message-1", canonical);

    const selection = selectBetween(root, "style", "guide");
    const quote = stagedQuoteFromSelection({
      id: "quote-1",
      messages: [makeMessage("message-1", canonical)],
      root,
      selection,
    });

    expect(quote?.excerpt).toBe("style guide");
    expect(quote?.sources[0]?.start).toBe(canonical.indexOf("style guide"));
  });

  it("maps a selection spanning two markdown messages into one ordered quote", () => {
    const first = "The plan has **three** phases before launch.";
    const second = "1. Ship the beta.\n2. Collect feedback.";
    const { root } = renderMarkdownTranscript([
      { id: "message-1", markdown: first },
      { id: "message-2", markdown: second },
    ]);

    const selection = selectBetween(root, "three", "Ship the beta.");
    const quote = stagedQuoteFromSelection({
      id: "quote-1",
      messages: [
        makeMessage("message-1", first),
        makeMessage("message-2", second),
      ],
      root,
      selection,
    });

    expect(quote).not.toBeNull();
    expect(quote?.sources.map((source) => source.messageId)).toEqual([
      "message-1",
      "message-2",
    ]);
    const [firstSource, secondSource] = quote?.sources ?? [];
    const firstExcerpt = first.slice(firstSource?.start, firstSource?.end);
    const secondExcerpt = second.slice(secondSource?.start, secondSource?.end);
    expect(firstExcerpt.startsWith("three")).toBe(true);
    expect(firstExcerpt.endsWith("phases before launch.")).toBe(true);
    expect(secondExcerpt).toBe("Ship the beta.");
    expect(quote?.excerpt).toBe(`${firstExcerpt}\n\n${secondExcerpt}`);
  });

  it("clamps around non-text blocks between the selected messages", () => {
    const first = "Here is the diagnosis.";
    const second = "And here is the fix.";
    const utils = render(
      <div>
        <div {...quoteMessageAttributes("message-1")}>
          <div {...quoteTextBlockAttributes(0)}>
            <MessageResponse mode="static" sourceSegments>
              {first}
            </MessageResponse>
          </div>
          <div data-testid="tool-card">ran shell command: just check</div>
        </div>
        <div {...quoteMessageAttributes("message-2")}>
          <div {...quoteTextBlockAttributes(0)}>
            <MessageResponse mode="static" sourceSegments>
              {second}
            </MessageResponse>
          </div>
        </div>
      </div>,
    );
    const root = utils.container as HTMLElement;

    const selection = selectBetween(root, "the diagnosis.", "And here");
    const quote = stagedQuoteFromSelection({
      id: "quote-1",
      messages: [
        makeMessage("message-1", first),
        makeMessage("message-2", second),
      ],
      root,
      selection,
    });

    expect(quote).not.toBeNull();
    // The tool card's text is selected in the DOM but contributes nothing:
    // only canonical text blocks produce sources and excerpt content.
    expect(quote?.excerpt).not.toContain("just check");
    expect(quote?.sources.map((source) => source.messageId)).toEqual([
      "message-1",
      "message-2",
    ]);
    expect(quote?.excerpt).toBe("the diagnosis.\n\nAnd here");
  });

  it("maps list-item text after a hard line break despite dropped position data", () => {
    // Hard break + lazy continuation: the Markdown transform strips the
    // continuation indentation, dropping position data on the text node.
    // The annotator must infer bounds so the quote keeps the subcontent.
    const canonical = [
      "Three practical code review tips:",
      "",
      "1. **Review for intent first**  ",
      "   Ask: does this change solve the right problem?",
      "",
      "2. **Leave actionable comments**  ",
      "   Be specific and suggest a path forward.",
    ].join("\n");
    const { root } = renderMarkdownMessage("message-1", canonical);

    const selection = selectBetween(root, "nable comments", "path forward.");
    const quote = stagedQuoteFromSelection({
      id: "quote-1",
      messages: [makeMessage("message-1", canonical)],
      root,
      selection,
    });

    expect(quote).not.toBeNull();
    expect(quote?.excerpt).toContain("nable comments");
    expect(quote?.excerpt).toContain("Be specific and suggest a path forward.");
  });

  it("returns a canonical-bounded quote when the selection covers inline code", () => {
    const canonical = "Run `just check` before pushing.";
    const { root } = renderMarkdownMessage("message-1", canonical);

    const selection = selectBetween(root, "Run", "before pushing.");
    const quote = stagedQuoteFromSelection({
      id: "quote-1",
      messages: [makeMessage("message-1", canonical)],
      root,
      selection,
    });

    expect(quote).not.toBeNull();
    const source = quote?.sources[0];
    const excerpt = canonical.slice(source?.start, source?.end);
    expect(excerpt.startsWith("Run")).toBe(true);
    expect(excerpt.endsWith("before pushing.")).toBe(true);
  });
});
