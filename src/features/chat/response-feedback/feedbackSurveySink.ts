export type FeedbackSurveyEventType = "appeared" | "responded";
export type FeedbackSurveyResponse = "good" | "bad" | "cleared";

export interface FeedbackSurveySinkEvent {
  sessionId: string;
  messageId: string;
  appearanceId: string;
  surveyType: "response";
  eventSequence: number;
  eventType: FeedbackSurveyEventType;
  response?: FeedbackSurveyResponse;
}

/** Distribution-owned transport seam; stock Berd intentionally sends nothing. */
export function feedbackSurveySink(_event: FeedbackSurveySinkEvent): void {}
