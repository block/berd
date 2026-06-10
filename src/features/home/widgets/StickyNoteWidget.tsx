import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import {
  ArrowRight,
  Bold,
  Check,
  Italic,
  Strikethrough,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import type { WidgetRenderProps } from "./types";

const ONBOARDING_NOTE_CONTENT = {
  "onboarding:welcome": {
    tone: "peach",
    titleKey: "widgets.stickyNote.notes.welcome.title",
    bodyKey: "widgets.stickyNote.notes.welcome.body",
  },
  "onboarding:build-agent": {
    tone: "warm",
    titleKey: "widgets.stickyNote.notes.buildAgent.title",
    bodyKey: "widgets.stickyNote.notes.buildAgent.body",
    actionKey: "widgets.stickyNote.notes.buildAgent.action",
    action: "createPersona",
  },
  "onboarding:start-project": {
    tone: "cool",
    titleKey: "widgets.stickyNote.notes.startProject.title",
    bodyKey: "widgets.stickyNote.notes.startProject.body",
    actionKey: "widgets.stickyNote.notes.startProject.action",
    action: "createProject",
  },
  "onboarding:reuse-workflows": {
    tone: "rose",
    titleKey: "widgets.stickyNote.notes.skills.title",
    bodyKey: "widgets.stickyNote.notes.skills.body",
    actionKey: "widgets.stickyNote.notes.skills.action",
    action: "openSkills",
  },
  "onboarding:shape-home": {
    tone: "blue",
    titleKey: "widgets.stickyNote.notes.shapeHome.title",
    bodyKey: "widgets.stickyNote.notes.shapeHome.body",
  },
  "onboarding:manage-automations": {
    tone: "lavender",
    titleKey: "widgets.stickyNote.notes.automations.title",
    bodyKey: "widgets.stickyNote.notes.automations.body",
    actionKey: "widgets.stickyNote.notes.automations.action",
    action: "openAutomations",
  },
} as const;

type OnboardingNoteId = keyof typeof ONBOARDING_NOTE_CONTENT;
type StickyNoteTone = "warm" | "cool" | "rose" | "blue" | "lavender" | "peach";
type StickyNoteFontSize = "small" | "medium" | "large";
type ToolbarFormattingState = {
  fontSize: StickyNoteFontSize | null;
  bold: boolean;
  italic: boolean;
  strikeThrough: boolean;
};

const EDIT_SAVE_DELAY_MS = 400;
const EDITABLE_NOTE_TONES = [
  "peach",
  "warm",
  "cool",
  "rose",
  "blue",
  "lavender",
] as const satisfies StickyNoteTone[];
const EDITABLE_NOTE_FONT_SIZES = [
  "small",
  "medium",
  "large",
] as const satisfies StickyNoteFontSize[];
const DEFAULT_TOOLBAR_FORMATTING_STATE: ToolbarFormattingState = {
  fontSize: null,
  bold: false,
  italic: false,
  strikeThrough: false,
};

function getNoteId(state: Record<string, unknown> | undefined) {
  return typeof state?.noteId === "string" ? state.noteId : null;
}

function isOnboardingNoteId(noteId: string | null): noteId is OnboardingNoteId {
  return noteId != null && noteId in ONBOARDING_NOTE_CONTENT;
}

function getEditableText(state: Record<string, unknown> | undefined): string {
  return typeof state?.text === "string" ? state.text : "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function textToHtml(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

const ALLOWED_EDITABLE_TAGS = new Set([
  "b",
  "br",
  "div",
  "em",
  "font",
  "i",
  "li",
  "ol",
  "p",
  "s",
  "strike",
  "strong",
  "ul",
]);

const ALLOWED_FONT_SIZES = new Set(["1", "2", "3", "4", "5", "6", "7"]);

function sanitizeEditableNode(node: Node): Node {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.textContent ?? "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return document.createDocumentFragment();
  }

  const element = node as HTMLElement;
  const tagName = element.tagName.toLowerCase();
  if (tagName === "script" || tagName === "style") {
    return document.createDocumentFragment();
  }

  const sanitizedChildren = document.createDocumentFragment();
  for (const child of Array.from(element.childNodes)) {
    sanitizedChildren.appendChild(sanitizeEditableNode(child));
  }

  if (!ALLOWED_EDITABLE_TAGS.has(tagName)) {
    return sanitizedChildren;
  }

  const next = document.createElement(tagName);
  if (tagName === "font") {
    const size = element.getAttribute("size");
    if (size && ALLOWED_FONT_SIZES.has(size)) {
      next.setAttribute("size", size);
    }
  }
  next.appendChild(sanitizedChildren);
  return next;
}

function sanitizeEditableHtml(value: string): string {
  const template = document.createElement("template");
  template.innerHTML = value;
  const sanitized = document.createElement("template");
  for (const child of Array.from(template.content.childNodes)) {
    sanitized.content.appendChild(sanitizeEditableNode(child));
  }
  return sanitized.innerHTML;
}

function getEditableHtml(state: Record<string, unknown> | undefined): string {
  return typeof state?.html === "string"
    ? sanitizeEditableHtml(state.html)
    : textToHtml(getEditableText(state));
}

function isEditableContentEmpty(text: string, html: string): boolean {
  return (
    text.trim().length === 0 &&
    html
      .replace(/<br\s*\/?>/gi, "")
      .replace(/&nbsp;/gi, "")
      .replace(/<\/?(div|p|span)[^>]*>/gi, "")
      .trim().length === 0
  );
}

function getEditableTone(
  state: Record<string, unknown> | undefined,
): StickyNoteTone {
  switch (state?.tone) {
    case "warm":
    case "cool":
    case "rose":
    case "blue":
    case "lavender":
    case "peach":
      return state.tone;
    default:
      return "warm";
  }
}

function toneClassName(tone: StickyNoteTone): string {
  switch (tone) {
    case "warm":
      return "bg-sticky-note-warm";
    case "cool":
      return "bg-sticky-note-cool";
    case "rose":
      return "bg-sticky-note-rose";
    case "blue":
      return "bg-sticky-note-blue";
    case "lavender":
      return "bg-sticky-note-lavender";
    case "peach":
      return "bg-sticky-note-peach";
    default: {
      const exhaustive: never = tone;
      return exhaustive;
    }
  }
}

function toneLabelKey(tone: StickyNoteTone): string {
  return `widgets.stickyNote.tones.${tone}`;
}

function fontSizeLabelKey(size: StickyNoteFontSize): string {
  return `widgets.stickyNote.fontSizes.${size}`;
}

function fontSizeCommandValue(size: StickyNoteFontSize): string {
  switch (size) {
    case "small":
      return "1";
    case "medium":
      return "3";
    case "large":
      return "5";
    default: {
      const exhaustive: never = size;
      return exhaustive;
    }
  }
}

function fontSizeFromCommandValue(value: string): StickyNoteFontSize | null {
  switch (value) {
    case "1":
    case "2":
      return "small";
    case "3":
    case "4":
      return "medium";
    case "5":
    case "6":
    case "7":
      return "large";
    default:
      return null;
  }
}

function fontSizeGlyphClassName(size: StickyNoteFontSize): string {
  // Size only. Vertical centering is handled by text-box trimming on the glyph
  // span (see render), so all three sizes stay aligned with no per-size offset.
  switch (size) {
    case "small":
      return "text-[11px]";
    case "medium":
      return "text-[14px]";
    case "large":
      return "text-[17px]";
    default: {
      const exhaustive: never = size;
      return exhaustive;
    }
  }
}

function toolbarButtonClassName(active = false): string {
  return cn(
    "flex size-7 cursor-pointer items-center justify-center rounded-full text-sm font-medium outline-none transition-colors",
    "focus-visible:ring-2 focus-visible:ring-ring",
    // Selected reads as a light, visible disc, not a heavy grey blob; hover
    // applies only when unselected so a selected control never dims on hover.
    active
      ? "bg-foreground/[0.07] text-foreground"
      : "text-foreground/80 hover:bg-foreground/[0.05]",
  );
}

function queryToolbarFormattingState(): ToolbarFormattingState {
  try {
    const rawFontSize =
      typeof document.queryCommandValue === "function"
        ? String(document.queryCommandValue("fontSize"))
        : "";

    return {
      fontSize: fontSizeFromCommandValue(rawFontSize),
      bold:
        typeof document.queryCommandState === "function"
          ? document.queryCommandState("bold")
          : false,
      italic:
        typeof document.queryCommandState === "function"
          ? document.queryCommandState("italic")
          : false,
      strikeThrough:
        typeof document.queryCommandState === "function"
          ? document.queryCommandState("strikeThrough")
          : false,
    };
  } catch {
    return DEFAULT_TOOLBAR_FORMATTING_STATE;
  }
}

function textBeforeCaretInCurrentBlock(editor: HTMLElement, range: Range) {
  const container =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const block = container?.closest("li, div, p");
  const textRange = document.createRange();

  if (block && block !== editor && editor.contains(block)) {
    textRange.setStart(block, 0);
    textRange.setEnd(range.startContainer, range.startOffset);
    return textRange.toString();
  }

  textRange.setStart(editor, 0);
  textRange.setEnd(range.startContainer, range.startOffset);
  return textRange.toString().split("\n").at(-1) ?? "";
}

function dashMarkerRangeAtCaret(range: Range): Range | null {
  if (
    range.startContainer.nodeType !== Node.TEXT_NODE ||
    range.startOffset < 1
  ) {
    return null;
  }

  const textNode = range.startContainer;
  if (textNode.textContent?.charAt(range.startOffset - 1) !== "-") {
    return null;
  }

  const markerRange = range.cloneRange();
  markerRange.setStart(textNode, range.startOffset - 1);
  markerRange.setEnd(textNode, range.startOffset);
  return markerRange;
}

export function StickyNoteWidget({
  instance,
  onUpdateState,
  onCreatePersona,
  onCreateProject,
  onOpenSkills,
  onOpenAutomations,
  onRemoveWidget,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const noteId = getNoteId(instance.state);
  const editableText = getEditableText(instance.state);
  const editableHtml = getEditableHtml(instance.state);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<Range | null>(null);
  const [isEditorEmpty, setIsEditorEmpty] = useState(
    isEditableContentEmpty(getEditableText(instance.state), editableHtml),
  );
  const [toolbarFormatting, setToolbarFormatting] = useState(
    DEFAULT_TOOLBAR_FORMATTING_STATE,
  );
  const pendingTextRef = useRef(editableText);
  const pendingHtmlRef = useRef(editableHtml);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    pendingHtmlRef.current = editableHtml;
    pendingTextRef.current = editableText;
    const editor = editorRef.current;
    if (editor && document.activeElement !== editor) {
      editor.innerHTML = editableHtml;
      setIsEditorEmpty(
        isEditableContentEmpty(editor.textContent ?? "", editor.innerHTML),
      );
    }
  }, [editableHtml, editableText]);

  useEffect(
    () => () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    },
    [],
  );

  const flushEditableText = () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (pendingHtmlRef.current !== editableHtml) {
      onUpdateState({
        html: pendingHtmlRef.current,
        text: pendingTextRef.current,
      });
    }
  };

  const readEditorState = () => {
    const editor = editorRef.current;
    if (!editor) {
      return { html: pendingHtmlRef.current, text: pendingTextRef.current };
    }

    return {
      html: sanitizeEditableHtml(editor.innerHTML),
      text: editor.innerText ?? editor.textContent ?? "",
    };
  };

  const scheduleEditableTextSave = () => {
    const next = readEditorState();
    pendingHtmlRef.current = next.html;
    pendingTextRef.current = next.text;
    setIsEditorEmpty(isEditableContentEmpty(next.text, next.html));
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      if (pendingHtmlRef.current !== editableHtml) {
        onUpdateState({
          html: pendingHtmlRef.current,
          text: pendingTextRef.current,
        });
      }
    }, EDIT_SAVE_DELAY_MS);
  };

  const saveSelection = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      editor.contains(range.commonAncestorContainer) ||
      editor === range.commonAncestorContainer
    ) {
      selectionRef.current = range.cloneRange();
    }
  };

  const restoreSelection = () => {
    const editor = editorRef.current;
    const range = selectionRef.current;
    const selection = window.getSelection();
    if (!editor || !range || !selection) {
      editor?.focus();
      return;
    }
    editor.focus();
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const preserveSelectionAfterCommand = (range: Range | null) => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || !range || range.collapsed) {
      saveSelection();
      return;
    }

    try {
      editor.focus();
      selection.removeAllRanges();
      selection.addRange(range);
      selectionRef.current = range.cloneRange();
    } catch {
      saveSelection();
    }
  };

  const applyRichTextCommand = (command: string, value?: string) => {
    const commandRange = selectionRef.current?.cloneRange() ?? null;
    restoreSelection();
    document.execCommand?.(command, false, value);
    scheduleEditableTextSave();
    preserveSelectionAfterCommand(commandRange);
    setToolbarFormatting(queryToolbarFormattingState());
  };

  const applyMarkdownBulletShortcut = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return false;
    }

    const range = selection.getRangeAt(0);
    if (!range.collapsed || !editor.contains(range.commonAncestorContainer)) {
      return false;
    }

    if (textBeforeCaretInCurrentBlock(editor, range).trim() !== "-") {
      return false;
    }

    const markerRange = dashMarkerRangeAtCaret(range);
    if (!markerRange) {
      return false;
    }

    selection.removeAllRanges();
    selection.addRange(markerRange);
    document.execCommand?.("delete", false, undefined);
    const didApply = document.execCommand?.(
      "insertUnorderedList",
      false,
      undefined,
    );
    if (!didApply) {
      document.execCommand?.("insertHTML", false, "<ul><li><br></li></ul>");
    }
    scheduleEditableTextSave();
    saveSelection();
    setToolbarFormatting(queryToolbarFormattingState());
    return true;
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && isEditorEmpty) {
      event.preventDefault();
      return;
    }

    if (event.key === " " && applyMarkdownBulletShortcut()) {
      event.preventDefault();
    }
  };

  const syncToolbarFormatting = () => {
    setToolbarFormatting(queryToolbarFormattingState());
  };

  const handleEditorPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    document.execCommand?.(
      "insertText",
      false,
      event.clipboardData.getData("text/plain"),
    );
    scheduleEditableTextSave();
    syncToolbarFormatting();
  };

  if (!isOnboardingNoteId(noteId)) {
    const tone = getEditableTone(instance.state);

    return (
      <section
        aria-label={t("widgets.stickyNote.label")}
        className="group relative h-full w-full overflow-visible text-sticky-note-foreground"
      >
        <div
          className={cn(
            "flex h-full w-full flex-col overflow-hidden rounded-xs px-5 py-5 shadow-sticky-note",
            toneClassName(tone),
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("widgets.stickyNote.dismiss")}
            onPointerDownCapture={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRemoveWidget?.();
            }}
            className="absolute right-2 top-2 z-30 text-sticky-note-muted hover:text-sticky-note-foreground"
          >
            <X aria-hidden="true" />
          </Button>
          {/* biome-ignore lint/a11y/useSemanticElements: contentEditable is needed so toolbar actions can format selected note text. */}
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            tabIndex={0}
            role="textbox"
            aria-label={t("widgets.stickyNote.editAria")}
            aria-multiline="true"
            data-empty={isEditorEmpty}
            data-placeholder={t("widgets.stickyNote.placeholder")}
            spellCheck={true}
            draggable={false}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onPaste={handleEditorPaste}
            onInput={() => {
              scheduleEditableTextSave();
              syncToolbarFormatting();
            }}
            onKeyDown={handleEditorKeyDown}
            onKeyUp={() => {
              saveSelection();
              syncToolbarFormatting();
            }}
            onMouseUp={() => {
              saveSelection();
              syncToolbarFormatting();
            }}
            onFocus={syncToolbarFormatting}
            onBlur={flushEditableText}
            className={cn(
              "scrollbar-subtle overscroll-contain relative min-h-0 flex-1 cursor-text overflow-y-scroll border-0 bg-transparent p-0 pr-6 text-[15px] leading-5 text-sticky-note-foreground caret-foreground outline-none select-text [box-shadow:none] [outline:0] [scrollbar-gutter:stable]",
              "before:pointer-events-none before:text-sticky-note-muted/75 data-[empty=true]:before:content-[attr(data-placeholder)]",
              "focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:[box-shadow:none]",
              "[&_li]:pl-1 [&_ol]:my-0 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-0 [&_ul]:list-disc [&_ul]:pl-5",
            )}
          />
        </div>
        <div
          role="toolbar"
          aria-label={t("widgets.stickyNote.toolbar")}
          className={cn(
            "absolute left-1/2 top-0 z-40 flex w-max max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-[calc(100%+0.625rem)] cursor-default items-center gap-0.5 rounded-full border border-border/45 bg-card/45 px-2 py-1 text-foreground opacity-0 shadow-popover backdrop-blur-[2px] transition-opacity duration-150",
            "group-hover:opacity-100 group-focus-within:opacity-100",
          )}
          onPointerDownCapture={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-1">
            {EDITABLE_NOTE_TONES.map((option) => (
              <button
                key={option}
                type="button"
                aria-label={t(toneLabelKey(option))}
                aria-pressed={option === tone}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (option !== tone) {
                    onUpdateState({ tone: option });
                  }
                }}
                className={cn(
                  "relative flex size-7 cursor-pointer items-center justify-center rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn("size-5 rounded-full", toneClassName(option))}
                />
                {option === tone ? (
                  <Check
                    className="absolute size-3 text-sticky-note-foreground"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            ))}
          </div>
          <div className="mx-0.5 h-5 w-px bg-border/70" aria-hidden="true" />
          <div className="flex items-center gap-1">
            {EDITABLE_NOTE_FONT_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                aria-label={t(fontSizeLabelKey(size))}
                aria-pressed={toolbarFormatting.fontSize === size}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  applyRichTextCommand("fontSize", fontSizeCommandValue(size));
                }}
                className={toolbarButtonClassName(
                  toolbarFormatting.fontSize === size,
                )}
              >
                <span
                  aria-hidden="true"
                  // text-box trims the glyph's box to its cap-height/baseline
                  // using the font's own metrics, so the button's flex centering
                  // lands the "A" dead-center at every size with no magic offset.
                  className={cn(
                    "inline-block font-semibold leading-none [text-box:trim-both_cap_alphabetic]",
                    fontSizeGlyphClassName(size),
                  )}
                >
                  A
                </span>
              </button>
            ))}
          </div>
          <div className="mx-0.5 h-5 w-px bg-border/70" aria-hidden="true" />
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("widgets.stickyNote.bold")}
              aria-pressed={toolbarFormatting.bold}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                applyRichTextCommand("bold");
              }}
              className={toolbarButtonClassName(toolbarFormatting.bold)}
            >
              <Bold aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("widgets.stickyNote.italic")}
              aria-pressed={toolbarFormatting.italic}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                applyRichTextCommand("italic");
              }}
              className={toolbarButtonClassName(toolbarFormatting.italic)}
            >
              <Italic aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("widgets.stickyNote.strikethrough")}
              aria-pressed={toolbarFormatting.strikeThrough}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                applyRichTextCommand("strikeThrough");
              }}
              className={toolbarButtonClassName(
                toolbarFormatting.strikeThrough,
              )}
            >
              <Strikethrough aria-hidden="true" />
            </Button>
          </div>
        </div>
      </section>
    );
  }

  const note = isOnboardingNoteId(noteId)
    ? ONBOARDING_NOTE_CONTENT[noteId]
    : ONBOARDING_NOTE_CONTENT["onboarding:build-agent"];
  const onAction =
    "action" in note
      ? note.action === "createPersona"
        ? onCreatePersona
        : note.action === "createProject"
          ? onCreateProject
          : note.action === "openSkills"
            ? onOpenSkills
            : onOpenAutomations
      : null;
  const actionLabel = "actionKey" in note ? t(note.actionKey) : null;

  return (
    <section
      aria-label={t("widgets.stickyNote.label")}
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden rounded-xs px-4 pb-4 pt-5 text-sticky-note-foreground shadow-sticky-note",
        note.tone === "warm"
          ? "bg-sticky-note-warm"
          : note.tone === "cool"
            ? "bg-sticky-note-cool"
            : note.tone === "rose"
              ? "bg-sticky-note-rose"
              : note.tone === "blue"
                ? "bg-sticky-note-blue"
                : note.tone === "lavender"
                  ? "bg-sticky-note-lavender"
                  : "bg-sticky-note-peach",
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("widgets.stickyNote.dismiss")}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRemoveWidget?.();
        }}
        className="absolute top-2 right-2 z-20 text-sticky-note-muted hover:text-sticky-note-foreground"
      >
        <X aria-hidden="true" />
      </Button>
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <p className="pr-6 text-[15px] font-medium leading-5">
          {t(note.titleKey)}
        </p>
        <p className="mt-1.5 text-xs leading-4 text-sticky-note-muted">
          {t(note.bodyKey)}
        </p>
        {onAction && actionLabel ? (
          <Button
            type="button"
            size="xs"
            onClick={onAction}
            className="mt-auto h-7 self-start px-3"
            rightIcon={<ArrowRight aria-hidden="true" />}
          >
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
