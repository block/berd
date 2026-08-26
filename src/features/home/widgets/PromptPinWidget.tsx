import { memo, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Play, X } from "lucide-react";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { replaceMentionQuery } from "@/features/chat/hooks/useMentionHandlers";
import {
  MentionAutocomplete,
  useMentionDetection,
} from "@/features/chat/ui/MentionAutocomplete";
import { PersonaAvatar, PersonaPicker } from "@/features/chat/ui/PersonaPicker";
import type { Persona } from "@/shared/types/agents";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverAnchor } from "@/shared/ui/popover";
import { Spinner } from "@/shared/ui/spinner";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import { type PromptPinMode, promptPinMode } from "./promptPinMode";
import type { WidgetRenderProps } from "./types";

const EDIT_SAVE_DELAY_MS = 400;

function stateString(
  state: Record<string, unknown> | undefined,
  key: "title" | "text" | "agentId",
): string {
  const value = state?.[key];
  return typeof value === "string" ? value : "";
}

type InsertedMention = {
  personaId: string;
  start: number;
  mention: string;
};

// Where the widget-inserted mention currently sits, or null when it can no
// longer be identified. Editing earlier in the prompt shifts the recorded
// range, so fall back to a search — but only when the mention text appears
// once, since duplicates give no way to tell which occurrence was inserted.
function findInsertedMention(
  text: string,
  tracked: InsertedMention,
): number | null {
  const { start, mention } = tracked;
  if (text.slice(start, start + mention.length) === mention) {
    return start;
  }
  const first = text.indexOf(mention);
  if (first < 0 || first !== text.lastIndexOf(mention)) {
    return null;
  }
  return first;
}

