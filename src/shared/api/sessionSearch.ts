import type { QueryClient } from "@tanstack/react-query";
import { exportSession } from "./acpApi";

const SNIPPET_PREFIX = 40;
const SNIPPET_SUFFIX = 60;

/** Concurrent exports per sweep. Workers claim targets in list order, so a
 *  cache hit queued behind a full pool waits for the first slot to free — then
 *  consecutive hits drain through it almost instantly. Left as-is because the
 *  sweep resolves as one batch anyway: pre-resolving hits would not deliver
 *  results any sooner. */
const EXPORT_CONCURRENCY = 4;

const CORPUS_QUERY_KEY_PREFIX = "session-search-corpus";
/**
 * How long a corpus survives after **its export**, not after its last read:
 * react-query schedules the gc timer when a fetch settles and never reschedules
 * it, and a `fetchQuery` cache hit resolves without fetching, so reads do not
 * extend the window. Under the 5-minute default, a search page left open longer
 * than that re-exported every session on the next keystroke. Sized instead to
 * outlast a working session with search open; `evictSupersededCorpora` keeps
 * the longer window from accumulating dead stamps, so the retained set is one
 * corpus per session swept within the window.
 */
const CORPUS_GC_TIME_MS = 30 * 60 * 1000;

type MessageRole = "user" | "assistant" | "system";

const SEARCHABLE_ROLES = new Set<MessageRole>(["user", "assistant", "system"]);

const SEARCHABLE_BLOCK_TYPES = new Set([
  "text",
  "input_text",
  "output_text",
  "systemNotification",
  "system_notification",
]);

const SKIPPED_BLOCK_TYPES = new Set([
  "toolRequest",
  "toolResponse",
  "thinking",
  "redactedThinking",
  "reasoning",
  "image",
]);

export interface SessionSearchResult {
  sessionId: string;
  snippet: string;
  messageId: string;
  messageRole?: MessageRole;
  matchCount: number;
}

/**
 * A sweep's matches plus which targets it actually managed to read.
 *
 * Coverage is reported rather than implied because a corpus export can fail for
 * one session while the sweep as a whole resolves: without `failedIds` a caller
 * cannot tell "no match" from "never looked", and would claim it searched
 * conversation text it never saw.
 */
export interface SessionSearchSweep {
  results: SessionSearchResult[];
  /** Targets whose corpus was read and matched against the query. */
  searchedIds: string[];
  /** Targets whose corpus could not be read; their content is unsearched. */
  failedIds: string[];
}

interface ParsedMessage {
  id: string;
  role: MessageRole | null;
  texts: string[];
}

export interface SessionSearchTarget {
  id: string;
  /** Session version; embedded in the corpus cache key so a changed session
   *  re-exports on the next sweep while unchanged ones stay cache hits. */
  stamp: string;
}

/**
 * Version stamp for a session's searchable content, from fields the session
 * store already tracks (`session_info_update` patches all three, and the
 * periodic session-list refresh covers changes made while no notification was
 * flowing).
 */
export function sessionSearchStamp(session: {
  updatedAt: string;
  messageCount: number;
  lastMessageAt?: string;
}): string {
  return `${session.updatedAt}:${session.messageCount}:${session.lastMessageAt ?? ""}`;
}

export interface SessionSearchOptions {
  /** Routes corpus fetches through react-query so sweeps (and simultaneous
   *  consumers — search page, Cmd-K dialog, history) share one export per
   *  (session, stamp). Absent, every sweep re-exports. */
  queryClient?: QueryClient;
}

