import {
  createContext,
  memo,
  useContext,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { Block, type BlockProps, parseMarkdownIntoBlocks } from "streamdown";

/**
 * Renderer-produced canonical source coordinates for rendered Markdown text.
 *
 * The Markdown renderer is the only layer that knows how canonical source
 * text becomes rendered DOM. These utilities preserve that knowledge as
 * neutral source-location metadata:
 *
 * - `rehypeMarkdownSourceSegments` wraps rendered text nodes in spans that
 *   carry the node's canonical start/end offsets within the Markdown block
 *   that produced it (from remark/rehype `position` data, verified against
 *   the block source).
 * - `useMarkdownSourceBlocks` records where each Streamdown block starts
 *   within the full Markdown string, exposed on a wrapper element, so
 *   block-relative segment offsets can be lifted to whole-message offsets.
 *
 * Consumers (for example transcript quote selection) intersect a DOM
 * selection with these segments to recover canonical source ranges. This
 * module stays feature-neutral: it exposes source locations, not product
 * behavior.
 */

export const SOURCE_SEGMENT_START_ATTRIBUTE = "data-md-source-start";
export const SOURCE_SEGMENT_END_ATTRIBUTE = "data-md-source-end";
export const SOURCE_SEGMENT_EXACT_ATTRIBUTE = "data-md-source-exact";
export const SOURCE_BLOCK_START_ATTRIBUTE = "data-md-source-block-start";

export const SOURCE_SEGMENT_SELECTOR = `[${SOURCE_SEGMENT_START_ATTRIBUTE}]`;

/** Parents whose direct text is safe to wrap in an inline span without
 * disturbing plugin-managed rendering (code highlighting, math, mermaid)
 * or invalid-DOM contexts (table scaffolding). Everything else falls back
 * to consumer-side recovery strategies. */
const WRAPPABLE_PARENT_TAGS = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "b",
  "i",
  "del",
  "s",
  "a",
  "td",
  "th",
  "caption",
  "sup",
  "sub",
  "mark",
  "u",
  "ins",
  "dd",
  "dt",
  "summary",
  "blockquote",
]);

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

function annotateTextNodes(node: HastNode, source: string) {
  const children = node.children;
  if (!children) return;
  const parentTag = node.tagName;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type !== "text") {
      annotateTextNodes(child, source);
      continue;
    }
    if (!parentTag || !WRAPPABLE_PARENT_TAGS.has(parentTag)) continue;
    const value = child.value ?? "";
    if (!value.trim()) continue;
    const start = child.position?.start?.offset;
    const end = child.position?.end?.offset;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      start < 0 ||
      end <= start ||
      end > source.length
    ) {
      continue;
    }
    // Exact segments render the canonical source verbatim, so DOM offsets
    // within them translate directly to canonical offsets. Non-exact
    // segments (escapes, entities) still bound the source range.
    const exact = source.slice(start, end) === value;
    children[index] = {
      type: "element",
      tagName: "span",
      properties: {
        dataMdSourceStart: String(start),
        dataMdSourceEnd: String(end),
        ...(exact ? { dataMdSourceExact: "true" } : {}),
      },
      children: [child],
    };
  }
}

/** Rehype plugin producing canonical source segments. Must run after
 * sanitize so the wrapper spans and their data attributes survive. */
export function rehypeMarkdownSourceSegments() {
  return (tree: HastNode, file: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : null;
    if (!source) return;
    annotateTextNodes(tree, source);
  };
}

const BlockStartsContext = createContext<RefObject<number[]> | null>(null);

/** Streamdown BlockComponent that exposes the block's canonical start
 * offset within the full Markdown string on an inert wrapper element. */
const SourceBlockStart = memo(function SourceBlockStart(props: BlockProps) {
  const startsRef = useContext(BlockStartsContext);
  const start = startsRef?.current?.[props.index] ?? 0;
  const attributes = { [SOURCE_BLOCK_START_ATTRIBUTE]: start };
  return (
    <div style={{ display: "contents" }} {...attributes}>
      <Block {...props} />
    </div>
  );
});

export interface MarkdownSourceBlocks {
  parseMarkdownIntoBlocksFn?: (markdown: string) => string[];
  BlockComponent?: typeof SourceBlockStart;
  startsRef: RefObject<number[]>;
}

/** Wraps Streamdown's block parsing to record each block's start offset in
 * the exact string Streamdown parses, so offsets stay aligned even when
 * Streamdown transforms the content before splitting. */
export function useMarkdownSourceBlocks(
  enabled: boolean,
): MarkdownSourceBlocks {
  const startsRef = useRef<number[]>([]);
  const parseMarkdownIntoBlocksFn = useMemo(() => {
    if (!enabled) return undefined;
    return (markdown: string) => {
      const blocks = parseMarkdownIntoBlocks(markdown);
      const starts: number[] = [];
      let cursor = 0;
      for (const block of blocks) {
        const at = markdown.indexOf(block, cursor);
        const resolved = at >= 0 ? at : cursor;
        starts.push(resolved);
        cursor = resolved + block.length;
      }
      startsRef.current = starts;
      return blocks;
    };
  }, [enabled]);
  return {
    parseMarkdownIntoBlocksFn,
    BlockComponent: enabled ? SourceBlockStart : undefined,
    startsRef,
  };
}

export function MarkdownSourceBlocksProvider({
  startsRef,
  children,
}: {
  startsRef: RefObject<number[]>;
  children: React.ReactNode;
}) {
  return (
    <BlockStartsContext.Provider value={startsRef}>
      {children}
    </BlockStartsContext.Provider>
  );
}

/** A rendered text segment's canonical coordinates, read back from DOM. */
export interface SourceSegmentCoordinates {
  /** Canonical start offset within the full Markdown string. */
  start: number;
  /** Canonical end offset within the full Markdown string. */
  end: number;
  /** Whether the segment renders its source verbatim, making DOM text
   * offsets within it translate directly to canonical offsets. */
  exact: boolean;
}

/** Reads a segment element's canonical coordinates, lifting block-relative
 * offsets to whole-string offsets via the enclosing block wrapper. */
export function readSourceSegmentCoordinates(
  segment: Element,
): SourceSegmentCoordinates | null {
  const start = Number(segment.getAttribute(SOURCE_SEGMENT_START_ATTRIBUTE));
  const end = Number(segment.getAttribute(SOURCE_SEGMENT_END_ATTRIBUTE));
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
    return null;
  }
  const blockStartValue = segment
    .closest(`[${SOURCE_BLOCK_START_ATTRIBUTE}]`)
    ?.getAttribute(SOURCE_BLOCK_START_ATTRIBUTE);
  const blockStart = blockStartValue ? Number(blockStartValue) : 0;
  if (!Number.isInteger(blockStart) || blockStart < 0) return null;
  return {
    start: blockStart + start,
    end: blockStart + end,
    exact: segment.hasAttribute(SOURCE_SEGMENT_EXACT_ATTRIBUTE),
  };
}
