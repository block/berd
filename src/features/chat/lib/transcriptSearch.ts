import { escapeRegExp } from "@/shared/lib/escapeRegExp";

/**
 * Find-in-transcript over the rendered DOM.
 *
 * Matching runs against the text the user actually sees, so the match count
 * always equals the number of paintable highlights — markdown syntax, link
 * URLs, code fences, and collapsed or hidden content can never produce
 * phantom matches. Offsets come from a case-insensitive RegExp over the
 * original text, so locale-aware lowercasing can never shift highlight
 * boundaries. Matches may span inline-element boundaries (e.g. bold runs);
 * block boundaries terminate matches, mirroring native find-in-page.
 *
 * Painting uses the CSS Custom Highlight API when available (no DOM
 * mutation, no markdown re-render). Without support, search still counts
 * and navigates; only the inline tint is missing.
 */

/** Safety cap so a one-letter query in a huge transcript stays responsive. */
export const MAX_TRANSCRIPT_SEARCH_MATCHES = 2000;

/**
 * Subtrees carrying this attribute are excluded from matching — for
 * screen-reader-only text and placeholder chrome inside the search root.
 */
export const TRANSCRIPT_SEARCH_SKIP_ATTRIBUTE = "data-transcript-search-skip";

const TRANSCRIPT_SEARCH_HIGHLIGHT = "chat-search-match";
const TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT = "chat-search-match-active";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/**
 * Block-boundary separator. A NUL can never appear in parsed HTML text and is
 * not matched by the `\s+` runs in the needle pattern, so no needle can span
 * a block boundary.
 */
const BLOCK_SEPARATOR = "\u0000";

/** Containers whose text is never rendered as page content. */
const UNRENDERED_CONTAINER_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
]);

/**
 * Tags that continue an inline text run. A text node's "block root" is its
 * nearest ancestor outside this set; consecutive text nodes with different
 * block roots get a separator so matches cannot leak across blocks.
 */
const INLINE_TAGS = new Set([
  "A",
  "ABBR",
  "B",
  "BDI",
  "BDO",
  "CITE",
  "CODE",
  "DATA",
  "DEL",
  "DFN",
  "EM",
  "I",
  "INS",
  "KBD",
  "MARK",
  "Q",
  "S",
  "SAMP",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TIME",
  "U",
  "VAR",
]);

interface TextSegment {
  node: Text;
  /** Inclusive offset of the node's first character in the combined text. */
  start: number;
  /** Exclusive offset of the node's last character in the combined text. */
  end: number;
}

/**
 * CSS collapses whitespace runs and markdown soft line breaks before the user
 * sees them, so whitespace in the needle must match any rendered whitespace
 * run for "search what you see" to hold.
 */
function buildNeedlePattern(needle: string): RegExp {
  const parts = needle.split(/\s+/).filter(Boolean).map(escapeRegExp);
  return new RegExp(parts.join("\\s+"), "giu");
}

function isRenderedElement(element: Element): boolean {
  if (element.namespaceURI !== HTML_NAMESPACE) {
    // SVG/MathML text (mermaid labels, KaTeX annotations) can't reliably be
    // painted by ::highlight, so it is excluded from matching too.
    return false;
  }

  if (
    UNRENDERED_CONTAINER_TAGS.has(element.tagName) ||
    element.hasAttribute(TRANSCRIPT_SEARCH_SKIP_ATTRIBUTE) ||
    // Screen-reader-only text (clipped to a 1px box) is invisible, so its
    // matches could never show a highlight. The repo standardizes on the
    // Tailwind utility, making the class the reliable signal.
    element.classList.contains("sr-only")
  ) {
    return false;
  }

  if (
    typeof element.checkVisibility === "function" &&
    !element.checkVisibility({
      // Steady-state hiding mechanisms beyond display:none. Opacity is
      // deliberately not checked: fade transitions hit opacity 0 without any
      // DOM mutation to re-trigger matching once they finish.
      checkVisibilityCSS: true,
      visibilityProperty: true,
      contentVisibilityAuto: true,
    })
  ) {
    // display:contents wrappers generate no box of their own, so some
    // engines report them as unrendered even though their children render.
    return getComputedStyle(element).display === "contents";
  }

  return true;
}

function blockRootOf(textNode: Text, root: HTMLElement): Element {
  let element = textNode.parentElement;
  while (element && element !== root && INLINE_TAGS.has(element.tagName)) {
    element = element.parentElement;
  }
  return element ?? root;
}

function collectSearchableText(root: HTMLElement): {
  text: string;
  segments: TextSegment[];
} {
  const parts: string[] = [];
  const segments: TextSegment[] = [];
  let length = 0;
  let previousBlockRoot: Element | null = null;

  const pushSeparator = () => {
    parts.push(BLOCK_SEPARATOR);
    length += 1;
  };

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          if (!isRenderedElement(element)) {
            return NodeFilter.FILTER_REJECT;
          }
          // Every non-inline element is emitted so the loop can place a
          // boundary, even when the element itself contributes no text
          // (empty blocks, BR/HR, icon-only wrappers).
          return INLINE_TAGS.has(element.tagName)
            ? NodeFilter.FILTER_SKIP
            : NodeFilter.FILTER_ACCEPT;
        }
        return node.nodeValue
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      pushSeparator();
      continue;
    }

    const textNode = node as Text;
    const value = textNode.nodeValue ?? "";
    const blockRoot = blockRootOf(textNode, root);
    if (previousBlockRoot !== null && blockRoot !== previousBlockRoot) {
      pushSeparator();
    }
    previousBlockRoot = blockRoot;

    segments.push({
      node: textNode,
      start: length,
      end: length + value.length,
    });
    parts.push(value);
    length += value.length;
  }

  return { text: parts.join(""), segments };
}

