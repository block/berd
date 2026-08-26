import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackSurveySink } from "./feedbackSurveySink";
import { ResponseFeedbackControls } from "./ResponseFeedbackControls";

vi.mock("./feedbackSurveySink", () => ({ feedbackSurveySink: vi.fn() }));

const sink = vi.mocked(feedbackSurveySink);

describe("ResponseFeedbackControls", () => {
  beforeEach(() => {
    localStorage.clear();
    sink.mockClear();
  });

  it("records only user selections", () => {
    render(
      <ResponseFeedbackControls sessionId="session" messageId="message" />,
    );

    expect(sink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /good/i }));

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "responded",
        response: "good",
      }),
    );
  });
});
