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

  it("layers refraction behind the card and removes it after the final lobe", () => {
    render(
      <AgentCardReveal identity="one">
        <div>Card</div>
      </AgentCardReveal>,
    );

    expect(screen.getByText("Card").parentElement).toHaveClass("z-10");
    expect(
      document.querySelector('[data-agent-card-reveal="true"]'),
    ).toHaveClass("overflow-hidden", "p-16");
    const refraction = document.querySelector(
      '[data-agent-card-refraction="true"]',
    );
    expect(refraction).toHaveClass("z-0");
    expect(refraction?.firstElementChild).toHaveClass("inset-0");
    expect(
      (refraction?.firstElementChild as HTMLElement).style.background,
    ).toContain("transparent 100%");
    expect((refraction?.firstElementChild as HTMLElement).style.boxShadow).toBe(
      "",
    );

    act(() => motionMocks.completions.at(-1)?.());

    expect(
      document.querySelector('[data-agent-card-refraction="true"]'),
    ).not.toBeInTheDocument();
  });

  it("replays refraction when the card identity changes", () => {
    const { rerender } = render(
      <AgentCardReveal identity="one">
        <div>Card</div>
      </AgentCardReveal>,
    );
    act(() => motionMocks.completions.at(-1)?.());

    rerender(
      <AgentCardReveal identity="two">
        <div>Card</div>
      </AgentCardReveal>,
    );

    expect(
      document.querySelector('[data-agent-card-refraction="true"]'),
    ).toBeInTheDocument();
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
