import type { Message, MessageContent } from "@/shared/types/messages";
import { sendFeedbackSurveyEvent } from "./feedbackSurveyEvents";

export type ResponseFeedbackSelection = "good" | "bad";

interface StoredResponseFeedback {
  version: 1;
  appearanceId: string;
  response: ResponseFeedbackSelection | null;
}

const RESPONSE_FEEDBACK_STORAGE_PREFIX = "berd:response-feedback:v1:";
const RESPONSE_FEEDBACK_CHANGE_EVENT = "berd:response-feedback-change";
const volatileRecords = new Map<string, StoredResponseFeedback>();
const volatileOnlyKeys = new Set<string>();

function responseFeedbackStorageKey(
  sessionId: string,
  messageId: string,
): string {
  return `${RESPONSE_FEEDBACK_STORAGE_PREFIX}${JSON.stringify([
    sessionId,
    messageId,
  ])}`;
}

function createStoredResponseFeedback(): StoredResponseFeedback {
  return {
    version: 1,
    appearanceId: crypto.randomUUID(),
    response: null,
  };
}

function parseStoredResponseFeedback(
  value: unknown,
): StoredResponseFeedback | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.appearanceId !== "string" ||
    record.appearanceId.length === 0 ||
    (record.response !== null &&
      record.response !== "good" &&
      record.response !== "bad")
  ) {
    return null;
  }
  return {
    version: 1,
    appearanceId: record.appearanceId,
    response: record.response,
  };
}

function readResponseFeedback(
  sessionId: string,
  messageId: string,
): StoredResponseFeedback {
  const key = responseFeedbackStorageKey(sessionId, messageId);
  if (volatileOnlyKeys.has(key)) {
    return volatileRecords.get(key) ?? createStoredResponseFeedback();
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = parseStoredResponseFeedback(JSON.parse(raw));
      if (parsed) {
        volatileRecords.set(key, parsed);
        return parsed;
      }
    }
  } catch {
    return volatileRecords.get(key) ?? createStoredResponseFeedback();
  }

  return createStoredResponseFeedback();
}

function writeResponseFeedback(
  sessionId: string,
  messageId: string,
  record: StoredResponseFeedback,
): void {
  const key = responseFeedbackStorageKey(sessionId, messageId);
  volatileRecords.set(key, record);
  try {
    window.localStorage.setItem(key, JSON.stringify(record));
    volatileOnlyKeys.delete(key);
  } catch {
    volatileOnlyKeys.add(key);
  }
  window.dispatchEvent(
    new CustomEvent(RESPONSE_FEEDBACK_CHANGE_EVENT, { detail: { key } }),
  );
}

function emitResponseFeedback(
  sessionId: string,
  messageId: string,
  record: StoredResponseFeedback,
  response: ResponseFeedbackSelection | "cleared",
): void {
  sendFeedbackSurveyEvent({
    sessionId,
    messageId,
    appearanceId: record.appearanceId,
    surveyType: "response",
    eventType: "responded",
    response,
  });
}

export function getResponseFeedbackSelection(
  sessionId: string,
  messageId: string,
): ResponseFeedbackSelection | null {
  return readResponseFeedback(sessionId, messageId).response;
}

export function subscribeResponseFeedbackSelection(
  sessionId: string,
  messageId: string,
  onStoreChange: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const key = responseFeedbackStorageKey(sessionId, messageId);
  const handleLocalChange = (event: Event) => {
    if ((event as CustomEvent<{ key?: string }>).detail?.key === key) {
      onStoreChange();
    }
  };
  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === key || event.key === null) {
      onStoreChange();
    }
  };

  window.addEventListener(RESPONSE_FEEDBACK_CHANGE_EVENT, handleLocalChange);
  window.addEventListener("storage", handleStorageChange);
  return () => {
    window.removeEventListener(
      RESPONSE_FEEDBACK_CHANGE_EVENT,
      handleLocalChange,
    );
    window.removeEventListener("storage", handleStorageChange);
  };
}

export function setResponseFeedbackSelection(
  sessionId: string,
  messageId: string,
  selection: ResponseFeedbackSelection | null,
): ResponseFeedbackSelection | null {
  const current = readResponseFeedback(sessionId, messageId);
  if (current.response === selection) {
    return current.response;
  }

  const next = { ...current, response: selection };
  writeResponseFeedback(sessionId, messageId, next);
  emitResponseFeedback(sessionId, messageId, next, selection ?? "cleared");
  return next.response;
}

function isUserVisibleContent(content: MessageContent): boolean {
  const audience =
    "annotations" in content ? content.annotations?.audience : undefined;
  return !audience || audience.length === 0 || audience.includes("user");
}

function isResponseContent(content: MessageContent): boolean {
  if (!isUserVisibleContent(content)) {
    return false;
  }
  if (content.type === "text") {
    return content.text.trim().length > 0;
  }
  return content.type === "image" || content.type === "mcpApp";
}

export function isResponseFeedbackEligible({
  message,
  content,
  isStreaming,
}: {
  message: Message;
  content: readonly MessageContent[];
  isStreaming: boolean;
}): boolean {
  if (
    message.role !== "assistant" ||
    message.metadata?.userVisible === false ||
    isStreaming
  ) {
    return false;
  }

  const completionStatus = message.metadata?.completionStatus;
  if (
    completionStatus === "inProgress" ||
    completionStatus === "error" ||
    completionStatus === "stopped"
  ) {
    return false;
  }

  return content.some(isResponseContent);
}
