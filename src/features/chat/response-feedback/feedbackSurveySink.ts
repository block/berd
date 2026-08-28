export type ResponseFeedbackSurveyResponse = "good" | "bad" | "cleared";
export type SessionFeedbackSurveyResponse =
  | "good"
  | "fine"
  | "bad"
  | "dismissed";

interface FeedbackSurveySinkEventBase {
  sessionId: string;
  appearanceId: string;
}

export type FeedbackSurveySinkEvent = FeedbackSurveySinkEventBase &
  (
    | {
        messageId: string;
        surveyType: "response";
        eventType: "responded";
        response: ResponseFeedbackSurveyResponse;
      }
    | {
        messageId?: never;
        surveyType: "session";
        eventType: "appeared";
        response?: never;
      }
    | {
        messageId?: never;
        surveyType: "session";
        eventType: "responded";
        response: SessionFeedbackSurveyResponse;
      }
  );

/** Distribution-owned transport and ordering seam; stock Berd sends nothing. */
export function feedbackSurveySink(_event: FeedbackSurveySinkEvent): void {}