/**
 * Extracts the searchable text under `root` — the same text
 * findTranscriptMatches matches against, with NUL block separators. Lets a
 * caller index rendered text (e.g. per virtualized row) and count matches
 * later without keeping the DOM mounted.
 */
export function collectTranscriptSearchText(root: HTMLElement): string {
  return collectSearchableText(root).text;
}

/**
 * Counts matches of `query` in text produced by collectTranscriptSearchText.
 * Same needle semantics as findTranscriptMatches, so a count from cached text
 * equals the count of ranges the same content yields when mounted.
 */
export function countTranscriptMatches(text: string, query: string): number {
  const needle = query.trim();
  if (!needle || !text) {
    return 0;
  }

  let count = 0;
  for (const _ of text.matchAll(buildNeedlePattern(needle))) {
    count += 1;
  }
  return count;
}

/**
 * Finds every visible occurrence of `query` under `root`, in document order,
 * as live DOM ranges. Case-insensitive; matches may span inline elements.
 */
export function findTranscriptMatches(
  root: HTMLElement,
  query: string,
): Range[] {
  const needle = query.trim();
  if (!needle) {
    return [];
  }

  const { text, segments } = collectSearchableText(root);
  if (segments.length === 0) {
    return [];
  }

  const pattern = buildNeedlePattern(needle);
  const ranges: Range[] = [];
  let segmentIndex = 0;

  for (const match of text.matchAll(pattern)) {
    if (ranges.length >= MAX_TRANSCRIPT_SEARCH_MATCHES) {
      break;
    }

    const start = match.index;
    const end = start + match[0].length;

    // matchAll yields ascending offsets, so the segment cursor only moves
    // forward. Separators occupy offsets owned by no segment; the needle
    // pattern can never match the NUL separator.
    while (
      segmentIndex < segments.length &&
      segments[segmentIndex].end <= start
    ) {
      segmentIndex += 1;
    }
    const startSegment = segments[segmentIndex];
    if (!startSegment || start < startSegment.start) {
      continue;
    }

    let endSegmentIndex = segmentIndex;
    while (
      endSegmentIndex < segments.length &&
      segments[endSegmentIndex].end < end
    ) {
      endSegmentIndex += 1;
    }
    const endSegment = segments[endSegmentIndex];
    if (!endSegment || end <= endSegment.start) {
      continue;
    }

    const range = document.createRange();
    range.setStart(startSegment.node, start - startSegment.start);
    range.setEnd(endSegment.node, end - endSegment.start);
    ranges.push(range);
  }

  return ranges;
}

export function supportsTranscriptSearchHighlights(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight === "function"
  );
}

// Reuse one Highlight instance per name and mutate its range set in place.
// WKWebView fails to repaint the regions of ranges dropped when a registry
// entry is wholesale-replaced with a new Highlight, leaving stale tints;
// set-like mutation of a registered Highlight invalidates correctly.
let matchHighlight: Highlight | null = null;
let activeMatchHighlight: Highlight | null = null;
let lastPaintedRanges: Range[] | null = null;

function setHighlightRanges(highlight: Highlight, ranges: Range[]): void {
  highlight.clear();
  for (const range of ranges) {
    highlight.add(range);
  }
}

/**
 * Paints all matches plus the active match (styled by the
 * `::highlight(chat-search-match*)` rules in globals.css).
 */
export function paintTranscriptSearchHighlights(
  ranges: Range[],
  activeIndex: number,
): void {
  if (!supportsTranscriptSearchHighlights()) {
    return;
  }

  matchHighlight ??= new Highlight();
  activeMatchHighlight ??= new Highlight();
  activeMatchHighlight.priority = 1;

  // Navigation passes the same ranges array and only moves the active match;
  // skip re-adding up to MAX ranges in that case.
  if (lastPaintedRanges !== ranges) {
    setHighlightRanges(matchHighlight, ranges);
    lastPaintedRanges = ranges;
  }
  const activeRange = activeIndex >= 0 ? ranges[activeIndex] : undefined;
  setHighlightRanges(activeMatchHighlight, activeRange ? [activeRange] : []);

  CSS.highlights.set(TRANSCRIPT_SEARCH_HIGHLIGHT, matchHighlight);
  CSS.highlights.set(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT, activeMatchHighlight);
}

export function clearTranscriptSearchHighlights(): void {
  if (!supportsTranscriptSearchHighlights()) {
    return;
  }

  // Empty the registered highlights in place (see note above) before
  // removing them from the registry.
  if (matchHighlight) {
    matchHighlight.clear();
  }
  if (activeMatchHighlight) {
    activeMatchHighlight.clear();
  }
  lastPaintedRanges = null;
  CSS.highlights.delete(TRANSCRIPT_SEARCH_HIGHLIGHT);
  CSS.highlights.delete(TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT);
}

/** Scrolls the element containing the range's start into view. */
export function scrollTranscriptMatchIntoView(
  range: Range,
  behavior: ScrollBehavior,
): void {
  const { startContainer } = range;
  const element =
    startContainer instanceof Element
      ? startContainer
      : startContainer.parentElement;
  element?.scrollIntoView?.({ block: "center", behavior });
}
