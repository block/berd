import {
  compositeSessionId,
  LOCAL_BACKEND_ID,
  type AcpBackendId,
} from "./acpBackendId";
import { invoke } from "@tauri-apps/api/core";
import { formatAcpErrorMessage } from "./acpErrors";
import { exportSession, listSessionsPage, type AcpSessionInfo } from "./acpApi";
import { originalLowercaseOffset } from "@/shared/lib/lowercaseOffset";

export type MessageSearchScope = "active" | "all" | "archived";
export interface MessageSearchMatch {
  sessionId: string;
  title: string;
  archivedAt: string | null;
  workingDir: string;
  updatedAt: string;
  /** Latest visible session activity; metadata edits do not move old chats. */
  lastMessageAt?: string | null;
  messageCreatedAt: string;
  messageId: string;
  /** Position among persisted user-visible messages, including tool-only rows. */
  messageIndex: number;
  role: "user" | "assistant";
  snippet: string;
  matchCount: number;
}
export type MessageSearchResult = MessageSearchMatch;
export interface MessageSearchPage {
  matches: MessageSearchMatch[];
  nextCursor: string | null;
  /** False means content was skipped or unreadable. A cursor independently
   * indicates more pages remain before a zero can be authoritative. */
  complete: boolean;
}
export interface MessageSearchRequest {
  query: string;
  scope?: MessageSearchScope;
  cursor?: string | null;
  limit?: number;
  workingDir?: string;
  types?: ("user" | "scheduled" | "acp")[];
  backendId?: AcpBackendId;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// Berd owns its local index. Remote and unavailable local sources use bounded
// ACP list/export reads; neither path runs an agent or changes session data.
const FALLBACK_PREFIX = "message-export:";
const MAX_EXPORTS_PER_PAGE = 20;
const MAX_EXPORT_CHARS = 4_000_000;
const MAX_MESSAGES_PER_EXPORT = 20_000;
const DEFAULT_FALLBACK_TIMEOUT_MS = 8_000;
// The native index owns a 20-second transactional rebuild deadline. Give its
// typed timeout a chance to arrive before the renderer stops waiting.
const DEFAULT_LOCAL_TIMEOUT_MS = 21_000;

export class MessageSearchTimeoutError extends Error {
  constructor() {
    super("Message search timed out");
    this.name = "MessageSearchTimeoutError";
  }
}
function aborted(): Error {
  return new DOMException("Message search cancelled", "AbortError");
}

/** Bounds waiting and prevents cancelled searches from launching more reads.
 * ACP does not expose per-request cancellation for these read-only methods. */
async function bounded<T>(
  operation: () => Promise<T>,
  request: MessageSearchRequest,
  deadline: number,
): Promise<T> {
  if (request.signal?.aborted) throw aborted();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new MessageSearchTimeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new MessageSearchTimeoutError()),
          remaining,
        );
        abort = () => reject(aborted());
        request.signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) request.signal?.removeEventListener("abort", abort);
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function unsupported(error: unknown): boolean {
  return (
    (isRecord(error) && error.code === "MESSAGE_SEARCH_SOURCE_UNAVAILABLE") ||
    formatAcpErrorMessage(error, "").startsWith("local_search_unavailable:")
  );
}
function parsePage(value: unknown, backendId: AcpBackendId): MessageSearchPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.matches) ||
    typeof value.complete !== "boolean"
  ) {
    throw new Error("Invalid message search response");
  }
  const matches = value.matches.map((match): MessageSearchMatch => {
    if (
      !isRecord(match) ||
      ![
        "sessionId",
        "title",
        "workingDir",
        "updatedAt",
        "messageCreatedAt",
        "messageId",
        "snippet",
      ].every((key) => typeof match[key] === "string") ||
      !(match.archivedAt === null || typeof match.archivedAt === "string") ||
      !(
        match.lastMessageAt == null || typeof match.lastMessageAt === "string"
      ) ||
      !(match.role === "user" || match.role === "assistant") ||
      !Number.isSafeInteger(match.messageIndex) ||
      Number(match.messageIndex) < 0 ||
      !Number.isSafeInteger(match.matchCount) ||
      Number(match.matchCount) < 1
    ) {
      throw new Error("Invalid message search match");
    }
    return {
      ...(match as unknown as MessageSearchMatch),
      sessionId: compositeSessionId(backendId, match.sessionId as string),
    };
  });
  if (value.nextCursor != null && typeof value.nextCursor !== "string")
    throw new Error("Invalid message search cursor");
  return {
    matches: matches.filter((match) => Boolean(match.messageId)),
    complete:
      value.complete && matches.every((match) => Boolean(match.messageId)),
    nextCursor: (value.nextCursor as string | undefined) || null,
  };
}

