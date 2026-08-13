import {
  readSourceSegmentCoordinates,
  SOURCE_SEGMENT_SELECTOR,
} from "@/shared/ui/ai-elements/markdown-source-segments";
import type {
  Message,
  StagedQuoteItem,
  StagedQuoteSourceRange,
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

/** A quoted slice of one text content block, in canonical coordinates. */
interface MappedBlockQuote {
  source: StagedQuoteSourceRange;
  excerpt: string;
}

/** Maps the portion of the selection range that falls inside one rendered
 * text block back to that block's canonical source range. Returns null when
 * the block's slice of the selection cannot be mapped losslessly. */
function mapBlockQuote(
  blockElement: Element,
  range: Range,
  messages: readonly Message[],
): MappedBlockQuote | null {
  const messageElement = blockElement.closest(QUOTE_MESSAGE_SELECTOR);
  const messageId = messageElement?.getAttribute(MESSAGE_ID_ATTRIBUTE);
  const blockIndex = Number(
    blockElement.getAttribute(CONTENT_BLOCK_INDEX_ATTRIBUTE),
  );
  const sourceTextStart = Number(
    blockElement.getAttribute(SOURCE_TEXT_START_ATTRIBUTE) ?? "0",
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

  // Clamp the selection to this block: boundaries outside the block snap to
  // the block's own edges, so a cross-block selection maps each block's
  // actually selected slice.
  const blockRange = range.cloneRange();
  if (!blockElement.contains(range.startContainer)) {
    blockRange.setStart(blockElement, 0);
  }
  if (!blockElement.contains(range.endContainer)) {
    blockRange.setEnd(blockElement, blockElement.childNodes.length);
  }
  if (blockRange.collapsed) return null;

  const canonicalText = (block as TextContent).text;
  const renderedText = blockElement.textContent ?? "";
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
          blockElement,
          blockRange.startContainer,
          blockRange.startOffset,
        );
      end =
        sourceTextStart +
        getBoundaryOffsetWithin(
          blockElement,
          blockRange.endContainer,
          blockRange.endOffset,
        );
    } catch {
      return null;
    }
  } else {
    // Rendered Markdown: the renderer produced canonical source segments for
    // every rendered text node (see markdown-source-segments.tsx), so the
    // mapper only intersects the DOM range with those segments and reads the
    // canonical offsets back. No Markdown syntax knowledge lives here.
    const mapped = mapRangeThroughSourceSegments(blockElement, blockRange);
    if (mapped) {
      start = sourceTextStart + mapped.start;
      end = sourceTextStart + mapped.end;
    } else {
      // Legacy fallback for markdown surfaces that have not enabled source
      // segments: a unique verbatim occurrence is still a lossless mapping.
      // If the same selection occurs more than once, decline rather than
      // guess.
      const selectedText = blockRange.toString();
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
    excerpt,
    source: {
      messageId,
      role: message.role,
      contentBlockIndex: blockIndex,
      start,
      end,
    },
  };
}

/** Maps a DOM selection back to canonical source ranges. A selection may
 * span multiple text blocks and multiple messages (any roles); each touched
 * block contributes one source range, in document order, and non-text
 * content between them (tool cards, images) is clamped out rather than
 * blocking the quote. */
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

  // Every touched text block, in document order. querySelectorAll already
  // returns document order; include the blocks that contain the boundaries
  // even when the boundary sits in a non-text wrapper inside them.
  const touchedBlocks = Array.from(
    root.querySelectorAll(QUOTE_TEXT_BLOCK_SELECTOR),
  ).filter((blockElement) => rangeIntersectsNode(range, blockElement));
  if (touchedBlocks.length === 0) return null;

  const mapped = touchedBlocks
    .map((blockElement) => mapBlockQuote(blockElement, range, messages))
    .filter((quote): quote is MappedBlockQuote => quote !== null);
  if (mapped.length === 0) return null;

  // A selection is one quote even across messages. Per-block excerpts join
  // with a blank line so the quote reads as the passage the user saw.
  const excerpt = mapped.map((quote) => quote.excerpt).join("\n\n");
  if (!excerpt.trim()) return null;

  return {
    id,
    kind: "quote",
    excerpt,
    sources: mapped.map((quote) => quote.source),
  };
}

export function getQuoteAffordancePosition(
  range: Range,
  root: HTMLElement,
): { left: number; top: number } | null {
  // A multi-line selection's bounding rect spans full line boxes, so its
  // horizontal center can sit far from the swept text. Centering over the
  // first visual line keeps the pill above where the selection begins.
  // getClientRects returns one rect per inline segment (bold spans, links),
  // so several rects can share the first line; union everything whose
  // vertical center falls inside the first rect's line box, or the pill
  // centers over just the first inline segment instead of the line.
  // (getClientRects is missing in some DOM implementations, e.g. jsdom.)
  const rects = Array.from(
    typeof range.getClientRects === "function" ? range.getClientRects() : [],
  ).filter((rect) => rect.width > 0 || rect.height > 0);
  let anchor: { left: number; width: number; top: number };
  if (rects.length > 0) {
    const firstLine = rects[0];
    let left = firstLine.left;
    let right = firstLine.right;
    for (const rect of rects) {
      const centerY = rect.top + rect.height / 2;
      if (centerY < firstLine.top || centerY > firstLine.bottom) continue;
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
    anchor = { left, width: right - left, top: firstLine.top };
  } else {
    const boundingRect = range.getBoundingClientRect();
    if (boundingRect.width === 0 && boundingRect.height === 0) return null;
    anchor = {
      left: boundingRect.left,
      width: boundingRect.width,
      top: boundingRect.top,
    };
  }
  const rootRect = root.getBoundingClientRect();
  return {
    left: Math.min(
      Math.max(anchor.left + anchor.width / 2 - rootRect.left, 16),
      Math.max(16, rootRect.width - 16),
    ),
    top: Math.max(anchor.top - rootRect.top - 8, 8),
  };
}
