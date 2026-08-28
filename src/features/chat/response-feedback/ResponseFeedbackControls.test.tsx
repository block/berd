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

  it("synchronizes the selected response across renderers", () => {
    render(
      <>
        <ResponseFeedbackControls sessionId="session" messageId="message" />
        <ResponseFeedbackControls sessionId="session" messageId="message" />
      </>,
    );

    const goodButtons = screen.getAllByRole("button", { name: /good/i });
    fireEvent.click(goodButtons[0]);
    expect(goodButtons.every((button) => button.ariaPressed === "true")).toBe(
      true,
    );

    fireEvent.click(goodButtons[1]);
    expect(goodButtons.every((button) => button.ariaPressed === "false")).toBe(
      true,
    );
    expect(sink.mock.calls.map(([event]) => event.response)).toEqual([
      "good",
      "cleared",
    ]);
  });
});