export const PromptPinWidget = memo(function PromptPinWidget({
  instance,
  onUpdateState,
  onRemoveWidget,
  shouldIgnoreActivation,
  onRunPrompt,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const personas = useAgentStore((state) => state.personas);
  const mentionListboxId = useId();

  const savedTitle = stateString(instance.state, "title");
  const savedText = stateString(instance.state, "text");
  const agentId = stateString(instance.state, "agentId") || null;

  // A freshly picked widget has no text yet, so it opens ready to type.
  const [mode, setMode] = useState<PromptPinMode>(() =>
    promptPinMode(instance.state),
  );
  const [isLaunching, setIsLaunching] = useState(false);
  const isFocusedRef = useRef(false);
  const [title, setTitle] = useState(savedTitle);
  const [text, setText] = useState(savedText);
  // Refs mirror the latest values so debounced saves never persist a stale
  // snapshot when title and text edits interleave.
  const titleRef = useRef(title);
  const textRef = useRef(text);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCursorRef = useRef<number | null>(null);
  // Swapping the attached agent may only rewrite a mention this widget
  // inserted. Locating it by display name alone deletes authored prose that
  // happens to name the old agent — including when the agent was attached
  // through the persona picker and the prompt never had a widget mention.
  const insertedMentionRef = useRef<InsertedMention | null>(null);

  // Adopt external state changes (layout reload) only while not actively
  // editing, so an in-progress edit is never clobbered.
  useEffect(() => {
    if (isFocusedRef.current) {
      return;
    }
    if (savedText !== textRef.current) {
      // The prompt was replaced from outside, so no range in it is ours. A
      // save round-tripping its own text is not a replacement and must keep
      // the tracking, or the next swap would strand the previous mention.
      insertedMentionRef.current = null;
    }
    titleRef.current = savedTitle;
    textRef.current = savedText;
    setTitle(savedTitle);
    setText(savedText);
  }, [savedTitle, savedText]);

  // Read through a ref so the unmount-only cleanup below cannot flush through a
  // first-render copy of the callback.
  const onUpdateStateRef = useRef(onUpdateState);
  onUpdateStateRef.current = onUpdateState;

  useEffect(
    () => () => {
      if (!saveTimeoutRef.current) {
        return;
      }
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
      // Removing a focused element does not fire blur, so leaving Home mid-edit
      // would drop the debounced save and reopen the pin with the old text.
      // Flushing after a removal is harmless: updateWidgetState no-ops once the
      // instance is gone, so an abandoned draft still does not come back.
      onUpdateStateRef.current({
        title: titleRef.current,
        text: textRef.current,
      });
    },
    [],
  );

  const saveNow = (extra?: Record<string, unknown>) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    onUpdateState({
      title: titleRef.current,
      text: textRef.current,
      ...extra,
    });
  };

  // The mode is persisted, not just local, because the catalog sizes the frame
  // from it — otherwise the drag surface and resize handle keep the other
  // mode's height and float away from the visible card.
  const changeMode = (next: PromptPinMode) => {
    setMode(next);
    onUpdateState({ mode: next });
  };

  const saveSoon = () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      onUpdateState({ title: titleRef.current, text: textRef.current });
    }, EDIT_SAVE_DELAY_MS);
  };

  const handleTitleChange = (value: string) => {
    titleRef.current = value;
    setTitle(value);
    saveSoon();
  };

  const handleTextChange = (value: string) => {
    textRef.current = value;
    setText(value);
    saveSoon();
  };

  const handleAgentChange = (personaId: string | null) => {
    onUpdateState({ agentId: personaId ?? undefined });
  };

  const handleAgentPick = (personaId: string | null) => {
    // A picker choice inserts no mention, so the prompt holds nothing this
    // widget may rewrite later.
    insertedMentionRef.current = null;
    handleAgentChange(personaId);
  };

  const handleDone = () => {
    saveNow({ mode: "ready" });
    setMode("ready");
  };

  const {
    mentionOpen,
    mentionTrigger,
    atMentionCategory,
    mentionQuery,
    mentionStartIndex,
    mentionSelectedIndex,
    filteredPersonas,
    detectMention,
    closeMention,
    dismissMention,
    navigateMention,
    confirmMention,
    registerCompletedMention,
  } = useMentionDetection(personas);
  // The pin only supports agent mentions; "/" (skills) and category switches
  // never open here.
  const agentMentionOpen =
    mentionOpen && mentionTrigger === "@" && atMentionCategory === "agents";

  // Restore the caret after a mention selection rewrites the text.
  useEffect(() => {
    const pendingCursor = pendingCursorRef.current;
    const textarea = textareaRef.current;
    if (pendingCursor == null || !textarea) {
      return;
    }
    pendingCursorRef.current = null;
    const cursor = Math.min(pendingCursor, text.length);
    textarea.focus();
    textarea.setSelectionRange(cursor, cursor);
  }, [text]);

  const handlePersonaMentionSelect = (persona: Persona) => {
    const currentText = textRef.current;
    const activePersona = agentId
      ? personas.find((candidate) => candidate.id === agentId)
      : undefined;
    let nextText = currentText;
    let nextMentionStartIndex = mentionStartIndex;
    const tracked = insertedMentionRef.current;
    // The tracked mention must still be the one the attachment came from;
    // otherwise the prompt owns that text and only agentId changes.
    if (
      activePersona &&
      activePersona.id !== persona.id &&
      tracked?.personaId === activePersona.id
    ) {
      const activeMentionIndex = findInsertedMention(currentText, tracked);
      if (
        activeMentionIndex !== null &&
        activeMentionIndex !== mentionStartIndex
      ) {
        let removeStart = activeMentionIndex;
        let removeEnd = activeMentionIndex + tracked.mention.length;
        if (currentText[removeEnd] === " ") {
          removeEnd += 1;
        } else if (removeStart > 0 && currentText[removeStart - 1] === " ") {
          removeStart -= 1;
        }
        nextText = `${currentText.slice(0, removeStart)}${currentText.slice(removeEnd)}`;
        if (removeStart < mentionStartIndex) {
          nextMentionStartIndex -= removeEnd - removeStart;
        }
      }
    }
    const { newText, cursorPosition } = replaceMentionQuery(
      nextText,
      nextMentionStartIndex,
      mentionQuery,
      `@${persona.displayName}`,
    );
    pendingCursorRef.current = cursorPosition;
    registerCompletedMention(persona.displayName);
    // replaceMentionQuery writes the replacement at the query's start index.
    insertedMentionRef.current = {
      personaId: persona.id,
      start: nextMentionStartIndex,
      mention: `@${persona.displayName}`,
    };
    textRef.current = newText;
    setText(newText);
    closeMention();
    handleAgentChange(persona.id);
    saveSoon();
  };

  const persona = agentId
    ? personas.find((candidate) => candidate.id === agentId)
    : undefined;
  // Ready mode renders the local draft (kept in sync with persisted state by
  // the adoption effect) so a just-finished edit shows before the async layout
  // save round-trips.
  const displayTitle =
    title.trim() ||
    text.trim().split("\n")[0]?.trim() ||
    t("widgets.promptPin.emptyText");

  const handleActivate = useWidgetActivationGuard(
    shouldIgnoreActivation,
    () => {
      if (isLaunching) {
        return;
      }
      const promptText = textRef.current.trim();
      if (!promptText) {
        changeMode("edit");
        return;
      }
      if (!onRunPrompt) {
        return;
      }
      setIsLaunching(true);
      void Promise.resolve(
        onRunPrompt({ text: promptText, agentId: agentId ?? undefined }),
      ).finally(() => setIsLaunching(false));
    },
  );

  if (mode === "edit") {
    return (
      <section
        aria-label={t("widgets.promptPin.label")}
        className="h-full w-full text-foreground"
      >
        <div className="flex h-full w-full flex-col gap-2 overflow-hidden rounded-md bg-card p-4">
          {/* The remove button is a sibling rather than an overlay so the
              title's focus ring ends before it instead of running underneath. */}
          <div className="flex shrink-0 items-center gap-1">
            <input
              value={title}
              aria-label={t("widgets.promptPin.titlePlaceholder")}
              placeholder={t("widgets.promptPin.titlePlaceholder")}
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
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm font-semibold text-foreground caret-foreground outline-none placeholder:text-muted-foreground"
            />
            {/* Mirrors the sticky note's corner X, and is the only visible way
                to abandon a pin — the right-click Unpin pill is the sole other
                exit and nothing on the card advertises it. Pulled into the
                card's padding so it reads as a corner control. */}
            {onRemoveWidget ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("widgets.promptPin.dismiss")}
                onPointerDownCapture={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onRemoveWidget();
                }}
                className="-mr-2 shrink-0"
              >
                <X aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          <Popover open={agentMentionOpen}>
            <PopoverAnchor asChild>
              <textarea
                ref={textareaRef}
                value={text}
                aria-label={t("widgets.promptPin.textPlaceholder")}
                aria-controls={agentMentionOpen ? mentionListboxId : undefined}
                placeholder={t("widgets.promptPin.textPlaceholder")}
                draggable={false}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
                onFocus={() => {
                  isFocusedRef.current = true;
                }}
                onBlur={() => {
                  isFocusedRef.current = false;
                  saveNow();
                }}
                onChange={(event) => {
                  const value = event.target.value;
                  handleTextChange(value);
                  const cursor = event.target.selectionStart ?? value.length;
                  detectMention(value, cursor);
                }}
                onKeyDown={(event) => {
                  const isComposing =
                    event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229;
                  if (!agentMentionOpen || isComposing) {
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    dismissMention();
                    return;
                  }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    navigateMention(event.key === "ArrowDown" ? "down" : "up");
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    const item = confirmMention();
                    if (item?.type === "persona") {
                      event.preventDefault();
                      handlePersonaMentionSelect(item.persona);
                    }
                  }
                }}
                className="min-h-0 w-full flex-1 resize-none border-0 bg-transparent p-0 text-xs leading-5 text-foreground caret-foreground outline-none placeholder:text-muted-foreground"
              />
            </PopoverAnchor>
            <MentionAutocomplete
              isOpen={agentMentionOpen}
              filteredPersonas={filteredPersonas}
              selectedIndex={mentionSelectedIndex}
              listboxId={mentionListboxId}
              atCategory="agents"
              showCategoryTabs={false}
              onDismiss={dismissMention}
              onSelectPersona={handlePersonaMentionSelect}
            />
          </Popover>
          <div
            className="flex shrink-0 items-center justify-between gap-2"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-xs text-muted-foreground">
                {t("widgets.promptPin.agentLabel")}
              </span>
              <PersonaPicker
                personas={personas}
                selectedPersonaId={agentId}
                onPersonaChange={handleAgentPick}
                className="min-w-0"
              />
            </div>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!text.trim()}
              onClick={(event) => {
                event.stopPropagation();
                handleDone();
              }}
            >
              {t("widgets.promptPin.done")}
            </Button>
          </div>
        </div>
      </section>
    );
  }

  // The ready profile sizes the frame to this single row, so the card fills it
  // exactly and the drag surface matches what the user sees.
  return (
    <div className="group relative h-full w-full text-foreground">
      <button
        type="button"
        onClick={handleActivate}
        aria-label={t("widgets.promptPin.runAria", { title: displayTitle })}
        aria-busy={isLaunching || undefined}
        // Right padding reserves the edit button's width so a long title
        // truncates before it slides under it.
        className="flex h-full w-full cursor-pointer items-center gap-2 rounded-md bg-card px-3 pr-9 text-left transition-colors duration-150 hover:bg-muted"
      >
        {isLaunching ? (
          <Spinner
            decorative
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        ) : (
          <Play
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {displayTitle}
        </span>
        {persona ? (
          <span className="flex min-w-0 max-w-28 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <PersonaAvatar persona={persona} size="sm" />
            <span className="min-w-0 truncate">{persona.displayName}</span>
          </span>
        ) : null}
      </button>
      {/* No remove button here: the collapsed card is a one-row launcher, and a
          second control crowds it. Removal lives in the editor, one click
          behind the pencil, plus the canvas-wide right-click Unpin. */}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("widgets.promptPin.editAria")}
        onPointerDownCapture={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          changeMode("edit");
        }}
        className="absolute right-1.5 top-1/2 z-30 -translate-y-1/2"
      >
        <Pencil aria-hidden="true" />
      </Button>
    </div>
  );
});
