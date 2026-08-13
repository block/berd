import {
  readSourceSegmentCoordinates,
  SOURCE_SEGMENT_SELECTOR,
} from "@/shared/ui/ai-elements/markdown-source-segments";
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

function rangeIntersectsNode(range: Range, node: Node): boolean {
  if (typeof range.intersectsNode === "function") {
    return range.intersectsNode(node);
  }
  const nodeRange = (node.ownerDocument ?? document).createRange();
  nodeRange.selectNodeContents(node);
  return (
    range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0 &&
    range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0
  );
}

/** Offset of a range boundary within a segment's rendered text, or null
 * when the boundary sits outside the segment. */
function boundaryOffsetInSegment(
  segment: Element,
  range: Range,
  edge: "start" | "end",
): number | null {
  const node = edge === "start" ? range.startContainer : range.endContainer;
  const offset = edge === "start" ? range.startOffset : range.endOffset;
  if (!segment.contains(node)) return null;
  try {
    return getBoundaryOffsetWithin(segment, node, offset);
  } catch {
    return null;
  }
}

/** Maps a DOM range to canonical source offsets using renderer-produced
 * source segments (see markdown-source-segments.tsx). Returns offsets
 * within the Markdown string the renderer parsed, or null when the block
 * carries no segments the range touches. */
function mapRangeThroughSourceSegments(
  block: Element,
  range: Range,
): { start: number; end: number } | null {
  const segments = Array.from(
    block.querySelectorAll(SOURCE_SEGMENT_SELECTOR),
  ).filter((segment) => rangeIntersectsNode(range, segment));
  if (segments.length === 0) return null;

  const firstCoordinates = readSourceSegmentCoordinates(segments[0]);
  const lastCoordinates = readSourceSegmentCoordinates(
    segments[segments.length - 1],
  );
  if (!firstCoordinates || !lastCoordinates) return null;

  // Boundaries inside an exact segment translate directly; boundaries
  // outside a segment (or inside a non-exact one) clamp to the segment's
  // canonical bounds, keeping the quote lossless rather than guessing.
  let start = firstCoordinates.start;
  if (firstCoordinates.exact) {
    const offset = boundaryOffsetInSegment(segments[0], range, "start");
    if (offset !== null) start = firstCoordinates.start + offset;
  }
  let end = lastCoordinates.end;
  if (lastCoordinates.exact) {
    const offset = boundaryOffsetInSegment(
      segments[segments.length - 1],
      range,
      "end",
    );
    if (offset !== null) end = lastCoordinates.start + offset;
  }
  if (end <= start) return null;
  return { start, end };
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
  const renderedText = startBlock.textContent ?? "";
  const renderedSourceText = canonicalText.slice(
    sourceTextStart,
    sourceTextStart + renderedText.length,
  );

  let start: number;
  let end: number;
  if (renderedText === renderedSourceText) {
    // Plain text maps directly because DOM and canonical UTF-16 offsets agree.
    try {
      start =
        sourceTextStart +
        getBoundaryOffsetWithin(
          startBlock,
          range.startContainer,
          range.startOffset,
        );
      end =
        sourceTextStart +
        getBoundaryOffsetWithin(
          startBlock,
          range.endContainer,
          range.endOffset,
        );
    } catch {
      return null;
    }
  } else {
    // Rendered Markdown: the renderer produced canonical source segments for
    // every rendered text node (see markdown-source-segments.tsx), so the
    // mapper only intersects the DOM range with those segments and reads the
    // canonical offsets back. No Markdown syntax knowledge lives here.
    const mapped = mapRangeThroughSourceSegments(startBlock, range);
    if (mapped) {
      start = sourceTextStart + mapped.start;
      end = sourceTextStart + mapped.end;
    } else {
      // Legacy fallback for markdown surfaces that have not enabled source
      // segments: a unique verbatim occurrence is still a lossless mapping.
      // If the same selection occurs more than once, decline rather than
      // guess.
      const selectedText = range.toString();
      if (!selectedText.trim()) return null;
      const canonicalSlice = canonicalText.slice(sourceTextStart);
      const firstMatch = canonicalSlice.indexOf(selectedText);
      if (firstMatch < 0) return null;
      if (canonicalSlice.indexOf(selectedText, firstMatch + 1) >= 0)
        return null;
      start = sourceTextStart + firstMatch;
      end = start + selectedText.length;
    }
  }
  if (start < 0 || end <= start || end > canonicalText.length) return null;
  const excerpt = canonicalText.slice(start, end);
  if (!excerpt.trim()) return null;

  return {
    id,
    kind: "quote",
    excerpt,
    sources: [
      {
        messageId,
        role: message.role,
        contentBlockIndex: blockIndex,
        start,
        end,
      },
    ],
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
