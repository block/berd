import { beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackSurveySink } from "./feedbackSurveySink";
import { sendFeedbackSurveyEvent } from "./feedbackSurveyEvents";

vi.mock("./feedbackSurveySink", () => ({ feedbackSurveySink: vi.fn() }));

const sink = vi.mocked(feedbackSurveySink);

describe("feedbackSurveyEvents", () => {
  beforeEach(() => {
    localStorage.clear();
    sink.mockClear();
  });

  it("assigns a persistent session-wide event sequence", () => {
    sendFeedbackSurveyEvent({
      sessionId: "session",
      messageId: "message",
      appearanceId: "appearance",
      surveyType: "response",
      eventType: "appeared",
    });
    sendFeedbackSurveyEvent({
      sessionId: "session",
      messageId: "message",
      appearanceId: "appearance",
      surveyType: "response",
      eventType: "responded",
      response: "good",
    });

    expect(sink).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ eventSequence: 1 }),
    );
    expect(sink).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ eventSequence: 2 }),
    );
  });
});
