import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { hasOpenKeyboardOwningLayer } from "@/app/focus/FocusRegionProvider";
import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";
import {
  clearTranscriptSearchHighlights,
  findTranscriptMatches,
  paintTranscriptSearchHighlights,
  scrollTranscriptMatchIntoView,
} from "@/features/chat/lib/transcriptSearch";
import type {
  TranscriptSearchBackend,
  TranscriptSearchSnapshot,
} from "@/features/chat/lib/transcriptSearchBackend";

/** Lets a burst of keystrokes settle before re-walking the transcript. */
const QUERY_DEBOUNCE_MS = 120;

/** Streaming mutations re-walk the transcript at most this often. */
const MUTATION_REMATCH_MIN_INTERVAL_MS = 200;

/** Marks the search bar container so focus bookkeeping can recognize it. */
export const CHAT_SEARCH_BAR_ATTRIBUTE = "data-chat-transcript-search";

interface MatchState {
  count: number;
  activeIndex: number;
  /** True while a backend is still indexing rows; a zero count is not final. */
  indexing: boolean;
}

const EMPTY_MATCH_STATE: MatchState = {
  count: 0,
  activeIndex: -1,
  indexing: false,
};

export interface ChatTranscriptSearch {
  isOpen: boolean;
  query: string;
  matchCount: number;
  /** Index of the active match, -1 when none. */
  activeMatchIndex: number;
  /** True while a backend is still indexing; matchCount may still grow. */
  isIndexing: boolean;
  /**
   * Mirror of count/active that only updates on user intent (query settling,
   * navigation). Drives the screen-reader announcement so streaming recounts
   * don't spam the live region.
   */
  announcedMatchCount: number;
  announcedActiveMatchIndex: number;
  announcedIsIndexing: boolean;
  /** Increments whenever the search input should grab focus. */
  focusSignal: number;
  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  goToNext: () => void;
  goToPrevious: () => void;
}

function activeElementInsideSearchBar(): boolean {
  return (
    document.activeElement instanceof HTMLElement &&
    document.activeElement.closest(`[${CHAT_SEARCH_BAR_ATTRIBUTE}]`) !== null
  );
}

export interface UseChatTranscriptSearchOptions {
  /** When a renderer fills this (the virtualized timeline), matching,
      painting, and match navigation are delegated to it; the controller
      keeps owning the bar state, shortcut, focus, and announcements. */
  backendRef?: RefObject<TranscriptSearchBackend | null>;
}

/**
 * Find-in-transcript controller. Without a backend it matches against the
 * rendered DOM under `rootRef`, so the count always equals what highlighting
 * can show. Owns the find keyboard shortcut (`chat.findInConversation`,
 * Mod+F by default and user-rebindable).
 *
 * Scrolling happens only on user intent (query edits and next/previous
 * navigation); content mutations from streaming re-match and re-paint but
 * never move the viewport.
 */
