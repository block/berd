import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { Message } from "@/shared/types/messages";
import type { TranscriptRowDescriptor } from "../transcript/projection";
import { TranscriptRowStateProvider } from "../transcript/row-state";
import type { TranscriptVirtualRowStateProviderConfig } from "../transcript/virtual/react/useTranscriptVirtualTimeline";
import { MessageBubble } from "./MessageBubble";
import {
  clearTranscriptSearchHighlights,
  collectTranscriptSearchText,
  countTranscriptMatches,
  findTranscriptMatches,
  paintTranscriptSearchHighlights,
  scrollTranscriptMatchIntoView,
} from "@/features/chat/lib/transcriptSearch";
import type {
  TranscriptSearchBackend,
  TranscriptSearchSnapshot,
} from "@/features/chat/lib/transcriptSearchBackend";

/** Unmounted rows rendered offscreen per harvest batch. */
const HARVEST_BATCH_SIZE = 8;

/** A harvest batch is released once its DOM is quiet or this much time passed. */
const HARVEST_SETTLE_MAX_MS = 400;

/** Streaming/content changes re-tick the index at most this often. */
const TICK_MIN_INTERVAL_MS = 200;

/** Give a row this long to mount after scrollToRow before giving up. */
const PENDING_NAVIGATION_TIMEOUT_MS = 2000;

interface ActiveMatch {
  rowId: string;
  localIndex: number;
}

interface RowTextEntry {
  revision: string;
  text: string;
}

interface RowCountEntry {
  revision: string;
  query: string;
  count: number;
}

export interface VirtualTranscriptSearchOptions {
  /** Every transcript row in order (history + live tail). */
  rows: readonly TranscriptRowDescriptor[];
  messageByRowId: ReadonlyMap<string, Message>;
  /** Transcript content root; observed for mounted-row content drift. */
  listRootRef: RefObject<HTMLElement | null>;
  scrollToRow: (rowId: string) => boolean;
  rowStateProvider?: TranscriptVirtualRowStateProviderConfig;
  /** Receives the backend the chat search controller delegates to. */
  backendRef: RefObject<TranscriptSearchBackend | null> | undefined;
}

export interface VirtualTranscriptSearchHandle {
  /** Attach to every mounted transcript row, keyed by rowId. */
  registerRowElement: (rowId: string, element: HTMLElement | null) => void;
  /** Render this next to the transcript; it hosts offscreen text harvesting. */
  harvestHost: ReactNode;
}

const EMPTY_SNAPSHOT: TranscriptSearchSnapshot = {
  total: 0,
  activeOrdinal: -1,
  indexing: false,
};

/**
 * Only rows that render conversation content through MessageBubble are
 * searchable; date separators are locale chrome and the remaining kinds
 * render nothing today (mirrors VirtualTranscriptRow).
 */
function isSearchableRow(row: TranscriptRowDescriptor): boolean {
  return (
    row.kind === "message" ||
    (row.kind === "assistant-content-fragment" && row.fragment != null)
  );
}

/**
 * Indexed find-in-transcript backend for the virtualized timeline.
 *
 * Counts come from a per-row rendered-text cache: mounted rows are read in
 * place; unmounted rows are rendered through the same message renderer in a
 * hidden host and harvested once per render revision, so cached text always
 * carries rendered semantics — never raw markdown. Highlights paint only for
 * mounted rows; navigating to an unmounted match scrolls its row into the
 * window and finishes once the row registers. Windowing is never suspended.
 */
