import { act, render, screen } from "@testing-library/react";
import type { ComponentPropsWithoutRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCardReveal } from "./AgentCardReveal";

const motionMocks = vi.hoisted(() => ({
  completions: [] as Array<() => void>,
  reduced: false,
}));

vi.mock("motion/react", () => ({
  useReducedMotion: () => motionMocks.reduced,
  motion: {
    div: ({
      animate: _animate,
      initial: _initial,
      onAnimationComplete,
      transition: _transition,
      ...props
    }: ComponentPropsWithoutRef<"div"> & {
      animate?: unknown;
      initial?: unknown;
      onAnimationComplete?: () => void;
      transition?: unknown;
    }) => {
      if (onAnimationComplete)
        motionMocks.completions.push(onAnimationComplete);
      return <div {...props} />;
    },
  },
}));

describe("AgentCardReveal", () => {
  beforeEach(() => {
    motionMocks.completions = [];
    motionMocks.reduced = false;
  });

  it("keeps the completed refraction geometry mounted behind the card", () => {
    render(
      <AgentCardReveal identity="one">
        <div>Card</div>
      </AgentCardReveal>,
    );

    expect(screen.getByText("Card").parentElement).toHaveClass("z-10");
    expect(
      document.querySelector('[data-agent-card-refraction="true"]'),
    ).toHaveClass("z-0");

    act(() => motionMocks.completions.at(-1)?.());

    expect(
      document.querySelector('[data-agent-card-refraction="true"]'),
    ).toBeInTheDocument();
  });

  it("replays refraction when the card identity changes", () => {
    const { rerender } = render(
      <AgentCardReveal identity="one">
        <div>Card</div>
      </AgentCardReveal>,
    );
    const firstRefraction = document.querySelector(
      '[data-agent-card-refraction="true"]',
    );

    rerender(
      <AgentCardReveal identity="two">
        <div>Card</div>
      </AgentCardReveal>,
    );

    const secondRefraction = document.querySelector(
      '[data-agent-card-refraction="true"]',
    );
    expect(secondRefraction).toBeInTheDocument();
    expect(secondRefraction).not.toBe(firstRefraction);
  });

  it("omits refraction when reduced motion is preferred", () => {
    motionMocks.reduced = true;
    render(
      <AgentCardReveal identity="one">
        <div>Card</div>
      </AgentCardReveal>,
    );

    expect(
      document.querySelector('[data-agent-card-refraction="true"]'),
    ).not.toBeInTheDocument();
  });
});
