import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { claimSessionFeedbackSurvey } from "./sessionFeedbackSurveyState";
import { useSessionFeedbackSurvey } from "./useSessionFeedbackSurvey";

vi.mock("./sessionFeedbackSurveyState", () => ({
  claimSessionFeedbackSurvey: vi.fn(),
  SESSION_SURVEY_MINIMUM_AGE_MS: 10 * 60 * 1_000,
}));

const claimSurvey = vi.mocked(claimSessionFeedbackSurvey);

function message(id: string, role: "user" | "assistant"): Message {
  return {
    id,
    role,
    created: Date.now(),
    content: [{ type: "text", text: id }],
  };
}

const previousMessages = [
  message("user-1", "user"),
  message("assistant-1", "assistant"),
  message("user-2", "user"),
  message("assistant-2", "assistant"),
  message("user-3", "user"),
  message("assistant-3", "assistant"),
  message("user-4", "user"),
  message("assistant-4", "assistant"),
];

describe("useSessionFeedbackSurvey", () => {
  beforeEach(() => {
    claimSurvey.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the requested response to complete before claiming", async () => {
    const props = {
      sessionId: "session",
      sessionCreatedAt: "2026-08-25T00:00:00.000Z",
      messages: [...previousMessages, message("user-5", "user")],
      streamingMessageId: null,
      responsePending: true,
      samplingRateBasisPoints: 250,
    };
    const { rerender } = renderHook(
      (currentProps: typeof props) => useSessionFeedbackSurvey(currentProps),
      { initialProps: props },
    );

    expect(claimSurvey).not.toHaveBeenCalled();
    rerender({
      ...props,
      messages: [...props.messages, message("assistant-5", "assistant")],
      responsePending: false,
    });

    await waitFor(() => expect(claimSurvey).toHaveBeenCalledTimes(1));
    expect(claimSurvey).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "assistant-5", userTurnCount: 5 }),
    );
  });

  it("re-evaluates when the session reaches the minimum age", () => {
    vi.useFakeTimers();
    claimSurvey.mockReturnValue(new Promise(() => {}));
    const now = Date.parse("2026-08-25T12:00:00.000Z");
    vi.setSystemTime(now);
    renderHook(() =>
      useSessionFeedbackSurvey({
        sessionId: "aging-session",
        sessionCreatedAt: new Date(now - 10 * 60 * 1_000 + 1_000).toISOString(),
        messages: [
          ...previousMessages,
          message("user-5", "user"),
          message("assistant-5", "assistant"),
        ],
        streamingMessageId: null,
        responsePending: false,
        samplingRateBasisPoints: 250,
      }),
    );

    expect(claimSurvey).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1_000));
    expect(claimSurvey).toHaveBeenCalledTimes(2);
  });
});
