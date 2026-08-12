import { isExternalHref } from "./isExternalHref";

/**
 * Clipboard payload for a DOM selection that contains hyperlinks.
 *
 * A selection copied as bare `Selection.toString()` keeps only the visible link
 * label, so `[docs](https://example.com)` pastes as `docs` and the URL is gone.
 * Rich paste targets (Slack, Google Docs, mail) read `text/html`, and plain
 * targets (editors, address bars, terminals) read `text/plain`, so both flavors
 * have to carry the destination:
 *
 * - `html` keeps real `<a href>` elements, so the paste stays clickable.
 * - `text` appends ` (url)` after a link label, so the URL survives as text.
 *
 * Only external destinations (http, https, mailto, tel) are preserved. Local
 * artifact paths and Berd session deep links are meaningless outside the app —
 * and the session scheme is nonce-prefixed while rendering — so those anchors
 * degrade to their label rather than pasting a URL nothing can resolve.
 */
export interface SelectionClipboardPayload {
  html: string;
  text: string;
}

const EDITABLE_SELECTOR =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * True when the event target sits inside an editable control.
 *
 * Copy inside the composer or a text field is the platform's business, not
 * ours: the user is copying what they typed, and the app should not rewrite it.
 */
export function isEditableSelectionTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element && Boolean(target.closest(EDITABLE_SELECTOR))
  );
}

/**
 * Ancestors re-applied around a partially selected range.
 *
 * `a` is the one that matters for URL retention; the emphasis tags are included
 * so a selection inside bold or code text keeps its formatting in the HTML
 * flavor instead of arriving as unstyled prose.
 *
 * `pre` is here despite being a block element: it is what makes HTML honor the
 * newlines and indentation inside it. Without it a code selection serializes to
 * a bare `<code>` whose whitespace the paste target collapses, flattening a
 * snippet onto one line.
 */
const WRAPPABLE_ANCESTOR_TAGS = new Set([
  "a",
  "b",
  "code",
  "del",
  "em",
  "i",
  "pre",
  "s",
  "strong",
]);

/**
 * Clones a range, restoring the inline ancestors the clone would otherwise drop.
 *
 * `Range.cloneContents()` only returns nodes *inside* the range. When the
 * selection sits within a link — double-clicking the label, or dragging across
 * just the link text — the surrounding `<a>` is an ancestor of the range rather
 * than part of it, so the clone is a bare text node and every trace of the href
 * is gone. That is the actual reason copying a hyperlink lost its URL: the
 * anchor was never in the fragment to be found.
 *
 * Walking up from `commonAncestorContainer` and re-wrapping the inline ancestors
 * puts the anchor back. A range that already spans the whole link needs no
 * wrapping, and in that case the walk stops immediately at the block parent.
 */
function cloneRangeWithInlineAncestors(range: Range): DocumentFragment {
  let fragment = document.createDocumentFragment();
  fragment.append(range.cloneContents());

  const container = range.commonAncestorContainer;
  let ancestor =
    container instanceof Element ? container : container.parentElement;

  while (
    ancestor &&
    WRAPPABLE_ANCESTOR_TAGS.has(ancestor.tagName.toLowerCase())
  ) {
    const wrapper = ancestor.cloneNode(false) as Element;
    wrapper.append(fragment);

    const wrapped = document.createDocumentFragment();
    wrapped.append(wrapper);
    fragment = wrapped;

    ancestor = ancestor.parentElement;
  }

  return fragment;
}

/**
 * Flattens every range of a selection into one fragment.
 *
 * A selection can hold multiple ranges (multi-column drag, Firefox
 * ctrl-select), and the copy flavors have to reflect all of them, so the ranges
 * are cloned in order into a single fragment rather than only reading range 0.
 */
export function cloneSelectionContents(selection: Selection): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < selection.rangeCount; index += 1) {
    fragment.append(cloneRangeWithInlineAncestors(selection.getRangeAt(index)));
  }

  return fragment;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Tags kept verbatim when serializing a selection to `text/html`.
 *
 * The allowlist is deliberately small: it covers the structure Streamdown
 * renders for Markdown, and nothing that carries app chrome. Elements outside
 * it are unwrapped (children kept) so no text is lost, and `script`/`style` are
 * dropped outright.
 */
const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const DROPPED_TAGS = new Set(["script", "style", "template"]);

const VOID_TAGS = new Set(["br", "hr", "img"]);

