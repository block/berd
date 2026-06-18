import { useRef, useEffect } from "react";
import { cn } from "@/shared/lib/cn";
import { INCLUDE_RE } from "../lib/includePattern";

interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

const INCLUDE_LINE_CLASS_NAME =
  "bg-info/10 text-info rounded px-1.5 py-0.5 font-mono text-xs";

function createLineNode(line: string): HTMLDivElement {
  const div = document.createElement("div");

  // We visually highlight include lines anywhere in the editor, even though
  // only the leading include block is treated as working directory metadata.
  if (INCLUDE_RE.test(line)) {
    const span = document.createElement("span");
    span.className = INCLUDE_LINE_CLASS_NAME;
    span.textContent = line;
    div.append(span);
    return div;
  }

  // Use <br> inside empty divs so the line is still editable.
  if (line === "") {
    div.append(document.createElement("br"));
  } else {
    div.textContent = line;
  }

  return div;
}

function createLineNodes(text: string): HTMLDivElement[] {
  return text === "" ? [] : text.split("\n").map(createLineNode);
}

function renderLinesInto(el: HTMLElement, text: string) {
  el.replaceChildren(...createLineNodes(text));
}

// Check whether an already-rendered line matches what createLineNode would
// produce, by inspecting the live node instead of allocating one to compare.
function lineMatches(node: ChildNode | null, line: string): boolean {
  if (!(node instanceof HTMLDivElement)) return false;

  if (INCLUDE_RE.test(line)) {
    const span = node.firstChild;
    return (
      node.childNodes.length === 1 &&
      span instanceof HTMLSpanElement &&
      span.className === INCLUDE_LINE_CLASS_NAME &&
      span.textContent === line
    );
  }

  if (line === "") {
    return (
      node.childNodes.length === 1 && node.firstChild instanceof HTMLBRElement
    );
  }

  return node.childElementCount === 0 && node.textContent === line;
}

function renderedLinesMatch(el: HTMLElement, text: string): boolean {
  const lines = text === "" ? [] : text.split("\n");
  if (el.childNodes.length !== lines.length) return false;

  return lines.every((line, index) =>
    lineMatches(el.childNodes.item(index), line),
  );
}

/** Return the caret position as {line, col} relative to the div-per-line structure. */
function getCaretPosition(el: HTMLElement): { line: number; col: number } {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { line: 0, col: 0 };

  const range = sel.getRangeAt(0);
  const node: Node | null = range.startContainer;
  const offset = range.startOffset;

  // If the selection is directly on the contentEditable root, translate
  // the child-index offset into a line number with col 0.
  if (node === el) {
    return { line: Math.min(offset, el.childNodes.length - 1), col: 0 };
  }

  // Walk up to find which direct-child div this node lives in.
  let lineDiv: Node | null = node;
  while (lineDiv && lineDiv.parentNode !== el) {
    lineDiv = lineDiv.parentNode;
  }
  if (!lineDiv) return { line: 0, col: 0 };

  const divs = Array.from(el.childNodes);
  const line = divs.indexOf(lineDiv as ChildNode);

  // Measure the visible text from the start of the line up to the caret.
  // This works for both text-node and element-node selection containers.
  const lineRange = document.createRange();
  lineRange.selectNodeContents(lineDiv);
  lineRange.setEnd(node, offset);
  const col = lineRange.toString().length;

  return { line: Math.max(line, 0), col };
}

/** Restore the caret to a given {line, col} inside the element's div children. */
function setCaretPosition(el: HTMLElement, pos: { line: number; col: number }) {
  const sel = window.getSelection();
  if (!sel) return;

  const divs = el.childNodes;
  if (divs.length === 0) return;

  const lineIdx = Math.min(pos.line, divs.length - 1);
  const lineDiv = divs[lineIdx];

  // Find the text node and offset within this line div.
  const walker = document.createTreeWalker(lineDiv, NodeFilter.SHOW_TEXT);
  let remaining = pos.col;
  let textNode: Text | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: walker iteration
  while ((textNode = walker.nextNode() as Text | null)) {
    if (remaining <= textNode.length) {
      const range = document.createRange();
      range.setStart(textNode, remaining);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= textNode.length;
  }

  // No text nodes (empty line with <br>): place caret at start of the div
  const range = document.createRange();
  range.setStart(lineDiv, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function PromptEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: PromptEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastPushedValue = useRef<string | null>(null);
  const isComposing = useRef(false);

  // Sync rendered lines when value changes externally (including initial mount).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value !== lastPushedValue.current) {
      lastPushedValue.current = value;
      renderLinesInto(el, value);
    }
  }, [value]);

  const syncFromDom = (skipRerender: boolean) => {
    const el = ref.current;
    if (!el) return;

    const text = el.innerText;
    const normalized = text.replace(/\n$/, "");
    lastPushedValue.current = normalized;

    if (!skipRerender && !renderedLinesMatch(el, normalized)) {
      const caret = getCaretPosition(el);
      renderLinesInto(el, normalized);
      setCaretPosition(el, caret);
    }

    onChange(normalized);
  };

  const handleInput = () => {
    syncFromDom(isComposing.current);
  };

  const handleCompositionStart = () => {
    isComposing.current = true;
  };

  const handleCompositionEnd = () => {
    isComposing.current = false;
    syncFromDom(false);
  };

  const insertTextAtSelection = (text: string) => {
    const el = ref.current;
    if (!el) return;

    const selection = window.getSelection();
    if (!selection) {
      el.focus();
      return;
    }

    if (selection.rangeCount === 0) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();

    const textNode = document.createTextNode(text);
    range.insertNode(textNode);

    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    insertTextAtSelection(text);
    syncFromDom(isComposing.current);
  };

  const showPlaceholder = value === "";

  return (
    // biome-ignore lint/a11y/useSemanticElements: contentEditable div needed for rich capsule rendering
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onInput={handleInput}
      onPaste={handlePaste}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      role="textbox"
      tabIndex={0}
      aria-multiline="true"
      aria-label={ariaLabel ?? placeholder}
      data-placeholder={placeholder}
      className={cn(
        "w-full overflow-y-auto resize-y rounded-sm border border-input bg-background px-3 py-2 text-xs font-mono leading-relaxed",
        "focus:outline-none focus:ring-1 focus:ring-ring transition-colors",
        "whitespace-pre-wrap min-h-[120px]",
        showPlaceholder &&
          "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground",
      )}
    />
  );
}