export async function searchSessionsViaExports(
  query: string,
  targets: SessionSearchTarget[],
  options: SessionSearchOptions = {},
): Promise<SessionSearchSweep> {
  const trimmed = query.trim();
  if (!trimmed) return { results: [], searchedIds: [], failedIds: [] };

  const seenIds = new Set<string>();
  const unique: SessionSearchTarget[] = [];
  for (const target of targets) {
    if (seenIds.has(target.id)) continue;
    seenIds.add(target.id);
    unique.push(target);
  }

  const results: (SessionSearchResult | null)[] = unique.map(() => null);
  // Per-target coverage, kept positionally so concurrent workers never race:
  // a slot is written only by the worker that claimed that index.
  const failed: boolean[] = unique.map(() => false);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < unique.length) {
      const index = nextIndex;
      nextIndex += 1;
      const target = unique[index];
      try {
        const messages = await fetchCorpus(target, options.queryClient);
        results[index] = searchSession(target.id, messages, trimmed);
      } catch {
        // A session whose corpus cannot be read is not a session without
        // matches. Record it so callers can say so instead of counting it as
        // searched and turning a read failure into a confident "no match".
        failed[index] = true;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(EXPORT_CONCURRENCY, unique.length) }, worker),
  );

  if (options.queryClient) evictSupersededCorpora(options.queryClient, unique);

  return {
    results: results.filter(
      (result): result is SessionSearchResult => result !== null,
    ),
    searchedIds: unique
      .filter((_, index) => !failed[index])
      .map((target) => target.id),
    failedIds: unique
      .filter((_, index) => failed[index])
      .map((target) => target.id),
  };
}

/**
 * Drops the corpora of stamps this sweep superseded. Once a session's stamp
 * changes nothing will ever read its old corpus again, so leaving it to gc
 * holds the text of every intermediate version of a chatty session for the
 * whole window. Corpora for sessions outside this sweep are left alone: the
 * search page and the Cmd-K dialog sweep different lists and share entries.
 */
function evictSupersededCorpora(
  queryClient: QueryClient,
  targets: SessionSearchTarget[],
): void {
  const stampById = new Map(targets.map((target) => [target.id, target.stamp]));
  queryClient.removeQueries({
    queryKey: [CORPUS_QUERY_KEY_PREFIX],
    predicate: (query) => {
      // Never yank an entry mid-export: removal cancels the fetch, and a
      // concurrent sweep holding a slightly older session object may be the
      // one awaiting it.
      if (query.state.fetchStatus !== "idle") return false;
      const [, id, stamp] = query.queryKey as [string, string, string];
      const currentStamp = stampById.get(id);
      return currentStamp !== undefined && currentStamp !== stamp;
    },
  });
}

/**
 * The flattened corpus is cached instead of the raw export JSON deliberately:
 * `flattenMessages` drops tool results, thinking, and images — the bulk of a
 * long session — so the cached value is far smaller than the export and
 * per-keystroke matching is pure CPU against it.
 */
function fetchCorpus(
  target: SessionSearchTarget,
  queryClient: QueryClient | undefined,
): Promise<ParsedMessage[]> {
  if (!queryClient) return exportCorpus(target.id);
  return queryClient.fetchQuery({
    queryKey: [CORPUS_QUERY_KEY_PREFIX, target.id, target.stamp],
    queryFn: () => exportCorpus(target.id),
    // The key embeds the session version, so an entry is never stale by
    // definition — and nothing invalidates this key, so a corpus is pinned to
    // its stamp until the stamp changes or it is evicted. That is safe because
    // the stamp cannot run ahead of the export: goose derives both
    // `messageCount` (`COUNT(m.id)`) and `lastMessageAt` (`MAX(...)` over
    // message timestamps) from the persisted messages table, and notifies
    // after the write, so a stamp the store has seen implies the export
    // already contains that message.
    // `retry: false` keeps a failed export uncached (error state holds no
    // data), so the next sweep retries it instead of treating the session as
    // an empty corpus.
    staleTime: Infinity,
    gcTime: CORPUS_GC_TIME_MS,
    retry: false,
  });
}

async function exportCorpus(sessionId: string): Promise<ParsedMessage[]> {
  const exported = await exportSession(sessionId);
  const root = safeParse(exported);
  if (!root) return [];
  const conversation = root.conversation ?? root.messages;
  if (!conversation) return [];
  return flattenMessages(conversation, false);
}

function searchSession(
  sessionId: string,
  messages: ParsedMessage[],
  query: string,
): SessionSearchResult | null {
  if (!messages.length) return null;

  let firstMatch: {
    messageId: string;
    role: MessageRole | null;
    snippet: string;
  } | null = null;
  let matchCount = 0;

  for (const msg of messages) {
    for (const text of msg.texts) {
      const count = countMatches(text, query);
      if (!count) continue;
      matchCount += count;
      firstMatch ??= {
        messageId: msg.id,
        role: msg.role,
        snippet: buildSnippet(text, query),
      };
    }
  }

  if (!firstMatch) return null;

  return {
    sessionId,
    snippet: firstMatch.snippet,
    messageId: firstMatch.messageId,
    messageRole: firstMatch.role ?? undefined,
    matchCount,
  };
}