/**
 * Schemes whose destination is not recoverable from the label and which rich
 * paste targets commonly strip.
 *
 * Google Docs and similar editors accept pasted `http(s)` anchors but drop
 * `mailto:`/`tel:` ones, leaving the label as bare words — the original bug,
 * surviving in exactly the places the anchor does not.
 */
const OPAQUE_SCHEME_PATTERN = /^(mailto|tel):/i;

function isOpaqueSchemeHref(href: string): boolean {
  return OPAQUE_SCHEME_PATTERN.test(href.trim());
}

/**
 * The human-readable destination for a link.
 *
 * `mailto:`/`tel:` hrefs are shown without their scheme: the address itself is
 * the useful part, and `email us (mailto:team@example.com)` reads worse than
 * `email us (team@example.com)` while carrying no extra information.
 */
function displayDestination(href: string): string {
  return href.trim().replace(OPAQUE_SCHEME_PATTERN, "");
}

/**
 * True when a node sits inside code, where link enrichment must not happen.
 *
 * Code is copied to be run, pasted, or compiled, so both flavors have to leave
 * it verbatim: no appended URL in the text, no rewritten anchor in the HTML.
 * Both call sites share this predicate rather than each spelling out a selector,
 * so the two flavors cannot drift into disagreeing about what counts as code.
 */
function isInsideCode(node: Element): boolean {
  return node.closest("pre, code") !== null;
}

function isRenderableImageSrc(src: string | null): src is string {
  if (!src) return false;
  const lower = src.trim().toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

/**
 * Serializes a node to sanitized HTML, keeping only allowlisted tags and the
 * `href`/`src`/`alt` attributes. Classes, inline styles, and `data-*` hooks are
 * stripped so a paste carries content and not Berd's rendering internals.
 */
function htmlFromNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(node.textContent ?? "");
  }

  if (!(node instanceof Element)) {
    return "";
  }

  const tagName = node.tagName.toLowerCase();

  if (DROPPED_TAGS.has(tagName)) {
    return "";
  }

  const children = Array.from(node.childNodes).map(htmlFromNode).join("");

  if (!ALLOWED_TAGS.has(tagName)) {
    return children;
  }

  if (tagName === "a") {
    const href = node.getAttribute("href");
    // A non-external destination cannot resolve outside the app, so keep the
    // label and drop the anchor rather than pasting a dead link.
    if (!isExternalHref(href ?? undefined)) {
      return children;
    }

    // Inside code, leave the text exactly as authored. `collectSelectionLinks`
    // skips these too, so neither flavor rewrites a snippet.
    if (isInsideCode(node)) {
      return children;
    }

    const anchor = `<a href="${escapeHtml(href ?? "")}">${children}</a>`;

    // Rich targets that strip mailto:/tel: anchors would leave the label as
    // bare words, which is the original bug. Spelling the address out beside
    // the anchor means it survives the strip; targets that keep the anchor
    // still get a working link, just with the address shown too.
    if (isOpaqueSchemeHref(href ?? "")) {
      const destination = displayDestination(href ?? "");
      if (!(node.textContent ?? "").includes(destination)) {
        return `${anchor} (${escapeHtml(destination)})`;
      }
    }

    return anchor;
  }

  if (tagName === "img") {
    const src = node.getAttribute("src");
    const alt = node.getAttribute("alt") ?? "";
    if (!isRenderableImageSrc(src)) {
      return escapeHtml(alt);
    }
    return `<img alt="${escapeHtml(alt)}" src="${escapeHtml(src)}" />`;
  }

  if (VOID_TAGS.has(tagName)) {
    return `<${tagName} />`;
  }

  return `<${tagName}>${children}</${tagName}>`;
}

export function selectionFragmentToHtml(fragment: DocumentFragment): string {
  return Array.from(fragment.childNodes).map(htmlFromNode).join("");
}

interface SelectionLink {
  href: string;
  label: string;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * True when a link's visible label already is its destination, so appending the
 * URL would only produce `https://x (https://x)`.
 *
 * Compared after dropping the scheme, a leading `www.`, and any trailing slash,
 * because Markdown renderers commonly show a bare host for a full URL. The
 * comparison is whole-string, not substring: a label like `docs` is a substring
 * of `https://example.com/docs` while carrying none of its information, and
 * treating that as redundant is exactly how the URL goes missing.
 */
function stripHrefForComparison(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "");
}

