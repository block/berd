import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Bold,
  Check,
  Eye,
  Italic,
  Pencil,
  Strikethrough,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import type { WidgetRenderProps } from "./types";
import { StarterTaskList } from "@/features/home/onboarding/StarterTaskList";
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
type NoteEditorMode = "edit" | "preview";

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
      return "text-[15px] leading-6";
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

// Links are rendered as inert styled text — a note lives on the canvas and
// should not navigate the webview when previewed.
const noteMarkdownComponents = {
  a: ({ children }) => (
    <span className="font-medium underline decoration-current/40">
      {children}
    </span>
  ),
} satisfies Components;

const NOTE_MARKDOWN_PROSE = cn(
  "[&_p]:my-1.5 first:[&_p]:mt-0",
  "[&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-[1.45em] [&_h1]:font-semibold [&_h1]:leading-tight",
  "[&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-[1.2em] [&_h2]:font-semibold [&_h2]:leading-tight",
  "[&_h3]:mb-0.5 [&_h3]:mt-2 [&_h3]:text-[1.05em] [&_h3]:font-semibold",
  "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5 [&_li>ul]:my-0 [&_li>ol]:my-0",
  "[&_code]:rounded [&_code]:bg-foreground/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]",
  "[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-foreground/10 [&_pre]:p-2 [&_pre>code]:bg-transparent [&_pre>code]:p-0",
  "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-current/30 [&_blockquote]:pl-3 [&_blockquote]:text-sticky-note-muted",
  "[&_hr]:my-2 [&_hr]:border-current/20",
  "[&_a]:decoration-current/40",
  "[&_table]:my-1.5 [&_table]:w-full [&_th]:border [&_th]:border-current/20 [&_th]:px-1.5 [&_th]:py-0.5 [&_th]:text-left [&_td]:border [&_td]:border-current/20 [&_td]:px-1.5 [&_td]:py-0.5",
);

// Decorate one line of markdown for the edit overlay. Markers are
// always kept; only weight/style/decoration change, which preserves the
// monospace advance width so the transparent textarea's caret stays aligned.
function decorateInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let i = 0;
  const appendText = (value: string) => {
    const previous = nodes.at(-1);
    if (typeof previous === "string") {
      nodes[nodes.length - 1] = previous + value;
    } else {
      nodes.push(value);
    }
  };

  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        nodes.push(
          <span key={`${keyPrefix}-${i}`} className="font-bold">
            **{text.slice(i + 2, end)}**
          </span>,
        );
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith("~~", i)) {
      const end = text.indexOf("~~", i + 2);
      if (end !== -1) {
        nodes.push(
          <span key={`${keyPrefix}-${i}`} className="line-through">
            ~~{text.slice(i + 2, end)}~~
          </span>,
        );
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1) {
        nodes.push(
          <span key={`${keyPrefix}-${i}`} className="italic">
            *{text.slice(i + 1, end)}*
          </span>,
        );
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "~") {
      const end = text.indexOf("~", i + 1);
      if (end !== -1) {
        nodes.push(
          <span key={`${keyPrefix}-${i}`} className="line-through">
            ~{text.slice(i + 1, end)}~
          </span>,
        );
        i = end + 1;
        continue;
      }
    }
    appendText(text[i]);
    i += 1;
  }
  return nodes;
}

function decorateLineMarkdown(line: string, lineIndex: number): ReactNode[] {
  // H1–H4: a run of 1–4 "#" followed by whitespace. Keep the markers, render
  // the whole line bold + uppercase at the body size.
  if (/^#{1,4}\s/.test(line)) {
    return [
      <span key={`line-${lineIndex}`} className="font-bold uppercase">
        {line}
      </span>,
    ];
  }
  return decorateInlineMarkdown(line, `line-${lineIndex}`);
}

