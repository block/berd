import { mergeAcpSessionPage } from "@/features/chat/lib/acpSessionMapping";
import {
  compareSessionsByActivityDesc,
  sessionActivityAt,
} from "@/features/chat/lib/sessionActivity";
import {
  type ChatSession,
  type ChatSessionStore,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import {
  type AcpSessionInfo,
  type AcpSessionsPage,
  acpGetSessionInfo,
  acpListSessionsPage,
} from "@/shared/api/acp";
import { isCompositeSessionId } from "@/shared/api/acpBackendId";
import { berdctlErrorDetail } from "../helpers";
import { CommandError } from "../types";

const MS_PER_SECOND = 1000;
/** A local getSessionInfo is one indexed row read; past this, page instead. */
const CACHED_SESSION_PROBE_TIMEOUT_MS = 1000;

/** Progress after each session/list page has been merged into the store. */
interface SessionListScanProgress {
  /** Ids returned by session/list in this scan; their store rows are fresh. */
  seenSessionIds: ReadonlySet<string>;
  /** Lowest activity second read so far. Unread rows sort at or below it. */
  oldestSeenActivitySecond: number | null;
  /** False once a page row sorted newer than an earlier row, which means
   *  the backend order no longer bounds the unread rows. */
  isBackendOrderMonotonic: boolean;
  /** True once session/list returned its last page. */
  isComplete: boolean;
}

interface SessionListScanOptions {
  /** Broker deadline (ms epoch); no page is requested after it. */
  deadlineMs?: number;
}

interface ListSessionsOptions extends SessionListScanOptions {
  matches: (session: ChatSession) => boolean;
  limit: number;
}

/** Fresh info for a cached row the scan has not read; null when
 *  getSessionInfo could not confirm it. Goose reports any lookup failure as
 *  not-found, so a missing row is unconfirmed rather than absent. */
type CachedSessionCheck = AcpSessionInfo | null;

/**
 * Return the first `limit` sessions matching `matches`, newest first,
 * requesting only as many session/list pages as that answer needs.
 *
 * The result equals filtering the store, newest first, after reading every
 * page. Pages arrive newest-first, so once `limit` matches sort strictly
 * newer than the oldest row read, no unread row can displace them. A cached
 * row this scan has not read may be stale; it counts only when
 * getSessionInfo shows that session/list would already have returned it if
 * it listed it at all.
 */
export async function listSessionsForBerdctl({
  matches,
  limit,
  deadlineMs,
}: ListSessionsOptions): Promise<ChatSession[]> {
  const cachedSessionChecks = new Map<string, CachedSessionCheck>();
  for await (const progress of scanSessionList({ deadlineMs })) {
    if (progress.isComplete) {
      return sessionsByActivity().filter(matches).slice(0, limit);
    }
    const settledMatches = await findSettledFirstMatches(progress, {
      matches,
      limit,
      deadlineMs,
      cachedSessionChecks,
    });
    if (settledMatches) {
      return settledMatches;
    }
  }
  throw new Error("session list scan ended without completing");
}

/** Read every session/list page into the store. */
export async function loadAllSessionsForBerdctl({
  deadlineMs,
}: SessionListScanOptions = {}): Promise<void> {
  for await (const progress of scanSessionList({ deadlineMs })) {
    if (progress.isComplete) {
      return;
    }
  }
}

async function findSettledFirstMatches(
  progress: SessionListScanProgress,
  options: ListSessionsOptions & {
    cachedSessionChecks: Map<string, CachedSessionCheck>;
  },
): Promise<ChatSession[] | null> {
  const boundarySecond = progress.oldestSeenActivitySecond;
  if (!progress.isBackendOrderMonotonic || boundarySecond === null) {
    return null;
  }

  // Recompute after each lookup: the store can change while one is pending.
  for (;;) {
    // Rows tied with the boundary second may be outranked by unread rows.
    const firstMatches = sessionsByActivity()
      .filter((session) => activitySecond(session) > boundarySecond)
      .filter(options.matches)
      .slice(0, options.limit);
    if (firstMatches.length < options.limit) {
      return null;
    }

    const unreadMatches = firstMatches.filter(
      (session) => !progress.seenSessionIds.has(session.id),
    );
    const hasUnsettledMatch = unreadMatches.some(
      (session) =>
        options.cachedSessionChecks.has(session.id) &&
        !isOutsideSessionList(
          options.cachedSessionChecks.get(session.id) ?? null,
          boundarySecond,
        ),
    );
    if (hasUnsettledMatch) {
      return null;
    }

    const uncheckedMatch = unreadMatches.find(
      (session) => !options.cachedSessionChecks.has(session.id),
    );
    if (!uncheckedMatch) {
      return firstMatches;
    }
    await checkCachedSession(uncheckedMatch, options);
  }
}

/**
 * A cached row session/list does not return keeps its store position after
 * a full read, so it can be listed without reading further. Fresh activity
 * newer than the boundary proves that: a listed row that new would already
 * have been read. Anything else may still move or change on a later page.
 */
function isOutsideSessionList(
  check: CachedSessionCheck,
  boundarySecond: number,
): boolean {
  return check !== null && activitySecond(check) > boundarySecond;
}

async function checkCachedSession(
  session: ChatSession,
  {
    deadlineMs,
    cachedSessionChecks,
  }: SessionListScanOptions & {
    cachedSessionChecks: Map<string, CachedSessionCheck>;
  },
): Promise<void> {
  throwIfPastDeadline(deadlineMs);
  // Remote rows are never in the local list. Probing them could reconnect a
  // host (and restart its daemon), so leave them unconfirmed and keep paging.
  const isLocalSession =
    !session.remoteHost && !isCompositeSessionId(session.id);
  const check = isLocalSession
    ? await readSessionInfoWithin(session.id, probeBudgetMs(deadlineMs))
    : null;
  cachedSessionChecks.set(session.id, check);
}

function probeBudgetMs(deadlineMs: number | undefined): number {
  if (deadlineMs == null) {
    return CACHED_SESSION_PROBE_TIMEOUT_MS;
  }
  return Math.min(CACHED_SESSION_PROBE_TIMEOUT_MS, deadlineMs - Date.now());
}

/** getSessionInfo, or null when it fails or outlasts `budgetMs`. A late
 *  lookup cannot be cancelled; it settles on its own and is ignored. */
async function readSessionInfoWithin(
  sessionId: string,
  budgetMs: number,
): Promise<AcpSessionInfo | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.race([
      acpGetSessionInfo(sessionId).catch(() => null),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Page session/list into the shared store, yielding after each page. Stops
 * requesting pages when the consumer stops iterating or the list ends, and
 * throws when a cursor repeats or the deadline passes. A page already in
 * flight at the deadline is not cancelled; its rows are still merged.
 */
async function* scanSessionList({
  deadlineMs,
}: SessionListScanOptions): AsyncGenerator<SessionListScanProgress> {
  const seenSessionIds = new Set<string>();
  const visitedCursors = new Set<string>();
  const progress: SessionListScanProgress = {
    seenSessionIds,
    oldestSeenActivitySecond: null,
    isBackendOrderMonotonic: true,
    isComplete: false,
  };
  let previousActivitySecond: number | null = null;
  let cursor: string | null = null;

  for (;;) {
    throwIfPastDeadline(deadlineMs);
    const page = await readSessionListPage(cursor);
    mergePageIntoStore(page, cursor);

    for (const session of page.sessions) {
      seenSessionIds.add(session.sessionId);
      const second = activitySecond(session);
      if (!Number.isFinite(second)) {
        continue;
      }
      if (previousActivitySecond !== null && second > previousActivitySecond) {
        progress.isBackendOrderMonotonic = false;
      }
      previousActivitySecond = second;
      progress.oldestSeenActivitySecond = Math.min(
        progress.oldestSeenActivitySecond ?? second,
        second,
      );
    }

    const nextCursor = page.nextCursor;
    if (nextCursor === null) {
      progress.isComplete = true;
      yield progress;
      return;
    }
    // A revisited cursor would loop forever, and stopping there would pass
    // off a partial read as the whole list.
    if (visitedCursors.has(nextCursor)) {
      throw new CommandError(
        "backend_read_failed",
        "The app backend repeated a session list page cursor, so the session list could not be read completely.",
      );
    }

    visitedCursors.add(nextCursor);
    yield progress;
    cursor = nextCursor;
  }
}

async function readSessionListPage(
  cursor: string | null,
): Promise<AcpSessionsPage> {
  try {
    return await acpListSessionsPage({ cursor });
  } catch (error) {
    throw new CommandError(
      "backend_read_failed",
      `Failed to read sessions from the app backend: ${berdctlErrorDetail(error)}`,
    );
  }
}

/**
 * Merge rows into the shared store. The shared pagination cursor advances
 * only when the store was waiting on this exact page, so a scan never
 * rewinds or skips the sidebar's own "load more" position.
 */
function mergePageIntoStore(
  page: AcpSessionsPage,
  requestCursor: string | null,
): void {
  useChatSessionStore.setState((state) => {
    const merged = mergeAcpSessionPage(state, page, requestCursor);
    if (isStoreWaitingOnPage(state, requestCursor)) {
      return { ...merged, hasHydratedSessions: true };
    }
    return {
      sessions: merged.sessions,
      archiveMutationBySessionId: merged.archiveMutationBySessionId,
      hasHydratedSessions: true,
    };
  });
}

/** A store without a cursor waits on the first page unless it read the
 *  list to its end; a failed or never-run sidebar load leaves no cursor too. */
function isStoreWaitingOnPage(
  state: Pick<
    ChatSessionStore,
    "sessionPageCursor" | "hasReachedSessionListEnd"
  >,
  requestCursor: string | null,
): boolean {
  if (state.sessionPageCursor !== requestCursor) {
    return false;
  }
  return requestCursor !== null || !state.hasReachedSessionListEnd;
}

function throwIfPastDeadline(deadlineMs: number | undefined): void {
  if (deadlineMs != null && Date.now() >= deadlineMs) {
    throw new CommandError(
      "timed_out",
      "Reading sessions took longer than the command timeout; stopped requesting more pages. Retry with a larger --timeout-ms.",
    );
  }
}

/** Store sessions newest first. Page merges sort the store, but local
 *  patches (a draft's first message, say) change activity in place. */
function sessionsByActivity(): ChatSession[] {
  return [...useChatSessionStore.getState().sessions].sort(
    compareSessionsByActivityDesc,
  );
}

/** Whole-second activity time; NaN when the row has no parseable time.
 *  Goose sorts session/list by whole seconds, so finer precision cannot
 *  separate a read row from an unread one. */
function activitySecond(session: {
  lastMessageAt?: string | null;
  updatedAt: string | null;
}): number {
  const activityAt = sessionActivityAt({
    lastMessageAt: session.lastMessageAt,
    updatedAt: session.updatedAt ?? "",
  });
  return Math.floor(Date.parse(activityAt) / MS_PER_SECOND);
}
