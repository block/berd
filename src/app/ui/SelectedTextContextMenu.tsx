import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CopyIcon, FileCode2Icon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

const EDITABLE_SELECTOR =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

interface SelectionSnapshot {
  markdown: string;
  ranges: Range[];
  text: string;
}

interface MenuState {
  selection: SelectionSnapshot;
  x: number;
  y: number;
}

function elementFromNode(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element && Boolean(target.closest(EDITABLE_SELECTOR))
  );
}

export function selectionIntersectsNode(
  selection: Selection,
  node: Node | null,
): boolean {
  if (!node) return false;

  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(node)) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

function cloneSelectionContents(selection: Selection): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < selection.rangeCount; index += 1) {
    fragment.append(selection.getRangeAt(index).cloneContents());
  }

  return fragment;
}

function cloneSelectionRanges(selection: Selection): Range[] {
  const ranges: Range[] = [];

  for (let index = 0; index < selection.rangeCount; index += 1) {
    ranges.push(selection.getRangeAt(index).cloneRange());
  }

  return ranges;
}

export function restoreSelection(ranges: Range[]) {
  const selection = window.getSelection();
  if (!selection || ranges.length === 0) return;

  selection.removeAllRanges();
  for (const range of ranges) {
    selection.addRange(range);
  }
}

function keepSelectionVisible(ranges: Range[]) {
  restoreSelection(ranges);

  const frame = window.requestAnimationFrame(() => {
    restoreSelection(ranges);
  });
  const timeout = window.setTimeout(() => {
    restoreSelection(ranges);
  }, 0);

  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timeout);
  };
}

function getRangeRect(range: Range): DOMRect | DOMRectReadOnly | null {
  const rect = range.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) return rect;

  return (
    Array.from(range.getClientRects()).find(
      (clientRect) => clientRect.width > 0 || clientRect.height > 0,
    ) ?? null
  );
}

export function getSelectionMenuPosition(
  event: MouseEvent,
  selection: Selection,
  target: Node | null,
): Pick<MenuState, "x" | "y"> {
  if (event.clientX !== 0 || event.clientY !== 0) {
    return {
      x: event.clientX,
      y: event.clientY,
    };
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const rect = getRangeRect(selection.getRangeAt(index));
    if (rect) {
      return {
        x: rect.left,
        y: rect.bottom,
      };
    }
  }

  const targetRect = elementFromNode(target)?.getBoundingClientRect();
  return {
    x: targetRect?.left ?? 0,
    y: targetRect?.bottom ?? 0,
  };
}

function cleanMarkdown(markdown: string): string {
  return markdown
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function block(markdown: string): string {
  const trimmed = markdown.trim();
  return trimmed ? `\n\n${trimmed}\n\n` : "";
}

function inlineCode(text: string): string {
  const longestBacktickRun =
    text
      .match(/`+/g)
      ?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
  const delimiter = "`".repeat(longestBacktickRun + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";

  return `${delimiter}${padding}${text}${padding}${delimiter}`;
}

function fencedCode(text: string, language?: string | null): string {
  const normalizedLanguage = language === "text" ? "" : (language ?? "");
  return `\`\`\`${normalizedLanguage}\n${text.replace(/\n$/, "")}\n\`\`\``;
}

function markdownChildren(element: Element): string {
  return Array.from(element.childNodes).map(markdownFromNode).join("");
}

function markdownList(element: Element, ordered: boolean): string {
  let itemNumber = 1;
  const items = Array.from(element.children)
    .filter((child) => child.tagName.toLowerCase() === "li")
    .map((item) => {
      const prefix = ordered ? `${itemNumber}. ` : "- ";
      itemNumber += 1;
      return `${prefix}${markdownChildren(item).trim().replace(/\n/g, "\n  ")}`;
    })
    .filter((item) => item.trim().length > 0);

  return block(items.join("\n"));
}

function markdownBlockquote(element: Element): string {
  const quoted = markdownChildren(element)
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return block(quoted);
}

function markdownTable(element: Element): string {
  const rows = Array.from(element.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.children)
        .map((cell) =>
          escapeMarkdownTableCell(cleanMarkdown(markdownChildren(cell))),
        )
        .join(" | "),
    )
    .filter((row) => row.length > 0);

  if (rows.length === 0) return "";
  if (rows.length === 1) return block(rows[0]);

  const columnCount = rows[0].split(" | ").length;
  const separator = Array.from({ length: columnCount }, () => "---").join(
    " | ",
  );

  return block([rows[0], separator, ...rows.slice(1)].join("\n"));
}

function escapeMarkdownTableCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function markdownFromNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }

  if (!(node instanceof Element)) {
    return "";
  }

  const tagName = node.tagName.toLowerCase();
  const children = () => markdownChildren(node);

  switch (tagName) {
    case "a": {
      const label = cleanMarkdown(children());
      const href = node.getAttribute("href");
      if (!label || !href) return label;
      return `[${label}](${href})`;
    }
    case "b":
    case "strong": {
      const value = cleanMarkdown(children());
      return value ? `**${value}**` : "";
    }
    case "br":
      return "\n";
    case "blockquote":
      return markdownBlockquote(node);
    case "code": {
      if (node.closest("pre")) return node.textContent ?? "";
      const value = cleanMarkdown(children());
      return value ? inlineCode(value) : "";
    }
    case "div":
    case "section":
    case "article":
    case "main":
    case "aside":
    case "header":
    case "footer":
    case "p":
      return block(children());
    case "em":
    case "i": {
      const value = cleanMarkdown(children());
      return value ? `_${value}_` : "";
    }
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(tagName.slice(1));
      return block(`${"#".repeat(level)} ${cleanMarkdown(children())}`);
    }
    case "hr":
      return block("---");
    case "img": {
      const alt = node.getAttribute("alt") ?? "";
      const src = node.getAttribute("src");
      return src ? `![${alt}](${src})` : alt;
    }
    case "li":
      return children();
    case "ol":
      return markdownList(node, true);
    case "pre": {
      const code = node.textContent ?? "";
      const language = node
        .closest("[data-language]")
        ?.getAttribute("data-language");
      return block(fencedCode(code, language));
    }
    case "s":
    case "del": {
      const value = cleanMarkdown(children());
      return value ? `~~${value}~~` : "";
    }
    case "table":
      return markdownTable(node);
    case "ul":
      return markdownList(node, false);
    default:
      return children();
  }
}

