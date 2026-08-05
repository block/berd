import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { DisclosureButton } from "@/shared/ui/disclosure-button";
import { LinkifiedText } from "@/shared/ui/LinkifiedText";
import {
  createVirtualLayoutStabilityAttributes,
  useVirtualLayoutPendingForChange,
} from "@/features/chat/transcript/measurement";
import { useTranscriptRowStateAdapter } from "@/features/chat/transcript/row-state";

/**
 * Height at which a long user message collapses to a preview. Tuned to read
 * as "there is more below" rather than as a wall of text.
 */
export const USER_MESSAGE_CLAMP_MAX_BLOCK_SIZE = 320;

/**
 * Ignore sub-pixel and rounding noise so a message that merely touches the
 * clamp does not sprout a disclosure that reveals nothing.
 */
const OVERFLOW_TOLERANCE_PX = 4;

/**
 * Short prose cannot reach the 320px preview at the chat bubble's supported
 * widths unless it contains many explicit lines. Keep those common messages
 * off the measurement lifecycle entirely so virtual row cache replay remains
 * a single-render path.
 */
const MIN_MEASURABLE_PREVIEW_CHARACTERS = 160;
const MIN_MEASURABLE_PREVIEW_LINES = 12;

export function couldOverflowUserMessagePreview(text: string): boolean {
  if (text.length >= MIN_MEASURABLE_PREVIEW_CHARACTERS) return true;
  let lines = 1;
  for (const character of text) {
    if (character === "\n") lines += 1;
    if (lines >= MIN_MEASURABLE_PREVIEW_LINES) return true;
  }
  return false;
}

/**
 * Clamps long user-authored prose to a preview with a "View more" disclosure.
 * Structural and interactive message blocks belong outside this component.
 *
 * Measurement uses the real text tree inside the clipped preview shell. A
 * layout effect replaces the full, clipped text with its measured prefix
 * before paint, so steady-state DOM contains only one copy of the prose.
 */
export function UserMessageClamp({
  text,
  stateKey,
}: {
  text: string;
  stateKey: string;
}) {
  const { t } = useTranslation("chat");
  const { rowState, updateRowState, markRowInteracted, pinScrollAnchor } =
    useTranscriptRowStateAdapter();
  const durableExpanded =
    rowState?.userMessageExpandedBlocks?.[stateKey] ??
    rowState?.userMessageExpanded ??
    false;

  const [isExpanded, setIsExpanded] = useState(durableExpanded);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [previewEnd, setPreviewEnd] = useState(text.length);
  const [needsMeasurement, setNeedsMeasurement] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const measuredWidthRef = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text changes intentionally restart the pre-paint measurement phase.
  useLayoutEffect(() => {
    setNeedsMeasurement(true);
  }, [text]);

  // Durable state can arrive after first paint when a virtual row rehydrates.
  useEffect(() => {
    setIsExpanded((current) =>
      current === durableExpanded ? current : durableExpanded,
    );
  }, [durableExpanded]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !needsMeasurement) {
      return;
    }

    const overflowing =
      content.scrollHeight >
      USER_MESSAGE_CLAMP_MAX_BLOCK_SIZE + OVERFLOW_TOLERANCE_PX;
    const nextPreviewEnd = overflowing
      ? findPreviewEnd(content, text, USER_MESSAGE_CLAMP_MAX_BLOCK_SIZE)
      : text.length;

    setIsOverflowing(overflowing);
    setPreviewEnd(nextPreviewEnd);
    setNeedsMeasurement(false);
  }, [needsMeasurement, text]);

  // Recompute wrapping when the available message width changes. Observe only
  // width so swapping full text for its prefix cannot create a resize loop.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined || width === measuredWidthRef.current) {
        return;
      }
      measuredWidthRef.current = width;
      setNeedsMeasurement(true);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const isLayoutPending = useVirtualLayoutPendingForChange(isExpanded);

  const toggle = useCallback(() => {
    const next = !isExpanded;
    markRowInteracted("user-message-clamp");
    pinScrollAnchor();
    updateRowState(
      (current) => ({
        ...current,
        userMessageExpandedBlocks: {
          ...current.userMessageExpandedBlocks,
          [stateKey]: next,
        },
      }),
      { markRecent: true },
    );
    setIsExpanded(next);
  }, [
    isExpanded,
    markRowInteracted,
    pinScrollAnchor,
    stateKey,
    updateRowState,
  ]);

  const isCollapsed = !isExpanded;
  const showFullText = isExpanded || needsMeasurement;
  const visibleEnd =
    showFullText || !isOverflowing
      ? text.length
      : clampToGraphemeBoundary(text, previewEnd);

  return (
    <div
      ref={rootRef}
      data-role="user-message-clamp"
      data-user-message-clamped={
        isCollapsed && isOverflowing ? "true" : "false"
      }
      {...createVirtualLayoutStabilityAttributes({
        isPending: isLayoutPending,
        reason: "dynamic-layout",
      })}
    >
      <div
        className={isCollapsed ? "overflow-hidden" : undefined}
        style={
          isCollapsed
            ? { maxHeight: USER_MESSAGE_CLAMP_MAX_BLOCK_SIZE }
            : undefined
        }
      >
        <div ref={contentRef} data-role="user-message-clamp-content">
          <LinkifiedText text={text} endOffset={visibleEnd} />
        </div>
      </div>

      {isOverflowing ? (
        <div className="relative mt-1 flex">
          {isCollapsed ? (
            <div
              aria-hidden="true"
              data-role="user-message-clamp-fade"
              className="pointer-events-none absolute inset-x-0 bottom-full h-8 bg-gradient-to-b from-transparent to-message-user-bg"
            />
          ) : null}
          <DisclosureButton
            type="button"
            onClick={toggle}
            aria-expanded={isExpanded}
          >
            {isExpanded ? t("message.viewLess") : t("message.viewMore")}
          </DisclosureButton>
        </div>
      ) : null}
    </div>
  );
}