export function useVirtualTranscriptSearch({
  rows,
  messageByRowId,
  listRootRef,
  scrollToRow,
  rowStateProvider,
  backendRef,
}: VirtualTranscriptSearchOptions): VirtualTranscriptSearchHandle {
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const scrollToRowRef = useRef(scrollToRow);
  scrollToRowRef.current = scrollToRow;

  const rowElementsRef = useRef(new Map<string, HTMLElement>());
  const textCacheRef = useRef(new Map<string, RowTextEntry>());
  const countCacheRef = useRef(new Map<string, RowCountEntry>());
  const queryRef = useRef("");
  const activeRef = useRef<ActiveMatch | null>(null);
  const pendingNavigationRef = useRef<ActiveMatch | null>(null);
  const pendingNavigationTimerRef = useRef<number | null>(null);
  const listenersRef = useRef(
    new Set<(snapshot: TranscriptSearchSnapshot) => void>(),
  );
  const snapshotRef = useRef<TranscriptSearchSnapshot>(EMPTY_SNAPSHOT);
  const paintedRef = useRef(false);

  const [harvestRequests, setHarvestRequests] = useState<
    readonly TranscriptRowDescriptor[]
  >([]);

  const rowCount = useCallback((row: TranscriptRowDescriptor): number => {
    const query = queryRef.current;
    if (!query || !isSearchableRow(row)) {
      return 0;
    }

    const cachedText = textCacheRef.current.get(row.rowId);
    if (!cachedText || cachedText.revision !== row.renderRevision) {
      return 0;
    }

    const cachedCount = countCacheRef.current.get(row.rowId);
    if (
      cachedCount &&
      cachedCount.revision === row.renderRevision &&
      cachedCount.query === query
    ) {
      return cachedCount.count;
    }

    const count = countTranscriptMatches(cachedText.text, query);
    countCacheRef.current.set(row.rowId, {
      revision: row.renderRevision,
      query,
      count,
    });
    return count;
  }, []);

  const ordinalOf = useCallback(
    (target: ActiveMatch | null): number => {
      if (!target) {
        return -1;
      }

      let ordinal = 0;
      for (const row of rowsRef.current) {
        const count = rowCount(row);
        if (row.rowId === target.rowId) {
          if (count === 0) {
            return -1;
          }
          return ordinal + Math.min(target.localIndex, count - 1);
        }
        ordinal += count;
      }
      return -1;
    },
    [rowCount],
  );

  const locateOrdinal = useCallback(
    (ordinal: number): ActiveMatch | null => {
      let remaining = ordinal;
      for (const row of rowsRef.current) {
        const count = rowCount(row);
        if (remaining < count) {
          return { rowId: row.rowId, localIndex: remaining };
        }
        remaining -= count;
      }
      return null;
    },
    [rowCount],
  );

  const emitSnapshot = useCallback((next: TranscriptSearchSnapshot) => {
    const previous = snapshotRef.current;
    if (
      previous.total === next.total &&
      previous.activeOrdinal === next.activeOrdinal &&
      previous.indexing === next.indexing
    ) {
      return;
    }

    snapshotRef.current = next;
    for (const listener of listenersRef.current) {
      listener(next);
    }
  }, []);

  const requestTickRef = useRef<(() => void) | null>(null);

  const clearPendingNavigation = useCallback(() => {
    pendingNavigationRef.current = null;
    if (pendingNavigationTimerRef.current !== null) {
      window.clearTimeout(pendingNavigationTimerRef.current);
      pendingNavigationTimerRef.current = null;
    }
  }, []);

  /**
   * Scrolls to a match, deferring through the virtualizer when unmounted.
   * Positioning is instant and engine-first: the controller emits scrollTop
   * corrections on every scroll event, and a direct write cancels an
   * in-flight smooth animation — so smooth scrolling can never finish here.
   */
  const revealMatch = useCallback(
    (target: ActiveMatch) => {
      activeRef.current = target;
      // Cooperate with the engine so its anchor/correction state follows.
      scrollToRowRef.current(target.rowId);

      const element = rowElementsRef.current.get(target.rowId);
      if (element?.isConnected) {
        const ranges = findTranscriptMatches(element, queryRef.current);
        if (ranges.length > 0) {
          scrollTranscriptMatchIntoView(
            ranges[Math.min(target.localIndex, ranges.length - 1)],
            "auto",
          );
        }
        return;
      }

      // Unmounted: the row is on its way into the window; the tick finishes
      // the jump once it registers.
      pendingNavigationRef.current = target;
      pendingNavigationTimerRef.current = window.setTimeout(() => {
        clearPendingNavigation();
      }, PENDING_NAVIGATION_TIMEOUT_MS);
    },
    [clearPendingNavigation],
  );

  /**
   * The single convergence point: refresh mounted-row text, resolve pending
   * navigation, derive counts and totals, paint mounted ranges, queue
   * harvesting for missing rows, emit the snapshot.
   */
  const runTick = useCallback(() => {
    const query = queryRef.current;
    if (!query) {
      if (paintedRef.current) {
        clearTranscriptSearchHighlights();
        paintedRef.current = false;
      }
      setHarvestRequests((previous) => (previous.length > 0 ? [] : previous));
      emitSnapshot(EMPTY_SNAPSHOT);
      return;
    }

    // Mounted rows are the cheap, authoritative source — refresh in place.
    const currentRows = rowsRef.current;
    const rowById = new Map(currentRows.map((row) => [row.rowId, row]));
    for (const [rowId, element] of rowElementsRef.current) {
      const row = rowById.get(rowId);
      if (!row || !element.isConnected || !isSearchableRow(row)) {
        continue;
      }
      textCacheRef.current.set(rowId, {
        revision: row.renderRevision,
        text: collectTranscriptSearchText(element),
      });
      countCacheRef.current.delete(rowId);
    }

    // Resolve a navigation that was waiting for its row to mount.
    const pending = pendingNavigationRef.current;
    if (pending) {
      const element = rowElementsRef.current.get(pending.rowId);
      if (element?.isConnected) {
        const ranges = findTranscriptMatches(element, query);
        if (ranges.length > 0) {
          const range = ranges[Math.min(pending.localIndex, ranges.length - 1)];
          scrollTranscriptMatchIntoView(range, "auto");
        }
        activeRef.current = pending;
        clearPendingNavigation();
      }
    }

    // Counts, totals, and paint, in row order.
    let total = 0;
    let indexing = false;
    const paintedRanges: Range[] = [];
    let activePaintIndex = -1;
    const active = activeRef.current;
    const missingHarvest: TranscriptRowDescriptor[] = [];

    for (const row of currentRows) {
      if (!isSearchableRow(row)) {
        continue;
      }

      const element = rowElementsRef.current.get(row.rowId);
      const mounted = Boolean(element?.isConnected);
      const cached = textCacheRef.current.get(row.rowId);
      const isFresh = cached?.revision === row.renderRevision;
      if (!isFresh && !mounted) {
        indexing = true;
        if (missingHarvest.length < HARVEST_BATCH_SIZE) {
          missingHarvest.push(row);
        }
        continue;
      }

      const count = rowCount(row);
      if (count === 0) {
        continue;
      }
      total += count;

      if (mounted && element) {
        const ranges = findTranscriptMatches(element, query);
        if (active?.rowId === row.rowId && ranges.length > 0) {
          activePaintIndex =
            paintedRanges.length +
            Math.min(active.localIndex, ranges.length - 1);
        }
        paintedRanges.push(...ranges);
      }
    }

    // The query was typed while parts of the transcript were unindexed; once
    // the index converges, anchor at the transcript-order first match like
    // native find-in-page. (Anchoring earlier would lock onto whatever
    // happened to be mounted — usually the bottom of the chat.)
    if (
      !indexing &&
      total > 0 &&
      activeRef.current === null &&
      pendingNavigationRef.current === null
    ) {
      const first = locateOrdinal(0);
      if (first) {
        revealMatch(first);
        // Repaint with the active match on the next tick.
        requestTickRef.current?.();
      }
    }

    paintTranscriptSearchHighlights(paintedRanges, activePaintIndex);
    paintedRef.current = true;

    setHarvestRequests((previous) => {
      if (
        previous.length === missingHarvest.length &&
        previous.every(
          (row, index) =>
            row.rowId === missingHarvest[index]?.rowId &&
            row.renderRevision === missingHarvest[index]?.renderRevision,
        )
      ) {
        return previous;
      }
      return missingHarvest;
    });

    emitSnapshot({
      total,
      activeOrdinal: ordinalOf(activeRef.current),
      indexing,
    });
  }, [
    clearPendingNavigation,
    emitSnapshot,
    locateOrdinal,
    ordinalOf,
    revealMatch,
    rowCount,
  ]);

  const tickFrameRef = useRef<number | null>(null);
  const tickTrailingRef = useRef<number | null>(null);
  const lastTickAtRef = useRef(0);
  const runTickRef = useRef(runTick);
  runTickRef.current = runTick;

  const requestTick = useCallback(() => {
    if (tickFrameRef.current !== null || tickTrailingRef.current !== null) {
      return;
    }

    const fire = () => {
      tickFrameRef.current = requestAnimationFrame(() => {
        tickFrameRef.current = null;
        lastTickAtRef.current = performance.now();
        runTickRef.current();
      });
    };

    const wait =
      TICK_MIN_INTERVAL_MS - (performance.now() - lastTickAtRef.current);
    if (wait > 0) {
      tickTrailingRef.current = window.setTimeout(() => {
        tickTrailingRef.current = null;
        fire();
      }, wait);
      return;
    }
    fire();
  }, []);

  requestTickRef.current = requestTick;

  useEffect(() => {
    if (!rowStateProvider) return;
    return rowStateProvider.registry.subscribeToStateChanges(() => {
      textCacheRef.current.clear();
      countCacheRef.current.clear();
      if (queryRef.current) requestTick();
    });
  }, [requestTick, rowStateProvider]);

  useEffect(
    () => () => {
      if (tickFrameRef.current !== null) {
        cancelAnimationFrame(tickFrameRef.current);
      }
      if (tickTrailingRef.current !== null) {
        window.clearTimeout(tickTrailingRef.current);
      }
      if (pendingNavigationTimerRef.current !== null) {
        window.clearTimeout(pendingNavigationTimerRef.current);
      }
    },
    [],
  );

  const registerRowElement = useCallback(
    (rowId: string, element: HTMLElement | null) => {
      if (element) {
        rowElementsRef.current.set(rowId, element);
        // A pending navigation may be waiting exactly for this row.
        if (queryRef.current && pendingNavigationRef.current?.rowId === rowId) {
          requestTick();
        }
      } else {
        rowElementsRef.current.delete(rowId);
      }
    },
    [requestTick],
  );

  // Streaming/projection changes invalidate per-row state lazily (revision
  // mismatch) — just re-tick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows is the re-tick trigger; the tick reads it through rowsRef.
  useEffect(() => {
    if (queryRef.current) {
      requestTick();
    }
  }, [rows, requestTick]);

  // Mounted-row content can settle asynchronously (code highlighting, images)
  // without a row revision change; observe the live list for drift.
  useEffect(() => {
    const root = listRootRef.current;
    if (!root || typeof MutationObserver === "undefined") {
      return;
    }

    const observer = new MutationObserver(() => {
      if (queryRef.current) {
        requestTick();
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [listRootRef, requestTick]);

  const navigate = useCallback(
    (direction: 1 | -1) => {
      const total = snapshotRef.current.total;
      if (total === 0) {
        return;
      }

      const current = ordinalOf(activeRef.current);
      const next =
        current < 0
          ? direction === 1
            ? 0
            : total - 1
          : (current + direction + total) % total;
      const target = locateOrdinal(next);
      if (!target) {
        return;
      }

      clearPendingNavigation();
      revealMatch(target);
      runTickRef.current();
    },
    [clearPendingNavigation, locateOrdinal, ordinalOf, revealMatch],
  );

  // Anchoring/revealing the first match is the tick's job (it waits for the
  // index to converge), not setQuery's — see the auto-anchor in runTick.
  const setQuery = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      queryRef.current = trimmed;
      countCacheRef.current.clear();
      activeRef.current = null;
      clearPendingNavigation();
      runTickRef.current();
    },
    [clearPendingNavigation],
  );

  const clear = useCallback(() => {
    queryRef.current = "";
    countCacheRef.current.clear();
    activeRef.current = null;
    clearPendingNavigation();
    runTickRef.current();
  }, [clearPendingNavigation]);

  const backend = useMemo<TranscriptSearchBackend>(
    () => ({
      setQuery,
      navigate,
      clear,
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
      getSnapshot: () => snapshotRef.current,
    }),
    [clear, navigate, setQuery],
  );

  useEffect(() => {
    if (!backendRef) {
      return;
    }

    backendRef.current = backend;
    return () => {
      if (backendRef.current === backend) {
        backendRef.current = null;
      }
    };
  }, [backend, backendRef]);

  // The highlight registry is document-global; never leak past unmount.
  useEffect(() => clearTranscriptSearchHighlights, []);

  const handleHarvested = useCallback(
    (rowId: string, revision: string, text: string) => {
      textCacheRef.current.set(rowId, { revision, text });
      countCacheRef.current.delete(rowId);
      requestTick();
    },
    [requestTick],
  );

  const harvestHost = (
    <TranscriptSearchHarvestHost
      requests={harvestRequests}
      messageByRowId={messageByRowId}
      rowStateProvider={rowStateProvider}
      onHarvested={handleHarvested}
    />
  );

  return { registerRowElement, harvestHost };
}

interface TranscriptSearchHarvestHostProps {
  requests: readonly TranscriptRowDescriptor[];
  messageByRowId: ReadonlyMap<string, Message>;
  rowStateProvider?: TranscriptVirtualRowStateProviderConfig;
  onHarvested: (rowId: string, revision: string, text: string) => void;
}

/**
 * Renders unmounted rows offscreen — through the real message renderer — and
 * harvests their searchable text. The host collapses to zero height and clips
 * overflow; visibility or display hiding would (correctly) make the collector
 * treat the content as unrendered. Each batch is released after its DOM
 * settles, so async content (code highlighting) lands in the harvested text.
 */
export function TranscriptSearchHarvestHost({
  requests,
  messageByRowId,
  rowStateProvider,
  onHarvested,
}: TranscriptSearchHarvestHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || requests.length === 0) {
      return;
    }

    let cancelled = false;
    let frame: number | null = null;
    let timer: number | null = null;
    let sawMutation = false;
    const startedAt = performance.now();

    const observer =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            sawMutation = true;
          });
    observer?.observe(host, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    const harvest = () => {
      if (cancelled) {
        return;
      }
      for (const wrapper of host.querySelectorAll<HTMLElement>(
        "[data-harvest-row-id]",
      )) {
        const rowId = wrapper.dataset.harvestRowId;
        const revision = wrapper.dataset.harvestRowRevision;
        if (!rowId || revision == null) {
          continue;
        }
        onHarvested(rowId, revision, collectTranscriptSearchText(wrapper));
      }
    };

    const settle = () => {
      if (cancelled) {
        return;
      }
      const timedOut = performance.now() - startedAt >= HARVEST_SETTLE_MAX_MS;
      if (!sawMutation || timedOut) {
        harvest();
        return;
      }
      sawMutation = false;
      frame = requestAnimationFrame(settle);
    };

    // First check on the next frame so the initial async kick-offs (e.g.
    // code highlighting) have a chance to mutate before the batch is
    // considered quiet.
    timer = window.setTimeout(() => {
      frame = requestAnimationFrame(settle);
    }, 16);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [requests, onHarvested]);

  if (requests.length === 0) {
    return null;
  }

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-testid="transcript-search-harvest-host"
      style={{
        contain: "layout style",
        // Searchable content must remain rendered, but its height must never
        // extend the transcript's scroll range.
        height: 0,
        insetInlineStart: 0,
        overflow: "clip",
        pointerEvents: "none",
        position: "absolute",
        top: 0,
        width: "100%",
      }}
    >
      {requests.map((row) => {
        const message = messageByRowId.get(row.rowId);
        if (!isSearchableRow(row) || !message) {
          // Unsearchable rows still get a harvest entry so the index stops
          // treating them as missing.
          return (
            <div
              key={`${row.rowId}:${row.renderRevision}`}
              data-harvest-row-id={row.rowId}
              data-harvest-row-revision={row.renderRevision}
            />
          );
        }

        return (
          <div
            key={`${row.rowId}:${row.renderRevision}`}
            data-harvest-row-id={row.rowId}
            data-harvest-row-revision={row.renderRevision}
          >
            {rowStateProvider ? (
              <TranscriptRowStateProvider
                registry={rowStateProvider.registry}
                sessionId={rowStateProvider.sessionId}
                sessionEpoch={rowStateProvider.sessionEpoch}
                rowId={row.rowId}
                onRowStateChange={rowStateProvider.onRowStateChange}
              >
                <MessageBubble
                  message={message}
                  contentOverride={row.fragment?.content}
                  fragmentRole={row.fragment?.role}
                />
              </TranscriptRowStateProvider>
            ) : (
              <MessageBubble
                message={message}
                contentOverride={row.fragment?.content}
                fragmentRole={row.fragment?.role}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
