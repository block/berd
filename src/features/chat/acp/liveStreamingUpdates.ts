import { SNIPPET_SCAN_LIMIT } from "@/features/chat/lib/messageSnippet";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  type StreamingMessageUpdate,
  type StreamingMessageUpdateMode,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { isTextContent } from "@/shared/types/messages";
import { getSessionPromptOwner } from "@/features/chat/lib/sessionPromptOwnership";

const LIVE_SUBTITLE_THROTTLE_MS = 1_000;
const FRAME_FALLBACK_MS = 16;

type TimerId = ReturnType<typeof setTimeout>;

interface BufferedTextUpdate {
  kind: "text";
  sessionId: string;
  messageId: string;
  owner: symbol | null;
  text: string;
}

interface BufferedThinkingUpdate {
  kind: "thinking";
  sessionId: string;
  messageId: string;
  owner: symbol | null;
  chunks: string[];
}

type BufferedStreamingUpdate = BufferedTextUpdate | BufferedThinkingUpdate;

interface PendingSubtitleUpdate {
  text: string;
  timerId: TimerId | null;
  lastPublishedAt: number;
}

const bufferedStreamingUpdates: BufferedStreamingUpdate[] = [];
const streamOwnerByMessage = new Map<string, symbol | null>();
const pendingSubtitleUpdates = new Map<string, PendingSubtitleUpdate>();
let scheduledFrameId: number | null = null;
let scheduledTimeoutId: TimerId | null = null;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function requestFrame(callback: () => void): void {
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    scheduledFrameId = window.requestAnimationFrame(() => {
      scheduledFrameId = null;
      callback();
    });
    return;
  }

  scheduledTimeoutId = setTimeout(() => {
    scheduledTimeoutId = null;
    callback();
  }, FRAME_FALLBACK_MS);
}

function cancelScheduledFrame(): void {
  if (
    scheduledFrameId !== null &&
    typeof window !== "undefined" &&
    typeof window.cancelAnimationFrame === "function"
  ) {
    window.cancelAnimationFrame(scheduledFrameId);
  }
  scheduledFrameId = null;

  if (scheduledTimeoutId !== null) {
    clearTimeout(scheduledTimeoutId);
  }
  scheduledTimeoutId = null;
}

function streamingMessageKey(sessionId: string, messageId: string): string {
  return `${sessionId}\0${messageId}`;
}

export function clearStreamingMessageOwners(): void {
  streamOwnerByMessage.clear();
}

export function registerStreamingMessageOwner(
  sessionId: string,
  messageId: string,
): void {
  const key = streamingMessageKey(sessionId, messageId);
  if (!streamOwnerByMessage.has(key)) {
    streamOwnerByMessage.set(key, getSessionPromptOwner(sessionId));
  }
}

function resolveStreamOwner(sessionId: string, messageId: string) {
  const key = streamingMessageKey(sessionId, messageId);
  if (streamOwnerByMessage.has(key)) {
    return streamOwnerByMessage.get(key) ?? null;
  }

  const owner = getSessionPromptOwner(sessionId);
  streamOwnerByMessage.set(key, owner);
  return owner;
}

export function isStreamingMessageOwnedByCurrentPrompt(
  sessionId: string,
  messageId: string,
): boolean {
  return (
    resolveStreamOwner(sessionId, messageId) ===
    getSessionPromptOwner(sessionId)
  );
}

function scheduleBufferedFlush(): void {
  if (scheduledFrameId !== null || scheduledTimeoutId !== null) {
    return;
  }

  requestFrame(flushAllBufferedStreamingUpdates);
}

function getAccumulatedAssistantText(
  sessionId: string,
  messageId: string,
): string | null {
  const streamingMessage = useChatStore
    .getState()
    .messagesBySession[sessionId]?.findLast(
      (message) => message.id === messageId,
    );
  if (!streamingMessage) {
    return null;
  }

  let accumulatedText = "";
  for (const block of streamingMessage.content) {
    if (!isTextContent(block)) continue;
    if (accumulatedText.length > 0) accumulatedText += "\n";
    accumulatedText += block.text.slice(
      0,
      SNIPPET_SCAN_LIMIT - accumulatedText.length,
    );
    if (accumulatedText.length >= SNIPPET_SCAN_LIMIT) break;
  }

  return accumulatedText;
}