function decorateMarkdownForEditBackdrop(text: string): ReactNode[] {
  if (text.length === 0) {
    return [];
  }

  return text
    .split("\n")
    .flatMap((line, index) => [
      ...(index === 0 ? [] : ["\n"]),
      ...decorateLineMarkdown(line, index),
    ]);
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const isFocusedRef = useRef(false);
  const [draft, setDraft] = useState(editableText);
  const [mode, setMode] = useState<NoteEditorMode>(
    editableText.trim() ? "preview" : "edit",
  );
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adopt external state changes (e.g. layout reload) while the user is not
  // actively typing, so we never clobber an in-progress edit.
  useEffect(() => {
    if (!isFocusedRef.current) {
      setDraft(editableText);
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

  const handleDraftChange = (value: string) => {
    setDraft(value);
    scheduleTextSave(value);
  };

  const wrapSelectionWith = (marker: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = draft.slice(0, start);
    const selected = draft.slice(start, end);
    const after = draft.slice(end);
    const next = `${before}${marker}${selected}${marker}${after}`;
    handleDraftChange(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + marker.length, end + marker.length);
    });
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
    const fontSize = getEditableFontSize(instance.state);
    const isEmpty = draft.trim().length === 0;

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
          {mode === "edit" ? (
            <div className="relative min-h-0 flex-1">
              {/* Backdrop renders the decorated markdown behind the transparent
                  textarea. Both share font + metrics so the caret aligns. */}
              <div
                ref={backdropRef}
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words font-mono text-sticky-note-foreground",
                  fontSizeBodyClassName(fontSize),
                )}
              >
                {decorateMarkdownForEditBackdrop(draft)}
              </div>
              <textarea
                ref={textareaRef}
                value={draft}
                aria-label={t("widgets.stickyNote.editAria")}
                placeholder={t("widgets.stickyNote.placeholder")}
                spellCheck={true}
                draggable={false}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
                onScroll={(event) => {
                  if (backdropRef.current) {
                    backdropRef.current.scrollTop =
                      event.currentTarget.scrollTop;
                  }
                }}
                onFocus={() => {
                  isFocusedRef.current = true;
                }}
                onBlur={() => {
                  isFocusedRef.current = false;
                  commitText(draft);
                }}
                onChange={(event) => handleDraftChange(event.target.value)}
                className={cn(
                  "scrollbar-none overscroll-contain absolute inset-0 h-full w-full resize-none cursor-text overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words border-0 bg-transparent p-0 font-mono text-transparent caret-foreground outline-none select-text [box-shadow:none] [outline:0]",
                  "placeholder:text-sticky-note-muted/75",
                  "focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:[box-shadow:none]",
                  fontSizeBodyClassName(fontSize),
                )}
              />
            </div>
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: double-click is a convenience shortcut into edit mode; the toolbar toggle is the primary control.
            <div
              role="presentation"
              onPointerDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setMode("edit");
              }}
              className={cn(
                "scrollbar-subtle overscroll-contain relative min-h-0 flex-1 cursor-text overflow-x-hidden overflow-y-auto break-words pr-6 text-sticky-note-foreground [scrollbar-gutter:stable]",
                fontSizeBodyClassName(fontSize),
              )}
            >
              {isEmpty ? (
                <p className="text-sticky-note-muted/75">
                  {t("widgets.stickyNote.placeholder")}
                </p>
              ) : (
                <div className={NOTE_MARKDOWN_PROSE}>
                  <ReactMarkdown
                    components={noteMarkdownComponents}
                    remarkPlugins={[remarkGfm, remarkBreaks]}
                  >
                    {draft}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          )}
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
                  className={cn(
                    "size-5 rounded-full",
                    toneClassName(option),
                    // The neutral swatch is the card color, so it needs an
                    // outline to read against the translucent toolbar.
                    option === "neutral" && "border border-border",
                  )}
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
          {mode === "edit" ? (
            <>
              <div
                className="mx-0.5 h-5 w-px bg-border/70"
                aria-hidden="true"
              />
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("widgets.stickyNote.bold")}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    wrapSelectionWith("**");
                  }}
                  className={toolbarButtonClassName()}
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
                    wrapSelectionWith("*");
                  }}
                  className={toolbarButtonClassName()}
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
                    wrapSelectionWith("~~");
                  }}
                  className={toolbarButtonClassName()}
                >
                  <Strikethrough aria-hidden="true" />
                </Button>
              </div>
            </>
          ) : null}
          <div className="mx-0.5 h-5 w-px bg-border/70" aria-hidden="true" />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={
              mode === "edit"
                ? t("widgets.stickyNote.preview")
                : t("widgets.stickyNote.edit")
            }
            aria-pressed={mode === "preview"}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (mode === "edit") {
                commitText(draft);
                setMode("preview");
              } else {
                setMode("edit");
              }
            }}
            className={toolbarButtonClassName(mode === "preview")}
          >
            {mode === "edit" ? (
              <Eye aria-hidden="true" />
            ) : (
              <Pencil aria-hidden="true" />
            )}
          </Button>
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