/**
 * Characters that can continue a URL or address.
 *
 * A destination only counts as "already shown" when it appears in the label as a
 * whole token. If the surrounding character could itself be part of a URL, the
 * match is a fragment of some longer destination rather than the destination
 * itself, and the label is not actually showing it.
 */
const URL_CONTINUATION_CHARACTER = /[A-Za-z0-9._~:/?#@!$&'*+,;=%-]/;

function containsDestinationToken(label: string, destination: string): boolean {
  if (!destination) return false;

  let index = label.indexOf(destination);
  while (index !== -1) {
    const before = label[index - 1];
    const after = label[index + destination.length];
    const boundedStart =
      before === undefined || !URL_CONTINUATION_CHARACTER.test(before);
    const boundedEnd =
      after === undefined || !URL_CONTINUATION_CHARACTER.test(after);

    if (boundedStart && boundedEnd) return true;
    index = label.indexOf(destination, index + 1);
  }

  return false;
}

function isLabelRedundantWithHref(label: string, href: string): boolean {
  const normalizedLabel = normalizeWhitespace(label);
  const strippedLabel = stripHrefForComparison(label);
  const strippedHref = stripHrefForComparison(href);

  if (strippedLabel === strippedHref) return true;

  // A label can also *contain* the destination, e.g. "Note: example.com". Match
  // the full href as well as the stripped form so a label that spells out the
  // scheme ("see https://example.com/docs") is recognized too.
  return (
    containsDestinationToken(normalizedLabel, normalizeWhitespace(href)) ||
    containsDestinationToken(normalizedLabel, strippedHref)
  );
}

/**
 * Collects the external links in a selection, in document order.
 *
 * Anchors inside `pre`/`code` are skipped: that text is copied to be run or
 * compiled, so injecting a URL would corrupt it. Anchors whose label already
 * shows the destination are skipped too.
 */
/**
 * True when an anchor's destination should be spelled out beside its label.
 *
 * Shared by the plain-text annotation walk and `collectSelectionLinks` so there
 * is one definition of an annotatable link.
 */
function isAnnotatableAnchor(anchor: Element): boolean {
  const href = anchor.getAttribute("href");
  if (!isExternalHref(href ?? undefined)) return false;
  if (isInsideCode(anchor)) return false;

  const label = normalizeWhitespace(anchor.textContent ?? "");
  if (!label) return false;

  return !isLabelRedundantWithHref(label, href as string);
}

export function collectSelectionLinks(
  fragment: DocumentFragment,
): SelectionLink[] {
  const links: SelectionLink[] = [];

  for (const anchor of Array.from(fragment.querySelectorAll("a[href]"))) {
    if (!isAnnotatableAnchor(anchor)) continue;

    links.push({
      href: anchor.getAttribute("href") as string,
      label: normalizeWhitespace(anchor.textContent ?? ""),
    });
  }

  return links;
}

/**
 * A run of selection text, tagged with the destination to annotate it with.
 *
 * `href` is null for text that is not part of an annotatable link. Those runs
 * still have to be listed: the annotation walk locates a link by consuming the
 * text before it in order, which is what distinguishes a linked label from
 * identical unlinked prose.
 */
export interface SelectionTextSegment {
  href: string | null;
  text: string;
}

/**
 * Splits a selection into text runs in document order, tagging each with the
 * link it belongs to.
 *
 * Consecutive text nodes under the same anchor are merged so the annotation
 * lands after the whole label, not after its first text node — a label like
 * `<a><strong>bold</strong> link</a>` is one run, not two.
 */
export function collectSelectionTextSegments(
  fragment: DocumentFragment,
): SelectionTextSegment[] {
  const segments: SelectionTextSegment[] = [];
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  let previousAnchor: Element | null = null;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (!text) continue;

    const anchor = node.parentElement?.closest("a[href]") ?? null;
    const annotatable = anchor !== null && isAnnotatableAnchor(anchor);
    const previous = segments.at(-1);

    if (annotatable && anchor === previousAnchor && previous) {
      previous.text += text;
      continue;
    }

    segments.push({
      href: annotatable ? anchor.getAttribute("href") : null,
      text,
    });
    previousAnchor = annotatable ? anchor : null;
  }

  return segments;
}

