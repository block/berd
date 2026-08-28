import {
  type FeedbackSurveySinkEvent,
  feedbackSurveySink,
} from "./feedbackSurveySink";

export type FeedbackSurveyEventInput = FeedbackSurveySinkEvent;

export function sendFeedbackSurveyEvent(input: FeedbackSurveyEventInput): void {
  feedbackSurveySink(input);
}
