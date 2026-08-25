import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFeedbackSurvey } from "./SessionFeedbackSurvey";
import {
  markSessionFeedbackSurveyAppeared,
  recordSessionFeedbackSurveyResponse,
} from "./sessionFeedbackSurveyState";

vi.mock("./sessionFeedbackSurveyState", () => ({
  isSessionFeedbackSurveyActive: vi.fn(() => true),
  markSessionFeedbackSurveyAppeared: vi.fn(),
  recordSessionFeedbackSurveyResponse: vi.fn(),
}));

class MockIntersectionObserver {
  static isIntersecting = true;

  constructor(private callback: IntersectionObserverCallback) {}
  observe() {
    this.callback(
      [
        {
          isIntersecting: MockIntersectionObserver.isIntersecting,
        } as IntersectionObserverEntry,
      ],
      this as never,
    );
  }
  disconnect() {}
}

describe("SessionFeedbackSurvey", () => {
  beforeEach(() => {
    MockIntersectionObserver.isIntersecting = true;
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("defaults focus to dismiss and records its appearance", () => {
    render(
      <SessionFeedbackSurvey
        sessionId="session"
        survey={{ appearanceId: "appearance", messageId: "message" }}
      />,
    );

    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
    expect(markSessionFeedbackSurveyAppeared).toHaveBeenCalledWith(
      "session",
      "appearance",
    );
  });

  it("renders without interaction while measuring offscreen", () => {
    render(
      <SessionFeedbackSurvey
        sessionId="session"
        survey={{ appearanceId: "appearance", messageId: "message" }}
        measurementOnly
      />,
    );

    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss).not.toHaveFocus();
    expect(dismiss).toHaveAttribute("tabindex", "-1");
    expect(markSessionFeedbackSurveyAppeared).not.toHaveBeenCalled();

    fireEvent.click(dismiss);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(recordSessionFeedbackSurveyResponse).not.toHaveBeenCalled();
  });

  it("treats Escape as dismiss", () => {
    render(
      <SessionFeedbackSurvey
        sessionId="session"
        survey={{ appearanceId: "appearance", messageId: "message" }}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });

    expect(recordSessionFeedbackSurveyResponse).toHaveBeenCalledWith(
      "session",
      "appearance",
      "dismissed",
    );
  });

  it("ignores Escape outside the viewport", () => {
    MockIntersectionObserver.isIntersecting = false;
    render(
      <SessionFeedbackSurvey
        sessionId="session"
        survey={{ appearanceId: "appearance", messageId: "message" }}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(recordSessionFeedbackSurveyResponse).not.toHaveBeenCalled();
  });

  it("ignores Escape after focus leaves", () => {
    render(
      <SessionFeedbackSurvey
        sessionId="session"
        survey={{ appearanceId: "appearance", messageId: "message" }}
      />,
    );
    const otherButton = document.createElement("button");
    document.body.append(otherButton);
    otherButton.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    otherButton.remove();
    expect(recordSessionFeedbackSurveyResponse).not.toHaveBeenCalled();
  });
});
