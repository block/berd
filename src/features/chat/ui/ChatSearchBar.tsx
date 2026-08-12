import { useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { SearchBar } from "@/shared/ui/SearchBar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { CHAT_SEARCH_BAR_ATTRIBUTE } from "@/features/chat/hooks/useChatTranscriptSearch";
import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";
import { MAX_TRANSCRIPT_SEARCH_MATCHES } from "@/features/chat/lib/transcriptSearch";

const searchBarRootAttribute = { [CHAT_SEARCH_BAR_ATTRIBUTE]: "" };

interface ChatSearchBarProps {
  query: string;
  totalMatches: number;
  activeMatchIndex: number;
  /** True while the match index is still converging; a zero total is not
      final yet. */
  isIndexing: boolean;
  /** Screen-reader-announced mirror; updates only on user intent. */
  announcedTotalMatches: number;
  announcedActiveMatchIndex: number;
  announcedIsIndexing: boolean;
  /** Re-focuses and selects the input whenever this increments. */
  focusSignal: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  className?: string;
}

export function ChatSearchBar({
  query,
  totalMatches,
  activeMatchIndex,
  isIndexing,
  announcedTotalMatches,
  announcedActiveMatchIndex,
  announcedIsIndexing,
  focusSignal,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
  className,
}: ChatSearchBarProps) {
  const { t } = useTranslation("chat");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchLabelId = useId();
  const hasQuery = query.trim().length > 0;

  const formatStatus = (
    total: number,
    activeIndex: number,
    indexing: boolean,
  ): string | null => {
    if (!hasQuery) {
      return null;
    }
    if (total === 0) {
      // A zero total is not a verdict while the index is still converging.
      return indexing ? t("search.searching") : t("search.noResults");
    }

    const currentMatch = activeIndex >= 0 ? activeIndex + 1 : 0;
    // The match list is capped; an exact-looking total would be a lie.
    const cappedTotal =
      total >= MAX_TRANSCRIPT_SEARCH_MATCHES ? `${total}+` : total;
    return t("search.matchCount", {
      current: currentMatch,
      total: cappedTotal,
    });
  };

  const status = formatStatus(totalMatches, activeMatchIndex, isIndexing);
  // Streaming recounts update the visible number silently; only
  // user-initiated changes are announced to screen readers.
  const announcedStatus = formatStatus(
    announcedTotalMatches,
    announcedActiveMatchIndex,
    announcedIsIndexing,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusSignal is the re-focus trigger, including when the bar is already open.
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  // On the container so Escape also closes from the navigation buttons.
  const handleContainerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }

    if (eventMatchesShortcutCommand(event.nativeEvent, "chat.search.close")) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  // Enter/ArrowDown/Ctrl+N step forward; Shift+Enter/ArrowUp/Ctrl+P step back
  // (the fixed `chat.search.*` bindings).
  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }

    // The bar consumes Enter with any modifiers (pre-registry behavior) so
    // e.g. Cmd+Enter steps results instead of falling through.
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
      return;
    }

    // stopPropagation keeps consumed keys from also firing window-level
    // commands — Ctrl+N/Ctrl+P collide with the new-conversation and
    // quick-switch defaults off macOS.
    if (eventMatchesShortcutCommand(event.nativeEvent, "chat.search.next")) {
      event.preventDefault();
      event.stopPropagation();
      onNext();
      return;
    }

    if (
      eventMatchesShortcutCommand(event.nativeEvent, "chat.search.previous")
    ) {
      event.preventDefault();
      event.stopPropagation();
      onPrevious();
    }
  };

  const navigationDisabled = totalMatches === 0;
  const previousLabel = t("search.previous");
  const nextLabel = t("search.next");
  const closeLabel = t("search.close");

  return (
    <search
      {...searchBarRootAttribute}
      aria-labelledby={searchLabelId}
      onKeyDown={handleContainerKeyDown}
      className={cn(
        "pointer-events-auto flex w-[min(28rem,calc(100vw-3rem))] items-center gap-1 rounded-md border border-border/80 bg-popover px-2 py-1 shadow-[var(--shadow-chat)]",
        className,
      )}
    >
      <span id={searchLabelId} className="sr-only">
        {t("search.landmark")}
      </span>
      <SearchBar
        value={query}
        onChange={onQueryChange}
        onKeyDown={handleInputKeyDown}
        inputRef={inputRef}
        size="compact"
        placeholder={t("search.placeholder")}
        aria-label={t("search.inputLabel")}
        className="min-w-0 flex-1 border-none px-0"
      />
      <div
        aria-hidden="true"
        data-testid="chat-search-match-count"
        className="min-w-14 shrink-0 text-right text-[11px] text-muted-foreground"
      >
        {status}
      </div>
      <div role="status" className="sr-only">
        {announcedStatus}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onPrevious}
            disabled={navigationDisabled}
            aria-label={previousLabel}
          >
            <ChevronUp aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{previousLabel}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onNext}
            disabled={navigationDisabled}
            aria-label={nextLabel}
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{nextLabel}</TooltipContent>
      </Tooltip>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onClose}
        aria-label={closeLabel}
        tooltip={closeLabel}
      >
        <X aria-hidden="true" />
      </Button>
    </search>
  );
}
