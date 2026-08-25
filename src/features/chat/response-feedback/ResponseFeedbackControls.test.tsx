import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackSurveySink } from "./feedbackSurveySink";
import { ResponseFeedbackControls } from "./ResponseFeedbackControls";

vi.mock("./feedbackSurveySink", () => ({ feedbackSurveySink: vi.fn() }));

const sink = vi.mocked(feedbackSurveySink);
let intersectionCallback: IntersectionObserverCallback;

class MockIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }
  observe() {}
  disconnect() {}
}

describe("ResponseFeedbackControls", () => {
  beforeEach(() => {
    localStorage.clear();
    sink.mockClear();
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  });

  it("records an appearance when persistent controls enter the viewport", () => {
    render(
      <ResponseFeedbackControls
        sessionId="session"
        messageId="message"
        persistentlyVisible
      />,
    );

    expect(sink).not.toHaveBeenCalled();
    act(() => {
      intersectionCallback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "appeared" }),
    );
  });

  it("does not record hidden controls merely because they are mounted", () => {
    render(
      <ResponseFeedbackControls
        sessionId="session"
        messageId="message"
        persistentlyVisible={false}
      />,
    );

    expect(sink).not.toHaveBeenCalled();
  });
});