function updateLiveSubtitle(sessionId: string, text: string): void {
  useChatSessionStore.getState().updateSessionSubtitleFromText(sessionId, text);
}

function publishLiveSubtitle(sessionId: string, text: string): void {
  updateLiveSubtitle(sessionId, text);
  const pending = pendingSubtitleUpdates.get(sessionId);
  if (pending) {
    pending.text = text;
    pending.lastPublishedAt = nowMs();
  } else {
    pendingSubtitleUpdates.set(sessionId, {
      text,
      timerId: null,
      lastPublishedAt: nowMs(),
    });
  }
}

export function scheduleLiveSubtitleUpdate(
  sessionId: string,
  text: string,
): void {
  const now = nowMs();
  const pending = pendingSubtitleUpdates.get(sessionId);
  if (!pending) {
    pendingSubtitleUpdates.set(sessionId, {
      text,
      timerId: null,
      lastPublishedAt: now,
    });
    updateLiveSubtitle(sessionId, text);
    return;
  }

  pending.text = text;
  const elapsedMs = now - pending.lastPublishedAt;
  if (elapsedMs >= LIVE_SUBTITLE_THROTTLE_MS) {
    if (pending.timerId !== null) {
      clearTimeout(pending.timerId);
      pending.timerId = null;
    }
    publishLiveSubtitle(sessionId, text);
    return;
  }

  if (pending.timerId !== null) {
    return;
  }

  pending.timerId = setTimeout(() => {
    pending.timerId = null;
    publishLiveSubtitle(sessionId, pending.text);
  }, LIVE_SUBTITLE_THROTTLE_MS - elapsedMs);
}

export function flushLiveSubtitleUpdate(sessionId: string): void {
  const pending = pendingSubtitleUpdates.get(sessionId);
  if (!pending) {
    return;
  }

  if (pending.timerId !== null) {
    clearTimeout(pending.timerId);
  }
  pendingSubtitleUpdates.delete(sessionId);
  updateLiveSubtitle(sessionId, pending.text);
}

export function clearLiveSubtitleUpdate(sessionId: string): void {
  const pending = pendingSubtitleUpdates.get(sessionId);
  if (pending?.timerId != null) {
    clearTimeout(pending.timerId);
  }
  pendingSubtitleUpdates.delete(sessionId);
}

export function enqueueStreamingTextUpdate(
  sessionId: string,
  messageId: string,
  text: string,
): void {
  if (!text) {
    return;
  }

  const owner = resolveStreamOwner(sessionId, messageId);
  const latest = bufferedStreamingUpdates.at(-1);
  if (
    latest?.kind === "text" &&
    latest.sessionId === sessionId &&
    latest.messageId === messageId &&
    latest.owner === owner
  ) {
    latest.text += text;
  } else {
    bufferedStreamingUpdates.push({
      kind: "text",
      sessionId,
      messageId,
      owner,
      text,
    });
  }
  scheduleBufferedFlush();
}

export function enqueueStreamingThinkingUpdate(
  sessionId: string,
  messageId: string,
  text: string,
): void {
  if (!text) {
    return;
  }

  const owner = resolveStreamOwner(sessionId, messageId);
  const latest = bufferedStreamingUpdates.at(-1);
  if (
    latest?.kind === "thinking" &&
    latest.sessionId === sessionId &&
    latest.messageId === messageId &&
    latest.owner === owner
  ) {
    latest.chunks.push(text);
  } else {
    bufferedStreamingUpdates.push({
      kind: "thinking",
      sessionId,
      messageId,
      owner,
      chunks: [text],
    });
  }
  scheduleBufferedFlush();
}

function toStoreUpdate(
  update: BufferedStreamingUpdate,
): StreamingMessageUpdate {
  return update.kind === "text"
    ? {
        kind: "text",
        sessionId: update.sessionId,
        messageId: update.messageId,
        text: update.text,
      }
    : {
        kind: "thinking",
        sessionId: update.sessionId,
        messageId: update.messageId,
        chunks: update.chunks,
      };
}

