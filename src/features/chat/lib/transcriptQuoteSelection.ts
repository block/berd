import type {
  Message,
  StagedQuoteItem,
  TextContent,
} from "@/shared/types/messages";

const MESSAGE_ID_ATTRIBUTE = "data-quote-message-id";
const CONTENT_BLOCK_INDEX_ATTRIBUTE = "data-quote-content-block-index";
const SOURCE_TEXT_START_ATTRIBUTE = "data-quote-source-text-start";

export const QUOTE_MESSAGE_SELECTOR = `[${MESSAGE_ID_ATTRIBUTE}]`;
export const QUOTE_TEXT_BLOCK_SELECTOR = `[${CONTENT_BLOCK_INDEX_ATTRIBUTE}]`;

export function quoteMessageAttributes(messageId: string) {
  return { [MESSAGE_ID_ATTRIBUTE]: messageId };
}

export function quoteTextBlockAttributes(
  contentBlockIndex: number,
  sourceTextStart = 0,
) {
  return {
    [CONTENT_BLOCK_INDEX_ATTRIBUTE]: String(contentBlockIndex),
    [SOURCE_TEXT_START_ATTRIBUTE]: String(sourceTextStart),
  };
}

function closestElement(node: Node | null, selector: string): Element | null {
  const element =
    node?.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node?.parentElement;
  return element?.closest(selector) ?? null;
}

function getBoundaryOffsetWithin(element: Element, node: Node, offset: number) {
  const boundary = document.createRange();
  boundary.selectNodeContents(element);
  boundary.setEnd(node, offset);
  return boundary.toString().length;
}

/** Maps a DOM selection back to the canonical source range for the first
 * production slice: one plain-text content block within one message. */
export function stagedQuoteFromSelection({
  messages,
  root,
  selection,
  id = crypto.randomUUID(),
}: {
  messages: readonly Message[];
  root: HTMLElement;
  selection: Selection;
  id?: string;
}): StagedQuoteItem | null {
  if (selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const startMessage = closestElement(
    range.startContainer,
    QUOTE_MESSAGE_SELECTOR,
  );
  const endMessage = closestElement(range.endContainer, QUOTE_MESSAGE_SELECTOR);
  if (!startMessage || startMessage !== endMessage) return null;

  const startBlock = closestElement(
    range.startContainer,
    QUOTE_TEXT_BLOCK_SELECTOR,
  );
  const endBlock = closestElement(
    range.endContainer,
    QUOTE_TEXT_BLOCK_SELECTOR,
  );
  if (!startBlock || startBlock !== endBlock) return null;

  const messageId = startMessage.getAttribute(MESSAGE_ID_ATTRIBUTE);
  const blockIndex = Number(
    startBlock.getAttribute(CONTENT_BLOCK_INDEX_ATTRIBUTE),
  );
  const sourceTextStart = Number(
    startBlock.getAttribute(SOURCE_TEXT_START_ATTRIBUTE) ?? "0",
  );
  if (
    !messageId ||
    !Number.isInteger(blockIndex) ||
    blockIndex < 0 ||
    !Number.isInteger(sourceTextStart) ||
    sourceTextStart < 0
  )
    return null;

  const message = messages.find((candidate) => candidate.id === messageId);
  const block = message?.content[blockIndex];
  if (!block || block.type !== "text") return null;

  const canonicalText = (block as TextContent).text;
  const renderedSourceText = canonicalText.slice(
    sourceTextStart,
    sourceTextStart + (startBlock.textContent?.length ?? 0),
  );
  // This first production slice intentionally handles only text whose rendered
  // DOM exactly matches its canonical source slice. Markdown decoration,
  // tables, and other transformed text need the next mapper layer; accepting
  // them here would produce plausible-looking but incorrect source offsets.
  if (startBlock.textContent !== renderedSourceText) return null;

  let start: number;
  let end: number;
  try {
    start = getBoundaryOffsetWithin(
      startBlock,
      range.startContainer,
      range.startOffset,
    );
    end = getBoundaryOffsetWithin(
      startBlock,
      range.endContainer,
      range.endOffset,
    );
  } catch {
    return null;
  }

  start += sourceTextStart;
  end += sourceTextStart;
  if (start < 0 || end <= start || end > canonicalText.length) return null;
  const excerpt = canonicalText.slice(start, end);
  if (!excerpt.trim()) return null;

  return {
    id,
    kind: "quote",
    excerpt,
    sources: [{ messageId, contentBlockIndex: blockIndex, start, end }],
  };
}

export function getQuoteAffordancePosition(
  range: Range,
  root: HTMLElement,
): { left: number; top: number } | null {
  const rangeRect = range.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  if (rangeRect.width === 0 && rangeRect.height === 0) return null;
  return {
    left: Math.min(
      Math.max(rangeRect.left + rangeRect.width / 2 - rootRect.left, 16),
      Math.max(16, rootRect.width - 16),
    ),
    top: Math.max(rangeRect.top - rootRect.top - 8, 8),
  };
}
