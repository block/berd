import {
  type FeedbackSurveySinkEvent,
  feedbackSurveySink,
} from "./feedbackSurveySink";

export type FeedbackSurveyEventInput = Omit<
  FeedbackSurveySinkEvent,
  "eventSequence"
>;

const FEEDBACK_SEQUENCE_STORAGE_PREFIX = "berd:feedback-event-sequence:v1:";
const volatileSequences = new Map<string, number>();

function nextFeedbackEventSequence(sessionId: string): number {
  const key = `${FEEDBACK_SEQUENCE_STORAGE_PREFIX}${sessionId}`;
  let current = volatileSequences.get(key) ?? 0;
  try {
    const stored = Number(localStorage.getItem(key));
    if (Number.isSafeInteger(stored) && stored > current) current = stored;
  } catch {
    // The in-memory counter still preserves ordering for this app process.
  }
  const next = current + 1;
  volatileSequences.set(key, next);
  try {
    localStorage.setItem(key, String(next));
  } catch {
    // Persistence is best-effort; feedback delivery must not affect chat.
  }
  return next;
}

export function sendFeedbackSurveyEvent(input: FeedbackSurveyEventInput): void {
  feedbackSurveySink({
    ...input,
    eventSequence: nextFeedbackEventSequence(input.sessionId),
  });
}
