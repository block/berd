export type FeedbackSurveyResponse = "good" | "bad" | "cleared";

export interface FeedbackSurveySinkEvent {
  sessionId: string;
  messageId: string;
  appearanceId: string;
  surveyType: "response";
  eventType: "responded";
  response: FeedbackSurveyResponse;
}

/** Distribution-owned transport and ordering seam; stock Berd sends nothing. */
export function feedbackSurveySink(_event: FeedbackSurveySinkEvent): void {}