/** Finds the last whitespace boundary whose rendered range fits. */
function findPreviewEnd(
  root: HTMLElement,
  text: string,
  maxBlockSize: number,
): number {
  const textNodes = collectTextNodes(root);
  if (textNodes.length === 0) return 0;

  const rootTop = root.getBoundingClientRect().top;
  const probe = document.createRange();
  probe.selectNodeContents(root);
  const hasRangeLayout =
    typeof probe.getBoundingClientRect === "function" &&
    probe.getBoundingClientRect().height > 0;
  probe.detach();
  if (!hasRangeLayout) {
    return findPreviousWhitespace(text, Math.floor(text.length / 2));
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const boundary = resolveTextBoundary(textNodes, candidate);
    if (!boundary) {
      high = candidate - 1;
      continue;
    }

    const range = document.createRange();
    range.setStart(textNodes[0].node, 0);
    range.setEnd(boundary.node, boundary.offset);
    const fits = range.getBoundingClientRect().bottom - rootTop <= maxBlockSize;
    range.detach();
    if (fits) low = candidate;
    else high = candidate - 1;
  }

  return findPreviousWhitespace(text, low);
}

function findPreviousWhitespace(text: string, fromIndex: number): number {
  for (let index = Math.min(fromIndex, text.length); index > 0; index -= 1) {
    if (/\s/u.test(text[index - 1])) return index - 1;
  }
  return clampToGraphemeBoundary(text, fromIndex);
}

function clampToGraphemeBoundary(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let boundary = 0;
  for (const segment of segmenter.segment(text)) {
    if (segment.index > offset) break;
    boundary = segment.index;
  }
  return boundary;
}

interface IndexedTextNode {
  node: Text;
  start: number;
  end: number;
}

function collectTextNodes(root: HTMLElement): IndexedTextNode[] {
  const nodes: IndexedTextNode[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let start = 0;
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const end = start + node.data.length;
    nodes.push({ node, start, end });
    start = end;
    current = walker.nextNode();
  }
  return nodes;
}

function resolveTextBoundary(
  nodes: readonly IndexedTextNode[],
  offset: number,
): { node: Text; offset: number } | null {
  const match = nodes.find(({ end }) => offset <= end) ?? nodes.at(-1);
  if (!match) return null;
  return {
    node: match.node,
    offset: Math.max(0, Math.min(match.node.data.length, offset - match.start)),
  };
}