function applyBufferedUpdates(
  updates: readonly BufferedStreamingUpdate[],
  mode: StreamingMessageUpdateMode,
): void {
  const storeUpdates = updates.map(toStoreUpdate);
  const latestTextUpdateBySession = new Map<string, BufferedTextUpdate>();

  if (mode === "active-stream") {
    for (const update of updates) {
      if (update.kind !== "text") continue;
      latestTextUpdateBySession.set(update.sessionId, update);
    }
  }

  if (storeUpdates.length === 0) return;
  useChatStore.getState().appendStreamingMessageUpdates(storeUpdates, {
    mode,
  });

  for (const update of latestTextUpdateBySession.values()) {
    const accumulatedText = getAccumulatedAssistantText(
      update.sessionId,
      update.messageId,
    );
    if (accumulatedText !== null) {
      scheduleLiveSubtitleUpdate(update.sessionId, accumulatedText);
    }
  }
}

export function flushAllBufferedStreamingUpdates(): void {
  cancelScheduledFrame();

  const currentUpdates: BufferedStreamingUpdate[] = [];
  for (
    let index = bufferedStreamingUpdates.length - 1;
    index >= 0;
    index -= 1
  ) {
    const update = bufferedStreamingUpdates[index];
    if (update && update.owner === getSessionPromptOwner(update.sessionId)) {
      currentUpdates.unshift(update);
      bufferedStreamingUpdates.splice(index, 1);
    }
  }

  applyBufferedUpdates(currentUpdates, "active-stream");
}

export function flushBufferedStreamingUpdatesForSession(
  sessionId: string,
  options: { flushSubtitle?: boolean; owner?: symbol | null } = {},
): void {
  const matches = (update: BufferedStreamingUpdate) =>
    update.sessionId === sessionId &&
    ("owner" in options
      ? update.owner === options.owner
      : update.owner === getSessionPromptOwner(sessionId));
  const sessionUpdates = bufferedStreamingUpdates.filter(matches);
  if (sessionUpdates.length === 0) {
    if (
      options.flushSubtitle &&
      (!("owner" in options) ||
        options.owner === getSessionPromptOwner(sessionId))
    ) {
      flushLiveSubtitleUpdate(sessionId);
    }
    return;
  }

  for (
    let index = bufferedStreamingUpdates.length - 1;
    index >= 0;
    index -= 1
  ) {
    const update = bufferedStreamingUpdates[index];
    if (update && matches(update)) {
      bufferedStreamingUpdates.splice(index, 1);
    }
  }

  if (bufferedStreamingUpdates.length === 0) {
    cancelScheduledFrame();
  }

  const mode: StreamingMessageUpdateMode =
    !("owner" in options) || options.owner === getSessionPromptOwner(sessionId)
      ? "active-stream"
      : "settled-stream";
  applyBufferedUpdates(sessionUpdates, mode);

  if (
    options.flushSubtitle &&
    (!("owner" in options) ||
      options.owner === getSessionPromptOwner(sessionId))
  ) {
    flushLiveSubtitleUpdate(sessionId);
  }
}

export function clearBufferedStreamingUpdatesForSession(
  sessionId: string,
  options: { owner?: symbol | null } = {},
): void {
  const matches = (update: BufferedStreamingUpdate) =>
    update.sessionId === sessionId &&
    (!("owner" in options) || update.owner === options.owner);
  for (
    let index = bufferedStreamingUpdates.length - 1;
    index >= 0;
    index -= 1
  ) {
    const update = bufferedStreamingUpdates[index];
    if (update && matches(update)) {
      bufferedStreamingUpdates.splice(index, 1);
    }
  }
  if (bufferedStreamingUpdates.length === 0) {
    cancelScheduledFrame();
  }
  if (
    !("owner" in options) ||
    options.owner === getSessionPromptOwner(sessionId)
  ) {
    clearLiveSubtitleUpdate(sessionId);
  }
}