export async function searchMessagesPage(
  request: MessageSearchRequest,
): Promise<MessageSearchPage> {
  if (!request.query.trim())
    return { matches: [], nextCursor: null, complete: true };
  const backendId = request.backendId ?? LOCAL_BACKEND_ID;
  const deadline =
    Date.now() +
    (request.timeoutMs ??
      (backendId === LOCAL_BACKEND_ID
        ? DEFAULT_LOCAL_TIMEOUT_MS
        : DEFAULT_FALLBACK_TIMEOUT_MS));
  const limit = Math.min(100, Math.max(1, request.limit ?? 50));
  if (
    backendId === LOCAL_BACKEND_ID &&
    !request.cursor?.startsWith(FALLBACK_PREFIX)
  ) {
    try {
      const response = await bounded(
        async () => {
          if (request.signal?.aborted) throw aborted();
          return invoke("search_session_messages", {
            request: {
              query: request.query.trim(),
              scope: request.scope ?? "active",
              limit,
              ...(request.cursor ? { cursor: request.cursor } : {}),
              ...(request.workingDir ? { workingDir: request.workingDir } : {}),
              ...(request.types?.length ? { types: request.types } : {}),
            },
          });
        },
        request,
        deadline,
      );
      return parsePage(response, backendId);
    } catch (error) {
      // Only an explicit unavailable source permits fallback. Timeouts, malformed
      // replies and storage failures must never become an authoritative zero.
      if (
        formatAcpErrorMessage(error, "").startsWith("message_search_timeout:")
      )
        throw new MessageSearchTimeoutError();
      if (!unsupported(error) || request.cursor) throw error;
    }
  }
  return fallbackPage(
    request,
    limit,
    Math.min(
      deadline,
      Date.now() + (request.timeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS),
    ),
  );
}

interface FallbackCursor {
  key: string;
  listCursor: string | null;
  sessionOffset: number;
  messageOffset: number;
  skipped: boolean;
  pageFingerprint: string | null;
}
function requestKey(request: MessageSearchRequest): string {
  return JSON.stringify([
    request.backendId ?? LOCAL_BACKEND_ID,
    request.query.trim(),
    request.scope ?? "active",
    request.workingDir ?? "",
    [...(request.types ?? [])].sort(),
  ]);
}
function encodeCursor(cursor: FallbackCursor): string {
  return FALLBACK_PREFIX + encodeURIComponent(JSON.stringify(cursor));
}
function decodeCursor(request: MessageSearchRequest): FallbackCursor {
  if (!request.cursor)
    return {
      key: requestKey(request),
      listCursor: null,
      sessionOffset: 0,
      messageOffset: 0,
      skipped: false,
      pageFingerprint: null,
    };
  const value: unknown = JSON.parse(
    decodeURIComponent(request.cursor.slice(FALLBACK_PREFIX.length)),
  );
  if (
    !isRecord(value) ||
    value.key !== requestKey(request) ||
    typeof value.skipped !== "boolean" ||
    !(
      value.pageFingerprint === null ||
      typeof value.pageFingerprint === "string"
    ) ||
    !(value.listCursor === null || typeof value.listCursor === "string") ||
    !Number.isSafeInteger(value.sessionOffset) ||
    Number(value.sessionOffset) < 0 ||
    !Number.isSafeInteger(value.messageOffset) ||
    Number(value.messageOffset) < 0
  )
    throw new Error("Invalid message search cursor");
  return value as unknown as FallbackCursor;
}
function inScope(session: AcpSessionInfo, scope: MessageSearchScope): boolean {
  return (
    scope === "all" ||
    (scope === "archived" ? Boolean(session.archivedAt) : !session.archivedAt)
  );
}
async function fallbackPage(
  request: MessageSearchRequest,
  limit: number,
  deadline: number,
): Promise<MessageSearchPage> {
  const cursor = decodeCursor(request);
  const page = await bounded(
    () =>
      listSessionsPage({
        cursor: cursor.listCursor,
        backendId: request.backendId,
        workingDir: request.workingDir,
        types: request.types,
        includeLastMessageSnippet: false,
      }),
    request,
    deadline,
  );
  if (page.sessions.length > 50)
    throw new Error("Session list exceeded its page bound");
  const pageFingerprint = JSON.stringify(
    page.sessions.map((session) => [
      session.sessionId,
      session.updatedAt,
      session.messageCount,
      session.lastMessageAt,
    ]),
  );
  if (cursor.pageFingerprint && cursor.pageFingerprint !== pageFingerprint)
    throw new Error("Sessions changed during message search; retry the search");
  const matches: MessageSearchMatch[] = [];
  let exports = 0;
  let complete = !cursor.skipped;
  for (
    let index = cursor.sessionOffset;
    index < page.sessions.length;
    index += 1
  ) {
    const session = page.sessions[index];
    if (!inScope(session, request.scope ?? "active")) continue;
    if (exports >= MAX_EXPORTS_PER_PAGE)
      return {
        matches,
        complete,
        nextCursor: encodeCursor({
          ...cursor,
          skipped: !complete,
          pageFingerprint,
          sessionOffset: index,
          messageOffset: 0,
        }),
      };
    exports += 1;
    let exported: string;
    try {
      exported = await bounded(
        () => exportSession(session.sessionId),
        request,
        deadline,
      );
    } catch (error) {
      if (request.signal?.aborted || error instanceof MessageSearchTimeoutError)
        throw error;
      // Return useful matches with an explicit incomplete marker when a single
      // export fails. A fresh search retries those failed reads.
      complete = false;
      continue;
    }
    if (exported.length > MAX_EXPORT_CHARS) {
      complete = false;
      continue;
    }
    let messages: MessageSearchMatch[];
    try {
      const parsed = matchExportedMessages(exported, session, request.query);
      messages = parsed.matches;
      complete &&= parsed.complete;
    } catch {
      complete = false;
      continue;
    }
    const offset = index === cursor.sessionOffset ? cursor.messageOffset : 0;
    for (let message = offset; message < messages.length; message += 1) {
      matches.push(messages[message]);
      if (matches.length === limit) {
        const moreInSession = message + 1 < messages.length;
        const moreInPage = index + 1 < page.sessions.length;
        return {
          matches,
          complete,
          nextCursor:
            moreInSession || moreInPage
              ? encodeCursor({
                  ...cursor,
                  skipped: !complete,
                  pageFingerprint,
                  sessionOffset: moreInSession ? index : index + 1,
                  messageOffset: moreInSession ? message + 1 : 0,
                })
              : page.nextCursor
                ? encodeCursor({
                    ...cursor,
                    skipped: !complete,
                    listCursor: page.nextCursor,
                    pageFingerprint: null,
                    sessionOffset: 0,
                    messageOffset: 0,
                  })
                : null,
        };
      }
    }
  }
  if (page.nextCursor === cursor.listCursor && page.nextCursor)
    throw new Error("Repeated message search pagination cursor");
  return {
    matches,
    complete,
    nextCursor: page.nextCursor
      ? encodeCursor({
          ...cursor,
          skipped: !complete,
          listCursor: page.nextCursor,
          pageFingerprint: null,
          sessionOffset: 0,
          messageOffset: 0,
        })
      : null,
  };
}