export function htmlFragmentToMarkdown(
  fragment: DocumentFragment,
  fallbackText: string,
): string {
  const markdown = Array.from(fragment.childNodes)
    .map(markdownFromNode)
    .join("");
  return cleanMarkdown(markdown) || fallbackText.trim();
}

function getCodeBlockSelectionMarkdown(
  selection: Selection,
): string | undefined {
  if (
    !selection.anchorNode ||
    !selection.focusNode ||
    selection.rangeCount !== 1
  ) {
    return undefined;
  }

  const anchorCodeBlock = elementFromNode(selection.anchorNode)?.closest(
    "[data-language]",
  );
  const focusElement = elementFromNode(selection.focusNode);

  if (
    !anchorCodeBlock ||
    !focusElement ||
    !anchorCodeBlock.contains(focusElement)
  ) {
    return undefined;
  }

  const pre = anchorCodeBlock.querySelector("pre");
  if (
    !pre?.contains(elementFromNode(selection.anchorNode)) ||
    !pre.contains(focusElement)
  ) {
    return undefined;
  }

  return fencedCode(
    selection.toString(),
    anchorCodeBlock.getAttribute("data-language"),
  );
}

function getSelectionSnapshot(selection: Selection): SelectionSnapshot | null {
  const text = selection.toString();
  if (!text.trim()) return null;

  const markdown =
    getCodeBlockSelectionMarkdown(selection) ??
    htmlFragmentToMarkdown(cloneSelectionContents(selection), text);

  return {
    markdown,
    ranges: cloneSelectionRanges(selection),
    text,
  };
}

async function copyToClipboard(value: string) {
  if (!value || !navigator.clipboard?.writeText) return;
  await navigator.clipboard.writeText(value);
}

export function SelectedTextContextMenu() {
  const { t } = useTranslation(["chat", "common"]);
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;

      const selection = window.getSelection();
      const target = event.target instanceof Node ? event.target : null;
      const snapshot =
        selection && selectionIntersectsNode(selection, target)
          ? getSelectionSnapshot(selection)
          : null;

      if (selection && snapshot) {
        const position = getSelectionMenuPosition(event, selection, target);
        event.preventDefault();
        setMenu({
          selection: snapshot,
          x: position.x,
          y: position.y,
        });
        return;
      }

      if (import.meta.env.PROD) {
        event.preventDefault();
      }
    };

    window.addEventListener("contextmenu", handleContextMenu);

    return () => {
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) setMenu(null);
  }, []);

  const restoreMenuSelection = useCallback(() => {
    if (!menu) return;
    keepSelectionVisible(menu.selection.ranges);
  }, [menu]);

  useEffect(() => {
    if (!menu) return;

    return keepSelectionVisible(menu.selection.ranges);
  }, [menu]);

  return (
    <DropdownMenu open={menu !== null} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden="true"
          className="pointer-events-none fixed z-50 size-px opacity-0"
          style={{
            left: menu?.x ?? 0,
            top: menu?.y ?? 0,
          }}
          tabIndex={-1}
          type="button"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-44"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onFocusCapture={restoreMenuSelection}
        onPointerDownCapture={restoreMenuSelection}
        onPointerEnter={restoreMenuSelection}
        onPointerMove={restoreMenuSelection}
        side="right"
        sideOffset={2}
      >
        <DropdownMenuItem
          onSelect={() => {
            restoreMenuSelection();
            void copyToClipboard(menu?.selection.text ?? "");
          }}
        >
          <CopyIcon aria-hidden="true" />
          {t("common:actions.copy")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            restoreMenuSelection();
            void copyToClipboard(menu?.selection.markdown ?? "");
          }}
        >
          <FileCode2Icon aria-hidden="true" />
          {t("selectedText.actions.copyAsMarkdown")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
