import { beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackSurveySink } from "./feedbackSurveySink";
import { sendFeedbackSurveyEvent } from "./feedbackSurveyEvents";

vi.mock("./feedbackSurveySink", () => ({ feedbackSurveySink: vi.fn() }));

const sink = vi.mocked(feedbackSurveySink);

describe("feedbackSurveyEvents", () => {
  beforeEach(() => {
    sink.mockClear();
  });

  it("forwards survey identity and state to the distribution-owned sink", () => {
    const event = {
      sessionId: "session",
      messageId: "message",
      appearanceId: "appearance",
      surveyType: "response" as const,
      eventType: "responded" as const,
      response: "good" as const,
    };

    sendFeedbackSurveyEvent(event);

    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith(event);
  });
});