/** Strictly allow visible user/assistant plain text. No unknown blocks, system,
 * tool or reasoning content may appear in a message-search excerpt. */
export function matchExportedMessages(
  exported: string,
  session: AcpSessionInfo,
  query: string,
): { matches: MessageSearchMatch[]; complete: boolean } {
  const root: unknown = JSON.parse(exported);
  if (!isRecord(root)) throw new Error("Invalid session export");
  const conversation = root.conversation ?? root.messages;
  const entries = Array.isArray(conversation)
    ? conversation
    : isRecord(conversation) && Array.isArray(conversation.messages)
      ? conversation.messages
      : null;
  if (!entries) throw new Error("Session export has no conversation");
  const needles = [
    ...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean)),
  ];
  const matches: MessageSearchMatch[] = [];
  let messageIndex = -1;
  let skipped = false;
  for (const entry of entries.slice(0, MAX_MESSAGES_PER_EXPORT)) {
    const message =
      isRecord(entry) && isRecord(entry.message) ? entry.message : entry;
    if (!isRecord(message)) continue;
    const metadata = isRecord(message.metadata) ? message.metadata : {};
    if (metadata.userVisible === false || metadata.user_visible === false)
      continue;
    messageIndex += 1;
    if (!(message.role === "user" || message.role === "assistant")) continue;
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : typeof message.text === "string"
            ? [{ type: "text", text: message.text }]
            : [];
    const texts = blocks.flatMap((block) => {
      if (
        !isRecord(block) ||
        block.type !== "text" ||
        typeof block.text !== "string"
      )
        return [];
      const audience = isRecord(block.annotations)
        ? block.annotations.audience
        : null;
      if (
        audience != null &&
        (!Array.isArray(audience) || !audience.includes("user"))
      )
        return [];
      return [block.text];
    });
    const text = texts.join("\n");
    const folded = text.toLowerCase();
    let first = Infinity;
    let firstLength = 0;
    let matchCount = 0;
    for (const needle of needles) {
      for (
        let at = folded.indexOf(needle);
        at !== -1;
        at = folded.indexOf(needle, at + needle.length)
      ) {
        matchCount += 1;
        if (at < first) {
          first = at;
          firstLength = needle.length;
        }
      }
    }
    if (!matchCount) continue;
    if (typeof message.id !== "string" || !message.id) {
      skipped = true;
      continue;
    }
    const start = Math.max(0, originalLowercaseOffset(text, first) - 60);
    const end = Math.min(
      text.length,
      originalLowercaseOffset(text, first + firstLength, true) + 120,
    );
    const created =
      typeof message.created === "number"
        ? new Date(
            message.created > 100_000_000_000
              ? message.created
              : message.created * 1000,
          ).toISOString()
        : (session.updatedAt ?? "");
    matches.push({
      sessionId: session.sessionId,
      title: session.title ?? "",
      archivedAt: session.archivedAt,
      workingDir: session.workingDir ?? "",
      updatedAt: session.updatedAt ?? "",
      lastMessageAt: session.lastMessageAt,
      messageCreatedAt: created,
      messageId: typeof message.id === "string" ? message.id : "",
      messageIndex,
      role: message.role,
      snippet: `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`,
      matchCount,
    });
  }
  return {
    matches: matches.reverse(),
    complete: !skipped && entries.length <= MAX_MESSAGES_PER_EXPORT,
  };
}
