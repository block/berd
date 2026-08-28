import { claimSessionFeedbackSurveyCooldown } from "@/shared/api/feedbackSurvey";
import { sendFeedbackSurveyEvent } from "./feedbackSurveyEvents";

export type SessionFeedbackSurveyResponse =
  | "good"
  | "fine"
  | "bad"
  | "dismissed";

export interface ActiveSessionFeedbackSurvey {
  appearanceId: string;
  messageId: string;
}

interface StoredSessionFeedbackSurvey {
  version: 1;
  lastEvaluatedMessageId: string;
  active: ActiveSessionFeedbackSurvey | null;
  appeared: boolean;
  response: SessionFeedbackSurveyResponse | null;
}

const SESSION_SURVEY_STORAGE_PREFIX = "berd:session-feedback-survey:v1:";
export const SESSION_SURVEY_MINIMUM_USER_TURNS = 5;
export const SESSION_SURVEY_MINIMUM_AGE_MS = 10 * 60 * 1_000;
const sessionClaimQueues = new Map<string, Promise<void>>();
const volatileSessionRecords = new Map<string, StoredSessionFeedbackSurvey>();
const volatileOnlySessionIds = new Set<string>();

interface SessionFeedbackSurveyClaimInput {
  sessionId: string;
  messageId: string;
  currentMessageIds: ReadonlySet<string>;
  sessionCreatedAt: string;
  userTurnCount: number;
  samplingRateBasisPoints: number;
  now?: number;
  random?: number;
  cooldownRandom?: number;
}

function sessionStorageKey(sessionId: string): string {
  return `${SESSION_SURVEY_STORAGE_PREFIX}${sessionId}`;
}

function readSessionRecord(
  sessionId: string,
): StoredSessionFeedbackSurvey | null {
  if (volatileOnlySessionIds.has(sessionId)) {
    return volatileSessionRecords.get(sessionId) ?? null;
  }
  try {
    const raw = localStorage.getItem(sessionStorageKey(sessionId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredSessionFeedbackSurvey>;
    if (
      value.version !== 1 ||
      typeof value.lastEvaluatedMessageId !== "string" ||
      typeof value.appeared !== "boolean" ||
      (value.response !== null &&
        value.response !== "good" &&
        value.response !== "fine" &&
        value.response !== "bad" &&
        value.response !== "dismissed") ||
      (value.active !== null &&
        (typeof value.active !== "object" ||
          typeof value.active.appearanceId !== "string" ||
          typeof value.active.messageId !== "string"))
    ) {
      return null;
    }
    const record = value as StoredSessionFeedbackSurvey;
    volatileSessionRecords.set(sessionId, record);
    return record;
  } catch {
    return volatileSessionRecords.get(sessionId) ?? null;
  }
}

function writeSessionRecord(
  sessionId: string,
  record: StoredSessionFeedbackSurvey,
): void {
  volatileSessionRecords.set(sessionId, record);
  try {
    localStorage.setItem(sessionStorageKey(sessionId), JSON.stringify(record));
    volatileOnlySessionIds.delete(sessionId);
  } catch {
    volatileOnlySessionIds.add(sessionId);
  }
}

function emitSessionSurvey(
  sessionId: string,
  appearanceId: string,
  event:
    | { eventType: "appeared" }
    | { eventType: "responded"; response: SessionFeedbackSurveyResponse },
): void {
  sendFeedbackSurveyEvent({
    sessionId,
    appearanceId,
    surveyType: "session",
    ...event,
  });
}

async function claimSessionFeedbackSurveyUnqueued({
  sessionId,
  messageId,
  currentMessageIds,
  sessionCreatedAt,
  userTurnCount,
  samplingRateBasisPoints,
  now = Date.now(),
  random = Math.random(),
  cooldownRandom = Math.random(),
}: SessionFeedbackSurveyClaimInput): Promise<ActiveSessionFeedbackSurvey | null> {
  let existing = readSessionRecord(sessionId);
  const createdAt = Date.parse(sessionCreatedAt);
  if (existing?.appeared || existing?.response) {
    return null;
  }

  if (existing?.active && currentMessageIds.has(existing.active.messageId)) {
    return existing.active;
  }
  if (existing?.active) {
    existing = { ...existing, active: null };
    writeSessionRecord(sessionId, existing);
  }

  if (
    existing?.lastEvaluatedMessageId === messageId ||
    userTurnCount < SESSION_SURVEY_MINIMUM_USER_TURNS ||
    !Number.isFinite(createdAt) ||
    now - createdAt < SESSION_SURVEY_MINIMUM_AGE_MS
  ) {
    return null;
  }

  const opportunityRateBasisPoints = Math.min(
    10_000,
    Math.max(0, samplingRateBasisPoints),
  );
  if (opportunityRateBasisPoints === 0) return null;
  const selected = await claimSessionFeedbackSurveyCooldown({
    samplingRateBasisPoints: opportunityRateBasisPoints,
    random,
    cooldownRandom,
  }).catch(() => false);

  const latest = readSessionRecord(sessionId);
  if (latest?.appeared || latest?.response) {
    return null;
  }
  if (latest?.active) {
    return latest.active;
  }

  const active = selected
    ? { appearanceId: crypto.randomUUID(), messageId }
    : null;
  writeSessionRecord(sessionId, {
    ...latest,
    version: 1,
    lastEvaluatedMessageId: messageId,
    active,
    appeared: false,
    response: null,
  });
  return active;
}

export function claimSessionFeedbackSurvey(
  input: SessionFeedbackSurveyClaimInput,
): Promise<ActiveSessionFeedbackSurvey | null> {
  const previous = sessionClaimQueues.get(input.sessionId) ?? Promise.resolve();
  const claim = previous.then(
    () => claimSessionFeedbackSurveyUnqueued(input),
    () => claimSessionFeedbackSurveyUnqueued(input),
  );
  const settled = claim.then(
    () => undefined,
    () => undefined,
  );
  sessionClaimQueues.set(input.sessionId, settled);
  void settled.finally(() => {
    if (sessionClaimQueues.get(input.sessionId) === settled) {
      sessionClaimQueues.delete(input.sessionId);
    }
  });
  return claim;
}

export function isSessionFeedbackSurveyPresentable(
  sessionId: string,
  appearanceId: string,
): boolean {
  const record = readSessionRecord(sessionId);
  return record?.active?.appearanceId === appearanceId && !record.response;
}

export function markSessionFeedbackSurveyAppeared(
  sessionId: string,
  appearanceId: string,
): void {
  const record = readSessionRecord(sessionId);
  if (
    !record?.active ||
    record.active.appearanceId !== appearanceId ||
    record.appeared
  ) {
    return;
  }
  writeSessionRecord(sessionId, { ...record, appeared: true });
  emitSessionSurvey(sessionId, appearanceId, { eventType: "appeared" });
}

export function recordSessionFeedbackSurveyResponse(
  sessionId: string,
  appearanceId: string,
  response: SessionFeedbackSurveyResponse,
): void {
  const record = readSessionRecord(sessionId);
  if (!record?.active || record.active.appearanceId !== appearanceId) return;
  if (!record.appeared) {
    emitSessionSurvey(sessionId, appearanceId, { eventType: "appeared" });
  }
  writeSessionRecord(sessionId, {
    ...record,
    active: null,
    appeared: true,
    response,
  });
  emitSessionSurvey(sessionId, appearanceId, {
    eventType: "responded",
    response,
  });
}
