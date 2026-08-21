import {
  appendLinkUrlsToText,
  collectSelectionTextSegments,
} from "@/shared/lib/selectionClipboard";

const EXCLUDED_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "svg",
  "img",
  "audio",
  "video",
  "[hidden]",
  "[aria-hidden='true']",
  "[data-quote-exclude]",
  ".sr-only",
].join(",");

function intersects(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function rangeSelectsWholeAnchor(range: Range, anchor: Element): boolean {
  if (!intersects(range, anchor)) return false;
  const selectedAnchor = range.cloneRange();
  if (!anchor.contains(range.startContainer))
    selectedAnchor.setStart(anchor, 0);
  if (!anchor.contains(range.endContainer)) {
    selectedAnchor.setEnd(anchor, anchor.childNodes.length);
  }
  return selectedAnchor.toString() === (anchor.textContent ?? "");
}

function clippedFragment(range: Range, element: Element): DocumentFragment {
  const completeLinks = new Set(
    Array.from(element.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .filter(
        (anchor) =>
          intersects(range, anchor) && rangeSelectsWholeAnchor(range, anchor),
      )
      .map(
        (anchor) =>
          `${anchor.getAttribute("href")}\0${anchor.textContent ?? ""}`,
      ),
  );
  const clipped = range.cloneRange();
  if (!element.contains(range.startContainer)) clipped.setStart(element, 0);
  if (!element.contains(range.endContainer)) {
    clipped.setEnd(element, element.childNodes.length);
  }
  let fragment = clipped.cloneContents();

  // cloneContents drops an anchor ancestor when the range boundaries sit
  // inside it. Restore that ancestor only when the whole link was selected;
  // partial-label selections deliberately remain plain text.
  const commonElement =
    clipped.commonAncestorContainer instanceof Element
      ? clipped.commonAncestorContainer
      : clipped.commonAncestorContainer.parentElement;
  const anchor = commonElement?.closest("a[href]");
  if (anchor && rangeSelectsWholeAnchor(clipped, anchor)) {
    const wrapper = anchor.cloneNode(false) as Element;
    wrapper.append(fragment);
    const wrapped = document.createDocumentFragment();
    wrapped.append(wrapper);
    fragment = wrapped;
  }
  for (const clonedAnchor of fragment.querySelectorAll<HTMLAnchorElement>(
    "a[href]",
  )) {
    const key = `${clonedAnchor.getAttribute("href")}\0${clonedAnchor.textContent ?? ""}`;
    if (!completeLinks.has(key))
      clonedAnchor.replaceWith(...clonedAnchor.childNodes);
  }
  return fragment;
}

function semanticText(
  fragment: DocumentFragment,
  options: { preserveWhitespace?: boolean } = {},
): string {
  for (const excluded of fragment.querySelectorAll(EXCLUDED_SELECTOR)) {
    excluded.remove();
  }
  for (const lineBreak of fragment.querySelectorAll("br")) {
    lineBreak.replaceWith("\n");
  }
  let plainText = (fragment.textContent ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "");
  if (!options.preserveWhitespace)
    plainText = plainText.replace(/[ \t]+\n/g, "\n");
  return appendLinkUrlsToText(
    plainText,
    collectSelectionTextSegments(fragment),
  );
}

function selectedText(range: Range, element: Element): string {
  return semanticText(clippedFragment(range, element));
}

function listMarker(item: Element): string {
  const list = item.parentElement;
  if (list?.tagName.toLowerCase() !== "ol") return "• ";
  const valueAttribute = item.getAttribute("value");
  const explicitValue = valueAttribute === null ? null : Number(valueAttribute);
  if (explicitValue !== null && Number.isInteger(explicitValue)) {
    return `${explicitValue}. `;
  }
  const siblings = Array.from(list.children).filter(
    (child) => child.tagName.toLowerCase() === "li",
  );
  const start = Number(list.getAttribute("start") ?? "1");
  return `${(Number.isFinite(start) ? start : 1) + siblings.indexOf(item)}. `;
}

function listDepth(item: Element): number {
  let depth = 0;
  let ancestor = item.parentElement?.closest("li");
  while (ancestor) {
    depth += 1;
    ancestor = ancestor.parentElement?.closest("li") ?? null;
  }
  return depth;
}

function serializeListItem(item: Element, range: Range): string {
  const fragment = clippedFragment(range, item);
  for (const nestedList of fragment.querySelectorAll("ol, ul")) {
    nestedList.remove();
  }
  const text = semanticText(fragment).trim();
  return text
    ? `${"  ".repeat(listDepth(item))}${listMarker(item)}${text}`
    : "";
}

function serializeTable(table: HTMLTableElement, range: Range): string {
  const rows = Array.from(table.rows);
  const touched = rows.flatMap((row, rowIndex) =>
    Array.from(row.cells)
      .map((cell, columnIndex) => ({ cell, columnIndex, rowIndex }))
      .filter(({ cell }) => intersects(range, cell)),
  );
  if (touched.length === 0) return "";

  const firstRow = Math.min(...touched.map(({ rowIndex }) => rowIndex));
  const lastRow = Math.max(...touched.map(({ rowIndex }) => rowIndex));
  const firstColumn = Math.min(
    ...touched.map(({ columnIndex }) => columnIndex),
  );
  const lastColumn = Math.max(...touched.map(({ columnIndex }) => columnIndex));

  return rows
    .slice(firstRow, lastRow + 1)
    .map((row) =>
      Array.from(row.cells)
        .slice(firstColumn, lastColumn + 1)
        .map((cell) =>
          intersects(range, cell) ? selectedText(range, cell).trim() : "",
        )
        .join("\t"),
    )
    .join("\n");
}

const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre";

function isOwnedBlock(element: Element): boolean {
  if (element.closest("table")) return false;
  if (element.tagName.toLowerCase() === "blockquote") {
    return !element.querySelector(BLOCK_SELECTOR);
  }
  if (element.tagName.toLowerCase() === "p" && element.closest("li")) {
    return false;
  }
  return true;
}

function serializeBlock(element: Element, range: Range): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "li") return serializeListItem(element, range);
  const selected =
    tag === "pre"
      ? semanticText(clippedFragment(range, element), {
          preserveWhitespace: true,
        })
      : selectedText(range, element);
  // Code is an exact rendered snapshot: indentation, blank lines, and trailing
  // newline can all be meaningful. Prose still trims structural outer space.
  const text = tag === "pre" ? selected : selected.trim();
  if (!text) return "";
  if (element.closest("blockquote")) {
    return text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  return text;
}

/** Serializes selected visible message content without consulting Markdown source. */
export function serializeMessageResponseSelection(
  surface: HTMLElement,
  range: Range,
): string | null {
  const parts: Array<{ node: Element; text: string }> = [];
  for (const table of surface.querySelectorAll("table")) {
    if (!intersects(range, table)) continue;
    const text = serializeTable(table as HTMLTableElement, range);
    if (text) parts.push({ node: table, text });
  }
  for (const element of surface.querySelectorAll(BLOCK_SELECTOR)) {
    if (!isOwnedBlock(element) || !intersects(range, element)) continue;
    const text = serializeBlock(element, range);
    if (text) parts.push({ node: element, text });
  }
  if (parts.length === 0 && intersects(range, surface)) {
    const fragment = clippedFragment(range, surface);
    for (const excluded of fragment.querySelectorAll(EXCLUDED_SELECTOR)) {
      excluded.remove();
    }
    for (const lineBreak of fragment.querySelectorAll("br")) {
      lineBreak.replaceWith("\n");
    }
    const text = semanticText(fragment).trim();
    return text || null;
  }
  parts.sort((left, right) =>
    left.node.compareDocumentPosition(right.node) &
    Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1,
  );
  const joined = parts.map((part) => part.text).join("\n");
  // Preserve table tabs and code whitespace; prose serializers already trim
  // their own structural boundaries.
  return joined.trim().length > 0 ? joined : null;
}