export interface ExportedSessionMessage {
  role: MessageRole | null;
  text: string;
}

/**
 * The last `limit` text-bearing messages of a session, read via export so it
 * works without loading the session into the UI. Unlike search (which scans
 * broadly and only ever returns a snippet), this hands full message bodies to
 * another agent, so block types are ALLOWLISTED: anything not an explicitly
 * known plain-text type (tool output, thinking, future provider blocks) is
 * dropped rather than leaked.
 */
export async function lastSessionMessages(
  sessionId: string,
  limit: number,
): Promise<ExportedSessionMessage[]> {
  const exported = await exportSession(sessionId);
  const root = safeParse(exported);
  if (!root) return [];
  const conversation = root.conversation ?? root.messages;
  if (!conversation) return [];
  return flattenMessages(conversation, true)
    .slice(-limit)
    .map((msg) => ({ role: msg.role, text: msg.texts.join("\n") }));
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function flattenMessages(
  value: unknown,
  strictTypes: boolean,
): ParsedMessage[] {
  if (Array.isArray(value))
    return value.flatMap((entry) => flattenMessages(entry, strictTypes));
  if (!isObject(value)) return [];

  if ("message" in value) return flattenMessages(value.message, strictTypes);
  if ("messages" in value) return flattenMessages(value.messages, strictTypes);

  const msg = tryParseMessage(value, strictTypes);
  return msg ? [msg] : [];
}

function tryParseMessage(
  obj: Record<string, unknown>,
  strictTypes: boolean,
): ParsedMessage | null {
  if (!("role" in obj) || !("content" in obj || "text" in obj)) return null;
  if (isUserHiddenMessage(obj)) return null;

  const role = toRole(obj.role);
  const texts =
    obj.content !== undefined
      ? getSearchableTexts(obj.content, role, strictTypes)
      : typeof obj.text === "string" && role && obj.text.trim()
        ? [obj.text.trim()]
        : [];

  if (!texts.length) return null;

  return {
    id: typeof obj.id === "string" ? obj.id : crypto.randomUUID(),
    role,
    texts,
  };
}

function isUserHiddenMessage(obj: Record<string, unknown>): boolean {
  const metadata = obj.metadata;
  return (
    isObject(metadata) &&
    (metadata.user_visible === false || metadata.userVisible === false)
  );
}

function getSearchableTexts(
  value: unknown,
  role: MessageRole | null,
  strictTypes: boolean,
): string[] {
  if (typeof value === "string") {
    return role && SEARCHABLE_ROLES.has(role) && value.trim()
      ? [value.trim()]
      : [];
  }
  if (Array.isArray(value))
    return value.flatMap((v) => getBlockText(v, role, strictTypes));
  if (isObject(value)) return getBlockText(value, role, strictTypes);
  return [];
}

function getBlockText(
  value: unknown,
  role: MessageRole | null,
  strictTypes: boolean,
): string[] {
  if (!isObject(value)) return [];
  const type = value.type as string | undefined;
  const text = (value.text as string | undefined)?.trim();
  if (!text) return [];

  if (SKIPPED_BLOCK_TYPES.has(type ?? "")) return [];
  if (SEARCHABLE_BLOCK_TYPES.has(type ?? "")) return [text];
  // Unknown block types: search may scan them (only a snippet ever leaves the
  // app), but strict consumers hand full bodies to another agent and must not
  // leak block types we have not classified.
  if (strictTypes) return [];
  return role && SEARCHABLE_ROLES.has(role) ? [text] : [];
}

function toRole(value: unknown): MessageRole | null {
  if (typeof value !== "string") return null;
  const r = value.trim().toLowerCase();
  return SEARCHABLE_ROLES.has(r as MessageRole) ? (r as MessageRole) : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countMatches(text: string, query: string): number {
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 0;

  let count = 0;
  let pos = hay.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = hay.indexOf(needle, pos + needle.length);
  }
  return count;
}

function buildSnippet(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  const at = idx >= 0 ? idx : 0;
  const start = Math.max(0, at - SNIPPET_PREFIX);
  const end = Math.min(text.length, at + query.length + SNIPPET_SUFFIX);

  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.substring(start, end).trim()}${suffix}`;
}