export function useChatTranscriptSearch(
  rootRef: RefObject<HTMLElement | null>,
  options?: UseChatTranscriptSearchOptions,
): ChatTranscriptSearch {
  const backendRef = options?.backendRef;
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The query whose matches are currently painted; mutation re-matching keys
  // on this so streaming never recomputes mid-typing prefixes.
  const [settledQuery, setSettledQuery] = useState("");
  const [focusSignal, setFocusSignal] = useState(0);
  const [matchState, setMatchState] = useState(EMPTY_MATCH_STATE);
  const [announcedState, setAnnouncedState] = useState(EMPTY_MATCH_STATE);
  const matchStateRef = useRef(EMPTY_MATCH_STATE);
  const announcedStateRef = useRef(EMPTY_MATCH_STATE);
  const matchesRef = useRef<{ ranges: Range[]; activeIndex: number }>({
    ranges: [],
    activeIndex: -1,
  });
  const isOpenRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // Set when the settle-time announcement went out while the backend was
  // still indexing; the converged state then announces once via subscription.
  const pendingAnnounceRef = useRef(false);

  const applyMatches = useCallback(
    (ranges: Range[], activeIndex: number, options: { announce: boolean }) => {
      matchesRef.current = { ranges, activeIndex };
      const next = {
        count: ranges.length,
        activeIndex,
        indexing: false,
      };
      if (
        matchStateRef.current.count !== next.count ||
        matchStateRef.current.activeIndex !== next.activeIndex ||
        matchStateRef.current.indexing
      ) {
        matchStateRef.current = next;
        setMatchState(next);
      }
      if (
        options.announce &&
        (announcedStateRef.current.count !== next.count ||
          announcedStateRef.current.activeIndex !== next.activeIndex ||
          announcedStateRef.current.indexing)
      ) {
        announcedStateRef.current = next;
        setAnnouncedState(next);
      }
      paintTranscriptSearchHighlights(ranges, activeIndex);
    },
    [],
  );

  // Mirrors a backend snapshot into the bar state; used for user-initiated
  // operations, which are also announced. Subscription updates cover the
  // async remainder (indexing, streaming) without announcing.
  const adoptBackendSnapshot = useCallback(
    (snapshot: TranscriptSearchSnapshot, announce: boolean) => {
      const next: MatchState = {
        count: snapshot.total,
        activeIndex: snapshot.activeOrdinal,
        indexing: snapshot.indexing,
      };
      if (
        matchStateRef.current.count !== next.count ||
        matchStateRef.current.activeIndex !== next.activeIndex ||
        matchStateRef.current.indexing !== next.indexing
      ) {
        matchStateRef.current = next;
        setMatchState(next);
      }
      if (
        announce &&
        (announcedStateRef.current.count !== next.count ||
          announcedStateRef.current.activeIndex !== next.activeIndex ||
          announcedStateRef.current.indexing !== next.indexing)
      ) {
        announcedStateRef.current = next;
        setAnnouncedState(next);
      }
    },
    [],
  );

  const open = useCallback(() => {
    // Re-capture on every invocation from outside the bar so Escape returns
    // to where the user actually came from, not the original opener.
    if (!activeElementInsideSearchBar()) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    if (!isOpenRef.current) {
      isOpenRef.current = true;
      setIsOpen(true);
    }
    setFocusSignal((signal) => signal + 1);
  }, []);

  const close = useCallback(() => {
    if (!isOpenRef.current) {
      return;
    }

    // Only restore focus when closing actually disturbs it (focus is inside
    // the bar). A programmatic close while the user works elsewhere — e.g.
    // the session-id change effect — must not steal focus.
    const shouldRestoreFocus = activeElementInsideSearchBar();

    isOpenRef.current = false;
    setIsOpen(false);
    setQuery("");
    setSettledQuery("");
    pendingAnnounceRef.current = false;
    backendRef?.current?.clear();
    applyMatches([], -1, { announce: true });
    clearTranscriptSearchHighlights();

    const previousFocus = previousFocusRef.current;
    previousFocusRef.current = null;
    if (shouldRestoreFocus && previousFocus?.isConnected) {
      previousFocus.focus();
    }
  }, [applyMatches, backendRef]);

  // The find shortcut. Registry matching is strict (exact modifier set), so
  // with the default Mod+F binding macOS Ctrl+F — the system caret-forward
  // binding inside text fields — still passes through.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }

      if (!eventMatchesShortcutCommand(event, "chat.findInConversation")) {
        return;
      }

      // Any mounted modal/popper owns the keyboard, even when focus sits
      // outside it (matching the focus provider's pane-jump guard).
      if (hasOpenKeyboardOwningLayer()) {
        return;
      }

      event.preventDefault();
      open();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Re-match on query edits (debounced), selecting and revealing the first
  // match like native find-in-page.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (!query.trim()) {
      setSettledQuery("");
      pendingAnnounceRef.current = false;
      backendRef?.current?.clear();
      applyMatches([], -1, { announce: true });
      return;
    }

    const timer = window.setTimeout(() => {
      // The cleanup that clears this timer is a passive effect, so the timer
      // can still fire after a synchronous close().
      if (!isOpenRef.current) {
        return;
      }

      const backend = backendRef?.current;
      if (backend) {
        backend.setQuery(query);
        const snapshot = backend.getSnapshot();
        pendingAnnounceRef.current = snapshot.indexing;
        adoptBackendSnapshot(snapshot, true);
        return;
      }

      const root = rootRef.current;
      if (!root) {
        return;
      }

      setSettledQuery(query);
      const ranges = findTranscriptMatches(root, query);
      applyMatches(ranges, ranges.length > 0 ? 0 : -1, { announce: true });
      if (ranges.length > 0) {
        scrollTranscriptMatchIntoView(ranges[0], "auto");
      }
    }, QUERY_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [adoptBackendSnapshot, applyMatches, backendRef, isOpen, query, rootRef]);

  // Async backend updates (indexing progress, streaming recounts) refresh the
  // visible count without announcing.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const backend = backendRef?.current;
    if (!backend) {
      return;
    }

    return backend.subscribe((snapshot) => {
      // Indexing progress refreshes silently; the converged result announces
      // once so the live region never ends on a transient state.
      const announceConvergence =
        pendingAnnounceRef.current && !snapshot.indexing;
      if (announceConvergence) {
        pendingAnnounceRef.current = false;
      }
      adoptBackendSnapshot(snapshot, announceConvergence);
    });
  }, [adoptBackendSnapshot, backendRef, isOpen]);

  // Re-match when the transcript itself changes (streaming, expand/collapse),
  // throttled — match counts don't need per-frame refresh. Painting via
  // CSS.highlights mutates no DOM, so this cannot self-trigger.
  useEffect(() => {
    if (!isOpen || !settledQuery) {
      return;
    }

    const root = rootRef.current;
    if (!root || typeof MutationObserver === "undefined") {
      return;
    }

    let frame: number | null = null;
    let trailing: number | null = null;
    let lastMatchedAt = 0;

    const rematch = () => {
      // A frame can be serviced between a synchronous close() and this
      // effect's passive cleanup; never repaint a closed search.
      if (!isOpenRef.current) {
        return;
      }

      lastMatchedAt = performance.now();
      const ranges = findTranscriptMatches(root, settledQuery);
      const previousActive = matchesRef.current.activeIndex;
      const nextActive =
        ranges.length === 0 ? -1 : Math.min(previousActive, ranges.length - 1);
      applyMatches(ranges, nextActive, { announce: false });
    };

    const scheduleRematch = () => {
      if (frame !== null || trailing !== null) {
        return;
      }

      const wait =
        MUTATION_REMATCH_MIN_INTERVAL_MS - (performance.now() - lastMatchedAt);
      if (wait > 0) {
        trailing = window.setTimeout(() => {
          trailing = null;
          frame = requestAnimationFrame(() => {
            frame = null;
            rematch();
          });
        }, wait);
        return;
      }

      frame = requestAnimationFrame(() => {
        frame = null;
        rematch();
      });
    };

    const observer = new MutationObserver(scheduleRematch);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    return () => {
      observer.disconnect();
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      if (trailing !== null) {
        window.clearTimeout(trailing);
      }
    };
  }, [applyMatches, isOpen, settledQuery, rootRef]);

  // The highlight registry is document-global; never leak past unmount.
  useEffect(() => clearTranscriptSearchHighlights, []);

  const navigate = useCallback(
    (direction: 1 | -1) => {
      const backend = backendRef?.current;
      if (backend) {
        backend.navigate(direction);
        pendingAnnounceRef.current = false;
        adoptBackendSnapshot(backend.getSnapshot(), true);
        return;
      }

      const { ranges, activeIndex } = matchesRef.current;
      if (ranges.length === 0) {
        return;
      }

      const next =
        activeIndex < 0
          ? direction === 1
            ? 0
            : ranges.length - 1
          : (activeIndex + direction + ranges.length) % ranges.length;
      applyMatches(ranges, next, { announce: true });
      scrollTranscriptMatchIntoView(ranges[next], "smooth");
    },
    [adoptBackendSnapshot, applyMatches, backendRef],
  );

  const goToNext = useCallback(() => navigate(1), [navigate]);
  const goToPrevious = useCallback(() => navigate(-1), [navigate]);

  return {
    isOpen,
    query,
    matchCount: matchState.count,
    activeMatchIndex: matchState.activeIndex,
    isIndexing: matchState.indexing,
    announcedMatchCount: announcedState.count,
    announcedActiveMatchIndex: announcedState.activeIndex,
    announcedIsIndexing: announcedState.indexing,
    focusSignal,
    open,
    close,
    setQuery,
    goToNext,
    goToPrevious,
  };
}
