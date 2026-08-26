import { useEffect, useRef, useState } from "react";
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
import { NumberStepper } from "@/shared/ui/number-stepper";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import type { WidgetRenderProps } from "./types";
import { StarterTaskList } from "@/features/home/onboarding/StarterTaskList";
import {
  LABEL_FONT_FAMILIES,
  type LabelFontFamily,
  LABEL_FONT_SIZE_LARGE_STEP_PX,
  LABEL_FONT_SIZE_MAX_PX,
  LABEL_FONT_SIZE_MIN_PX,
  labelFontFamily,
  labelFontFamilyStyle,
  labelFontSizePx,
} from "./labelWidgetModel";
import { useStarterTasks } from "@/features/home/onboarding/StarterTasksContext";
import { STARTER_TASKS_NOTE_ID } from "@/features/home/onboarding/starterTasks";

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
type StickyNoteTone =
  | "neutral"
  | "warm"
  | "cool"
  | "rose"
  | "blue"
  | "lavender"
  | "peach";
type StickyNoteFontSize = "small" | "medium" | "large";

const EDIT_SAVE_DELAY_MS = 400;
const EDITABLE_NOTE_TONES = [
  "neutral",
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

function getNoteId(state: Record<string, unknown> | undefined) {
  return typeof state?.noteId === "string" ? state.noteId : null;
}

function isOnboardingNoteId(noteId: string | null): noteId is OnboardingNoteId {
  return noteId != null && noteId in ONBOARDING_NOTE_CONTENT;
}

function getEditableText(state: Record<string, unknown> | undefined): string {
  return typeof state?.text === "string" ? state.text : "";
}

function getEditableTone(
  state: Record<string, unknown> | undefined,
): StickyNoteTone {
  switch (state?.tone) {
    case "neutral":
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

function getEditableFontSize(
  state: Record<string, unknown> | undefined,
): StickyNoteFontSize {
  switch (state?.fontSize) {
    case "small":
    case "medium":
    case "large":
      return state.fontSize;
    default:
      return "medium";
  }
}

function toneClassName(tone: StickyNoteTone): string {
  switch (tone) {
    case "neutral":
      // Plain card surface — white in light mode, dark in dark mode, matching
      // the automation output cards.
      return "bg-card";
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

function noteTextClassName(isLabel: boolean): string {
  return isLabel ? "text-foreground" : "text-sticky-note-foreground";
}

function noteMutedTextClassName(isLabel: boolean): string {
  return isLabel ? "text-muted-foreground" : "text-sticky-note-muted";
}

function toneLabelKey(tone: StickyNoteTone): string {
  return `widgets.stickyNote.tones.${tone}`;
}

function fontSizeLabelKey(size: StickyNoteFontSize): string {
  return `widgets.stickyNote.fontSizes.${size}`;
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

function fontSizeBodyClassName(size: StickyNoteFontSize): string {
  // Base font size for the note body. Markdown block elements (headings,
  // lists, code) size relative to this with em units, so the whole note
  // scales together.
  switch (size) {
    case "small":
      return "text-[13px] leading-5";
    case "medium":
      return "text-[14px] leading-5";
    case "large":
      return "text-[18px] leading-7";
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

type InlineFormat = "bold" | "italic" | "strikeThrough";

type ToolbarFormatting = Record<InlineFormat, boolean>;

const EMPTY_TOOLBAR_FORMATTING: ToolbarFormatting = {
  bold: false,
  italic: false,
  strikeThrough: false,
};

function appendInlineMarkdown(
  parent: Node,
  text: string,
  ownerDocument: Document,
): void {
  let cursor = 0;
  const appendText = (value: string) => {
    if (value) parent.appendChild(ownerDocument.createTextNode(value));
  };

  while (cursor < text.length) {
    const formats = [
      { marker: "**", tag: "strong" },
      { marker: "~~", tag: "s" },
      { marker: "_", tag: "em" },
      { marker: "*", tag: "em" },
    ] as const;
    const format = formats.find(({ marker }) =>
      text.startsWith(marker, cursor),
    );
    if (format) {
      const end = text.indexOf(format.marker, cursor + format.marker.length);
      if (end !== -1) {
        const element = ownerDocument.createElement(format.tag);
        appendInlineMarkdown(
          element,
          text.slice(cursor + format.marker.length, end),
          ownerDocument,
        );
        parent.appendChild(element);
        cursor = end + format.marker.length;
        continue;
      }
    }

    const nextMarker = formats
      .map(({ marker }) => text.indexOf(marker, cursor + 1))
      .filter((index) => index !== -1)
      .sort((left, right) => left - right)[0];
    const next = nextMarker ?? text.length;
    appendText(text.slice(cursor, next));
    cursor = next;
  }
}

function populateEditorFromMarkdown(
  editor: HTMLElement,
  markdown: string,
): void {
  const fragment = editor.ownerDocument.createDocumentFragment();
  markdown.split("\n").forEach((line, index) => {
    if (index > 0)
      fragment.appendChild(editor.ownerDocument.createElement("br"));
    appendInlineMarkdown(fragment, line, editor.ownerDocument);
  });
  editor.replaceChildren(fragment);
}

function serializeEditorNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node as HTMLElement;
  const children = Array.from(element.childNodes)
    .map(serializeEditorNode)
    .join("");
  switch (element.tagName.toLowerCase()) {
    case "br":
      return "\n";
    case "strong":
    case "b":
      return `**${children}**`;
    case "em":
    case "i":
      return `_${children}_`;
    case "s":
    case "strike":
      return `~~${children}~~`;
    case "div":
    case "p":
      return `${children}\n`;
    default:
      return children;
  }
}

function editorMarkdown(editor: HTMLElement): string {
  return Array.from(editor.childNodes)
    .map(serializeEditorNode)
    .join("")
    .replace(/\n$/, "");
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
  const starterTasks = useStarterTasks();
  const noteId = getNoteId(instance.state);
  const editableText = getEditableText(instance.state);
  const sectionRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const savedSelectionRef = useRef<Range | null>(null);
  const isFocusedRef = useRef(false);
  const [draft, setDraft] = useState(editableText);
  const [labelEditing, setLabelEditing] = useState(false);
  const [toolbarFormatting, setToolbarFormatting] = useState<ToolbarFormatting>(
    EMPTY_TOOLBAR_FORMATTING,
  );
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adopt external state changes (e.g. layout reload) while the user is not
  // actively typing, so we never clobber an in-progress edit.
  useEffect(() => {
    if (!isFocusedRef.current && editorRef.current) {
      setDraft(editableText);
      populateEditorFromMarkdown(editorRef.current, editableText);
    }
  }, [editableText]);

  useEffect(
    () => () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!labelEditing) return;
    editorRef.current?.focus({ preventScroll: true });

    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const interactionStaysInEditor =
        sectionRef.current?.contains(event.target) ||
        event.target.closest('[data-slot="select-content"]');
      if (!interactionStaysInEditor) {
        setLabelEditing(false);
        editorRef.current?.blur();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [labelEditing]);

  const commitText = (value: string) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (value !== editableText) {
      onUpdateState({ text: value });
    }
  };

  const scheduleTextSave = (value: string) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      if (value !== editableText) {
        onUpdateState({ text: value });
      }
    }, EDIT_SAVE_DELAY_MS);
  };

  const saveEditor = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = editorMarkdown(editor);
    setDraft(next);
    scheduleTextSave(next);
  };

  const syncToolbarFormatting = () => {
    setToolbarFormatting({
      bold: document.queryCommandState?.("bold") ?? false,
      italic: document.queryCommandState?.("italic") ?? false,
      strikeThrough: document.queryCommandState?.("strikeThrough") ?? false,
    });
  };

  const saveSelection = () => {
    const selection = window.getSelection();
    const editor = editorRef.current;
    if (
      selection?.rangeCount &&
      editor?.contains(selection.anchorNode) &&
      editor.contains(selection.focusNode)
    ) {
      savedSelectionRef.current = selection.getRangeAt(0).cloneRange();
    }
    syncToolbarFormatting();
  };

  const toggleFormat = (format: InlineFormat) => {
    const selection = window.getSelection();
    const savedRange = savedSelectionRef.current;
    if (!selection || !savedRange) return;

    selection.removeAllRanges();
    selection.addRange(savedRange);
    document.execCommand?.(format, false, undefined);
    editorRef.current?.focus();
    saveEditor();
    saveSelection();
  };

  if (
    noteId === STARTER_TASKS_NOTE_ID &&
    (!starterTasks?.visible || starterTasks.docked)
  ) {
    return null;
  }

  if (noteId === STARTER_TASKS_NOTE_ID && starterTasks) {
    return (
      <StarterTaskList
        mode="canvas"
        completionState={starterTasks.completionState}
        omittedTaskIds={starterTasks.omittedTaskIds}
        selectedTaskId={starterTasks.selectedTaskId}
        labels={{
          title: t("onboarding.starterTasks.title"),
          backHome: t("onboarding.starterTasks.backHome"),
          backToList: t("onboarding.starterTasks.backToList"),
          markDone: t("onboarding.starterTasks.markDone"),
          dismiss: t("onboarding.starterTasks.dismiss"),
          closeTaskDetails: t("onboarding.starterTasks.closeTaskDetails"),
          tasks: {
            "connect-provider": t("onboarding.starterTasks.connectProvider"),
            "start-chat": t("onboarding.starterTasks.startChat"),
            "create-project": t("onboarding.starterTasks.createProject"),
            "add-widget": t("onboarding.starterTasks.addWidget"),
          },
          taskDetails: {
            "connect-provider": t(
              "onboarding.starterTasks.taskDetails.connectProvider",
            ),
            "start-chat": t("onboarding.starterTasks.taskDetails.startChat"),
            "create-project": t(
              "onboarding.starterTasks.taskDetails.createProject",
            ),
            "add-widget": t("onboarding.starterTasks.taskDetails.addWidget"),
          },
          openTask: (label) => t("onboarding.starterTasks.openTask", { label }),
          completedTask: (label) =>
            t("onboarding.starterTasks.completedTask", { label }),
          checkTask: (label) =>
            t("onboarding.starterTasks.checkTask", { label }),
          uncheckTask: (label) =>
            t("onboarding.starterTasks.uncheckTask", { label }),
        }}
        onTaskSelect={starterTasks.onTaskSelect}
        onTaskToggle={starterTasks.onTaskToggle}
        onBackHome={starterTasks.onBackHome}
        onCloseSecondary={starterTasks.onCloseSecondary}
        onDismiss={() => {
          starterTasks.onDismiss();
          onRemoveWidget?.();
        }}
      />
    );
  }

  if (!isOnboardingNoteId(noteId)) {
    const tone = getEditableTone(instance.state);
    const isLabel = instance.type === "label";
    const fontSize = getEditableFontSize(instance.state);
    const labelFontSize = labelFontSizePx(instance.state);
    const labelFamily = labelFontFamily(instance.state);
    const textClassName = noteTextClassName(isLabel);
    const mutedTextClassName = noteMutedTextClassName(isLabel);

    return (
      <section
        ref={sectionRef}
        aria-label={
          isLabel ? t("widgets.label.label") : t("widgets.stickyNote.label")
        }
        className={cn(
          "group relative h-full w-full overflow-visible",
          textClassName,
        )}
      >
        <div
          className={cn(
            "flex h-full w-full flex-col rounded-xs",
            isLabel
              ? "overflow-visible px-4 py-2"
              : "overflow-hidden px-5 py-5 shadow-sticky-note",
            isLabel ? "bg-transparent" : toneClassName(tone),
          )}
        >
          {!isLabel ? (
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
              className={cn(
                "absolute right-2 top-2 z-30",
                mutedTextClassName,
                "hover:text-sticky-note-foreground",
              )}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
          {/* biome-ignore lint/a11y/useSemanticElements: contentEditable provides native selection and direct rich-text formatting. */}
          <div
            ref={editorRef}
            contentEditable={!isLabel || labelEditing}
            suppressContentEditableWarning
            tabIndex={isLabel && !labelEditing ? -1 : 0}
            role="textbox"
            aria-label={t("widgets.stickyNote.editAria")}
            aria-multiline={isLabel ? "false" : "true"}
            data-empty={draft.trim().length === 0}
            data-placeholder={t(
              isLabel
                ? "widgets.label.placeholder"
                : "widgets.stickyNote.placeholder",
            )}
            spellCheck={true}
            draggable={false}
            onPointerDown={(event) => {
              if (!isLabel || labelEditing) event.stopPropagation();
            }}
            onClick={(event) => {
              if (!isLabel || labelEditing) {
                event.stopPropagation();
                saveSelection();
              }
            }}
            onDoubleClick={(event) => {
              if (!isLabel) {
                event.stopPropagation();
                return;
              }
              event.stopPropagation();
              if (labelEditing) {
                saveSelection();
                return;
              }
              const selection = window.getSelection();
              const selectedRange =
                selection?.rangeCount &&
                editorRef.current?.contains(selection.anchorNode) &&
                editorRef.current.contains(selection.focusNode)
                  ? selection.getRangeAt(0).cloneRange()
                  : null;
              setLabelEditing(true);
              requestAnimationFrame(() => {
                editorRef.current?.focus({ preventScroll: true });
                if (selection && selectedRange) {
                  selection.removeAllRanges();
                  selection.addRange(selectedRange);
                  savedSelectionRef.current = selectedRange.cloneRange();
                }
              });
            }}
            onWheel={(event) => event.stopPropagation()}
            onInput={saveEditor}
            onKeyDown={(event) => {
              if (isLabel && event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onKeyUp={saveSelection}
            onMouseUp={saveSelection}
            onFocus={() => {
              isFocusedRef.current = true;
              syncToolbarFormatting();
            }}
            onBlur={() => {
              isFocusedRef.current = false;
              commitText(
                editorRef.current ? editorMarkdown(editorRef.current) : draft,
              );
            }}
            onPaste={(event) => {
              event.preventDefault();
              document.execCommand?.(
                "insertText",
                false,
                isLabel
                  ? event.clipboardData
                      .getData("text/plain")
                      .replace(/[\r\n]+/g, " ")
                  : event.clipboardData.getData("text/plain"),
              );
              saveEditor();
            }}
            style={
              isLabel
                ? {
                    fontSize: labelFontSize,
                    ...labelFontFamilyStyle(labelFamily),
                  }
                : undefined
            }
            className={cn(
              "scrollbar-none overscroll-contain relative min-h-0 flex-1 whitespace-pre-wrap break-words border-0 bg-transparent p-0 font-sans caret-foreground outline-none [box-shadow:none] [outline:0]",
              isLabel
                ? "overflow-visible whitespace-nowrap"
                : "overflow-x-hidden overflow-y-auto pr-6",
              isLabel && !labelEditing
                ? "cursor-grab select-none active:cursor-grabbing"
                : "cursor-text select-text",
              textClassName,
              isLabel
                ? "leading-[1.35] before:text-muted-foreground/75"
                : cn(
                    "before:text-sticky-note-muted/75",
                    fontSizeBodyClassName(fontSize),
                  ),
              "before:pointer-events-none data-[empty=true]:before:content-[attr(data-placeholder)]",
              "focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:[box-shadow:none]",
            )}
          />
        </div>
        <div
          role="toolbar"
          hidden={isLabel && !labelEditing}
          aria-label={t("widgets.stickyNote.toolbar")}
          className={cn(
            "absolute left-1/2 top-0 z-40 flex w-max max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-[calc(100%+0.625rem)] cursor-default items-center gap-0.5 rounded-full border border-border/45 bg-card/45 px-2 py-1 text-foreground shadow-popover backdrop-blur-[2px] transition-opacity duration-150",
            isLabel
              ? labelEditing
                ? "opacity-100"
                : "pointer-events-none opacity-0"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
          onPointerDownCapture={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          {!isLabel ? (
            <>
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
                      className={cn(
                        "size-5 rounded-full",
                        toneClassName(option),
                        option === "neutral" && "border border-border",
                      )}
                    />
                    {option === tone ? (
                      <Check
                        className="absolute size-3 text-foreground"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                ))}
              </div>
              <div
                className="mx-0.5 h-5 w-px bg-border/70"
                aria-hidden="true"
              />
            </>
          ) : null}
          {isLabel ? (
            <div className="flex items-center gap-1">
              <Select
                value={labelFamily}
                onValueChange={(value: LabelFontFamily) => {
                  onUpdateState({ fontFamily: value });
                  requestAnimationFrame(() => {
                    editorRef.current?.focus({ preventScroll: true });
                  });
                }}
              >
                <SelectTrigger
                  size="xs"
                  variant="pill"
                  aria-label={t("widgets.label.fontFamily.label")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" side="top">
                  {LABEL_FONT_FAMILIES.map((family) => (
                    <SelectItem key={family} value={family}>
                      <span style={labelFontFamilyStyle(family)}>
                        {t(`widgets.label.fontFamily.options.${family}`)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <NumberStepper
                value={labelFontSize}
                onValueChange={(value) => onUpdateState({ fontSizePx: value })}
                min={LABEL_FONT_SIZE_MIN_PX}
                max={LABEL_FONT_SIZE_MAX_PX}
                largeStep={LABEL_FONT_SIZE_LARGE_STEP_PX}
                unit={t("widgets.label.fontSize.unit")}
                label={t("widgets.label.fontSize.label")}
                decrementLabel={t("widgets.label.fontSize.decrease")}
                incrementLabel={t("widgets.label.fontSize.increase")}
              />
            </div>
          ) : (
            <div className="flex items-center gap-1">
              {EDITABLE_NOTE_FONT_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-label={t(fontSizeLabelKey(size))}
                  aria-pressed={fontSize === size}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (size !== fontSize) {
                      onUpdateState({ fontSize: size });
                    }
                  }}
                  className={toolbarButtonClassName(fontSize === size)}
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
          )}
          <div className="ml-2 h-5 w-px bg-border/70" aria-hidden="true" />
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("widgets.stickyNote.bold")}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleFormat("bold");
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
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleFormat("italic");
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
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleFormat("strikeThrough");
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
