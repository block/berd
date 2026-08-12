import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, TextareaHTMLAttributes } from "react";
import { Check, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import type { ChecklistItemState, WidgetRenderProps } from "./types";

// A single-line-feeling field that wraps and grows with its content instead of
// scrolling sideways. Height tracks the wrapped content; width changes (widget
// resize) trigger a recompute so rewrapped text stays fully visible.
const AutoGrowTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function AutoGrowTextarea(
  { value, onInput, className, ...props },
  forwardedRef,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const lastWidthRef = useRef(0);

  const assignRef = (element: HTMLTextAreaElement | null) => {
    innerRef.current = element;
    if (typeof forwardedRef === "function") {
      forwardedRef(element);
    } else if (forwardedRef) {
      forwardedRef.current = element;
    }
  };

  const resize = useCallback(() => {
    const element = innerRef.current;
    if (!element) {
      return;
    }
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  // Recompute when the value or text styling (font size) changes. value and
  // className aren't read in the body but changing them changes the rendered
  // height, so they must stay in the dependency list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above.
  useLayoutEffect(() => {
    resize();
  }, [resize, value, className]);

  // Recompute when the available width changes; guarded so our own height
  // writes don't loop the observer.
  useLayoutEffect(() => {
    const element = innerRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width !== lastWidthRef.current) {
        lastWidthRef.current = width;
        resize();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [resize]);

  return (
    <textarea
      ref={assignRef}
      rows={1}
      value={value}
      onInput={(event) => {
        resize();
        onInput?.(event);
      }}
      className={cn(
        "resize-none overflow-hidden whitespace-pre-wrap break-words",
        className,
      )}
      {...props}
    />
  );
});

type ChecklistTone =
  | "neutral"
  | "warm"
  | "cool"
  | "rose"
  | "blue"
  | "lavender"
  | "peach";
type ChecklistFontSize = "small" | "medium" | "large";

const EDIT_SAVE_DELAY_MS = 400;
const CHECKLIST_TONES = [
  "neutral",
  "peach",
  "warm",
  "cool",
  "rose",
  "blue",
  "lavender",
] as const satisfies ChecklistTone[];
const CHECKLIST_FONT_SIZES = [
  "small",
  "medium",
  "large",
] as const satisfies ChecklistFontSize[];

function getTitle(state: Record<string, unknown> | undefined): string {
  return typeof state?.title === "string" ? state.title : "";
}

function isChecklistItem(value: unknown): value is ChecklistItemState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.text === "string";
}

function getItems(
  state: Record<string, unknown> | undefined,
): ChecklistItemState[] {
  const raw = state?.items;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isChecklistItem).map((item) => ({
    id: item.id,
    text: item.text,
    done: item.done === true,
  }));
}

function getTone(state: Record<string, unknown> | undefined): ChecklistTone {
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

function getFontSize(
  state: Record<string, unknown> | undefined,
): ChecklistFontSize {
  switch (state?.fontSize) {
    case "small":
    case "medium":
    case "large":
      return state.fontSize;
    default:
      return "medium";
  }
}

function toneClassName(tone: ChecklistTone): string {
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

function toneLabelKey(tone: ChecklistTone): string {
  return `widgets.checklist.tones.${tone}`;
}

function fontSizeLabelKey(size: ChecklistFontSize): string {
  return `widgets.checklist.fontSizes.${size}`;
}

function fontSizeGlyphClassName(size: ChecklistFontSize): string {
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

function fontSizeBodyClassName(size: ChecklistFontSize): string {
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
    active
      ? "bg-foreground/[0.07] text-foreground"
      : "text-foreground/80 hover:bg-foreground/[0.05]",
  );
}

function makeItemId(): string {
  return crypto.randomUUID();
}

export function ChecklistWidget({
  instance,
  onUpdateState,
  onRemoveWidget,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const tone = getTone(instance.state);
  const fontSize = getFontSize(instance.state);

  const isFocusedRef = useRef(false);
  const [title, setTitle] = useState(() => getTitle(instance.state));
  const [items, setItems] = useState<ChecklistItemState[]>(() =>
    getItems(instance.state),
  );
  const [newItemText, setNewItemText] = useState("");
  // Refs mirror the latest values so debounced saves never persist a stale
  // snapshot when text edits and structural changes interleave.
  const titleRef = useRef(title);
  const itemsRef = useRef(items);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemInputRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const newItemRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingFocusRef = useRef<string | null>(null);

  // Adopt external state changes (layout reload) only while not actively
  // editing, so an in-progress edit is never clobbered.
  useEffect(() => {
    if (isFocusedRef.current) {
      return;
    }
    const nextTitle = getTitle(instance.state);
    const nextItems = getItems(instance.state);
    titleRef.current = nextTitle;
    itemsRef.current = nextItems;
    setTitle(nextTitle);
    setItems(nextItems);
  }, [instance.state]);

  useEffect(
    () => () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    },
    [],
  );

  // Apply a queued focus target after the items render.
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) {
      return;
    }
    pendingFocusRef.current = null;
    if (target === "new") {
      newItemRef.current?.focus();
      return;
    }
    const input = itemInputRefs.current.get(target);
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  const saveNow = () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    onUpdateState({ title: titleRef.current, items: itemsRef.current });
  };

  const saveSoon = () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      onUpdateState({ title: titleRef.current, items: itemsRef.current });
    }, EDIT_SAVE_DELAY_MS);
  };

  const setTitleLocal = (value: string) => {
    titleRef.current = value;
    setTitle(value);
  };

  const setItemsLocal = (next: ChecklistItemState[]) => {
    itemsRef.current = next;
    setItems(next);
  };

  const handleTitleChange = (value: string) => {
    setTitleLocal(value);
    saveSoon();
  };

  const updateItemText = (id: string, text: string) => {
    setItemsLocal(
      items.map((item) => (item.id === id ? { ...item, text } : item)),
    );
    saveSoon();
  };

  const toggleItem = (id: string) => {
    setItemsLocal(
      items.map((item) =>
        item.id === id ? { ...item, done: !item.done } : item,
      ),
    );
    saveNow();
  };

  const addItemAfter = (id: string) => {
    const next = makeItemId();
    const index = items.findIndex((item) => item.id === id);
    const inserted: ChecklistItemState = { id: next, text: "", done: false };
    const nextItems =
      index === -1
        ? [...items, inserted]
        : [...items.slice(0, index + 1), inserted, ...items.slice(index + 1)];
    setItemsLocal(nextItems);
    pendingFocusRef.current = next;
    saveNow();
  };

  const removeItem = (id: string) => {
    const index = items.findIndex((item) => item.id === id);
    setItemsLocal(items.filter((item) => item.id !== id));
    pendingFocusRef.current = index > 0 ? items[index - 1].id : "new";
    saveNow();
  };

  const commitNewItem = (text: string) => {
    if (text.trim().length === 0) {
      setNewItemText("");
      return;
    }
    const inserted: ChecklistItemState = {
      id: makeItemId(),
      text,
      done: false,
    };
    setItemsLocal([...items, inserted]);
    setNewItemText("");
    pendingFocusRef.current = "new";
    saveNow();
  };

  const handleItemKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
    item: ChecklistItemState,
  ) => {
    // Plain Enter adds the next item; Shift+Enter inserts a line break.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      addItemAfter(item.id);
    } else if (event.key === "Backspace" && item.text.length === 0) {
      event.preventDefault();
      removeItem(item.id);
    }
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const firstItem = items[0];
      const target = firstItem
        ? itemInputRefs.current.get(firstItem.id)
        : newItemRef.current;
      target?.focus();
    }
  };

  return (
    <section
      aria-label={t("widgets.checklist.label")}
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
          aria-label={t("widgets.checklist.dismiss")}
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
        <AutoGrowTextarea
          value={title}
          aria-label={t("widgets.checklist.titlePlaceholder")}
          placeholder={t("widgets.checklist.titlePlaceholder")}
          draggable={false}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onFocus={() => {
            isFocusedRef.current = true;
          }}
          onBlur={() => {
            isFocusedRef.current = false;
            saveNow();
          }}
          onChange={(event) => handleTitleChange(event.target.value)}
          onKeyDown={handleTitleKeyDown}
          className={cn(
            "mb-1.5 w-full shrink-0 border-0 bg-transparent p-0 pr-6 font-semibold text-sticky-note-foreground caret-foreground outline-none placeholder:text-sticky-note-muted/75",
            fontSizeBodyClassName(fontSize),
          )}
        />
        <div
          className="scrollbar-subtle overscroll-contain min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
          onWheel={(event) => event.stopPropagation()}
        >
          <ul
            className={cn(
              "flex flex-col gap-0.5",
              fontSizeBodyClassName(fontSize),
            )}
          >
            {items.map((item) => (
              <li key={item.id} className="group/item flex items-start gap-2">
                <Checkbox
                  checked={item.done}
                  aria-label={t("widgets.checklist.toggleItem")}
                  onPointerDown={(event) => event.stopPropagation()}
                  onCheckedChange={() => toggleItem(item.id)}
                  className="mt-1 size-4 shrink-0 border-sticky-note-muted/60 data-[state=checked]:border-background data-[state=checked]:bg-sticky-note-foreground data-[state=checked]:text-sticky-note-warm"
                />
                <AutoGrowTextarea
                  ref={(element) => {
                    if (element) {
                      itemInputRefs.current.set(item.id, element);
                    } else {
                      itemInputRefs.current.delete(item.id);
                    }
                  }}
                  value={item.text}
                  aria-label={t("widgets.checklist.itemPlaceholder")}
                  placeholder={t("widgets.checklist.itemPlaceholder")}
                  draggable={false}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onFocus={() => {
                    isFocusedRef.current = true;
                  }}
                  onBlur={() => {
                    isFocusedRef.current = false;
                    saveNow();
                  }}
                  onChange={(event) =>
                    updateItemText(item.id, event.target.value)
                  }
                  onKeyDown={(event) => handleItemKeyDown(event, item)}
                  className={cn(
                    "min-w-0 flex-1 border-0 bg-transparent p-0 text-sticky-note-foreground caret-foreground outline-none placeholder:text-sticky-note-muted/75",
                    item.done && "text-sticky-note-muted line-through",
                  )}
                />
                <button
                  type="button"
                  aria-label={t("widgets.checklist.removeItem")}
                  onPointerDownCapture={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    removeItem(item.id);
                  }}
                  className="mt-0.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-sticky-note-muted opacity-0 transition-opacity hover:text-sticky-note-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/item:opacity-100"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
            <li className="flex items-start gap-2 text-sticky-note-muted">
              <Plus className="mt-1 size-4 shrink-0" aria-hidden="true" />
              <AutoGrowTextarea
                ref={newItemRef}
                value={newItemText}
                aria-label={t("widgets.checklist.addItem")}
                placeholder={t("widgets.checklist.addItem")}
                draggable={false}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onFocus={() => {
                  isFocusedRef.current = true;
                }}
                onBlur={() => {
                  isFocusedRef.current = false;
                  commitNewItem(newItemText);
                }}
                onChange={(event) => setNewItemText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    commitNewItem(newItemText);
                  }
                }}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sticky-note-foreground caret-foreground outline-none placeholder:text-sticky-note-muted/75"
              />
            </li>
          </ul>
        </div>
      </div>
      <div
        role="toolbar"
        aria-label={t("widgets.checklist.toolbar")}
        className={cn(
          "absolute left-1/2 top-0 z-40 flex w-max max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-[calc(100%+0.625rem)] cursor-default items-center gap-0.5 rounded-full border border-border/45 bg-card/45 px-2 py-1 text-foreground opacity-0 shadow-popover backdrop-blur-[2px] transition-opacity duration-150",
          "group-hover:opacity-100 group-focus-within:opacity-100",
        )}
        onPointerDownCapture={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-1">
          {CHECKLIST_TONES.map((option) => (
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
              className="relative flex size-7 cursor-pointer items-center justify-center rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
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
          {CHECKLIST_FONT_SIZES.map((size) => (
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
      </div>
    </section>
  );
}
