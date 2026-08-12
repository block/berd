import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setWorkingIndicatorAnimationEnabled } from "@/shared/preferences/workingIndicatorAnimationPreference";
import { SessionActivityIndicator } from "./SessionActivityIndicator";

const motionMocks = vi.hoisted(() => ({
  shouldReduceMotion: false,
}));

vi.mock("motion/react", () => ({
  useReducedMotion: () => motionMocks.shouldReduceMotion,
}));

describe("SessionActivityIndicator", () => {
  beforeEach(() => {
    localStorage.clear();
    motionMocks.shouldReduceMotion = false;
  });

  it("renders the Berd loader for running sessions", () => {
    const { container } = render(<SessionActivityIndicator isRunning />);

    expect(screen.getByLabelText(/chat active/i)).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="berd-loader-inline"]'),
    ).toBeInTheDocument();
    expect(container.querySelector("animateTransform")).toBeInTheDocument();
    expect(screen.getByLabelText(/chat active/i)).toHaveClass(
      "animate-in",
      "fade-in-0",
    );
  });

  it("renders a static Berd loader without an entrance fade when animation is disabled", () => {
    setWorkingIndicatorAnimationEnabled(false);

    const { container } = render(<SessionActivityIndicator isRunning />);
    const status = screen.getByLabelText(/chat active/i);

    expect(container.querySelector("animate")).not.toBeInTheDocument();
    expect(status).not.toHaveClass("animate-in", "fade-in-0");
  });

  it("renders a static Berd loader without an entrance fade when reduced motion is requested", () => {
    motionMocks.shouldReduceMotion = true;

    const { container } = render(
      <SessionActivityIndicator isRunning variant="overlay" />,
    );
    const status = screen.getByLabelText(/chat active/i);

    expect(container.querySelector("animate")).not.toBeInTheDocument();
    expect(status).not.toHaveClass("animate-in", "fade-in-0");
  });

  it("renders an inline dot for unread sessions", () => {
    render(<SessionActivityIndicator hasUnread />);

    expect(screen.getByLabelText(/unread messages/i)).toBeInTheDocument();
  });

  it("renders an overlay Berd loader variant for running sessions", () => {
    const { container } = render(
      <SessionActivityIndicator isRunning variant="overlay" />,
    );

    expect(screen.getByLabelText(/chat active/i)).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="berd-loader-inline"]'),
    ).toBeInTheDocument();
  });

  it("renders nothing when the session is idle and read", () => {
    const { container } = render(<SessionActivityIndicator />);

    expect(container).toBeEmptyDOMElement();
  });
});