/**
 * Appends ` (url)` after each link label in the plain-text flavor.
 *
 * The base text is `Selection.toString()`, which carries the browser's own line
 * breaking, so it is kept verbatim and only annotated rather than rebuilt from
 * the DOM. Position comes from the DOM though: the walk consumes *every* run in
 * document order, linked or not, so a label is annotated at its own occurrence.
 * Searching the text for the label instead would annotate the first textual
 * match, which in `docs and <a>docs</a>` is the unlinked word — leaving the
 * copied link without its URL, the very bug this module exists to fix.
 *
 * A run that cannot be located (whitespace collapsed differently, or clipped
 * mid-selection) is skipped without advancing, so later runs still line up.
 */
export function appendLinkUrlsToText(
  text: string,
  segments: readonly SelectionTextSegment[],
): string {
  if (!segments.some((segment) => segment.href)) return text;

  let result = "";
  let cursor = 0;

  for (const segment of segments) {
    const end = findSegmentEnd(text, segment.text, cursor);
    if (end === null) continue;

    result += text.slice(cursor, end);
    cursor = end;

    if (!segment.href) continue;

    const destination = displayDestination(segment.href);
    // Already annotated by the author, e.g. "docs (https://example.com)".
    if (!text.slice(cursor).startsWith(` (${destination})`)) {
      result += ` (${destination})`;
    }
  }

  return result + text.slice(cursor);
}

/**
 * Returns the index just past `segmentText` in `text`, searching from `from`.
 *
 * Tries an exact match first, then tolerates whitespace runs differing between
 * the DOM and the selection text: a label wrapped across lines renders as `\n`
 * in the selection text while the source markup holds a single space.
 */
function findSegmentEnd(
  text: string,
  segmentText: string,
  from: number,
): number | null {
  // Whitespace-only runs carry no position information; skipping them lets the
  // surrounding runs match against whatever the browser produced.
  if (!segmentText.trim()) return null;

  const exact = text.indexOf(segmentText, from);
  if (exact !== -1) return exact + segmentText.length;

  const pattern = segmentText
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const match = new RegExp(pattern).exec(text.slice(from));
  if (!match) return null;

  return from + match.index + match[0].length;
}

/**
 * Builds the `text/html` + `text/plain` payload for a selection.
 *
 * `text` is the browser's selection text with link URLs appended; `html` is the
 * sanitized markup with anchors intact.
 */
export function buildSelectionClipboardPayload(
  fragment: DocumentFragment,
  selectionText: string,
): SelectionClipboardPayload {
  return {
    html: selectionFragmentToHtml(fragment),
    text: appendLinkUrlsToText(
      selectionText,
      collectSelectionTextSegments(fragment),
    ),
  };
}

/**
 * True when a selection contains an external link whose URL plain text would
 * drop. Kept private so every copy path goes through
 * `buildEnrichedSelectionPayload` and shares one definition of "worth taking
 * over the clipboard for".
 */
function selectionHasRecoverableLinks(fragment: DocumentFragment): boolean {
  return collectSelectionLinks(fragment).length > 0;
}

/**
 * Builds a payload only when the selection holds a URL that plain text would
 * drop, and returns `null` when it does not.
 *
 * Every copy path shares this entry point so the "only take over the clipboard
 * when a URL is at risk" policy lives in one place. Reaching for
 * `buildSelectionClipboardPayload` directly is what let the context-menu copy
 * start attaching `text/html` to ordinary prose, turning a plain-text copy into
 * a formatted one — headings and bullets included — for selections that never
 * needed enriching.
 */
export function buildEnrichedSelectionPayload(
  fragment: DocumentFragment,
  selectionText: string,
): SelectionClipboardPayload | null {
  if (!selectionHasRecoverableLinks(fragment)) return null;
  return buildSelectionClipboardPayload(fragment, selectionText);
}

/**
 * Writes both clipboard flavors, falling back to plain text.
 *
 * `navigator.clipboard.write` is the only way to put `text/html` on the
 * clipboard, but it rejects when the webview withholds permission or the
 * document is not focused, and `ClipboardItem` is absent in older webviews. In
 * every one of those cases the URL-bearing plain text is still better than
 * nothing, so failure degrades to `writeText` instead of surfacing an error.
 */
export async function writeSelectionToClipboard(
  payload: SelectionClipboardPayload,
): Promise<void> {
  const { html, text } = payload;
  if (!text && !html) return;

  if (
    html &&
    typeof ClipboardItem === "function" &&
    navigator.clipboard?.write
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch (error) {
      console.error("[selectionClipboard] rich copy failed:", error);
    }
  }

  if (!text || !navigator.clipboard?.writeText) return;
  await navigator.clipboard.writeText(text);
}
