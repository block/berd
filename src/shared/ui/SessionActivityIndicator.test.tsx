import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWorkingIndicatorAnimationEnabled } from "@/shared/preferences/workingIndicatorAnimationPreference";
import { SessionActivityIndicator } from "./SessionActivityIndicator";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let now: number;
let reduced: boolean;
let mediaQuery: MediaQueryList;
let visibilityChanged: IntersectionObserverCallback | undefined;
let observer: IntersectionObserver;
const disconnect = vi.fn();

function step(count = 1) {
  act(() => {
    for (let i = 0; i < count; i++) {
      now += 16;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => {
        callback(now);
      });
    }
  });
}
function visible(value: boolean) {
  act(() =>
    visibilityChanged?.(
      [{ isIntersecting: value } as IntersectionObserverEntry],
      observer,
    ),
  );
}
function pose(container: HTMLElement) {
  return Array.from(container.querySelectorAll("circle"), (circle) =>
    ["cx", "cy", "r"].map((name) => Number(circle.getAttribute(name))),
  );
}

beforeEach(() => {
  localStorage.clear();
  frames = new Map();
  nextFrame = 0;
  now = 0;
  reduced = false;
  disconnect.mockClear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        visibilityChanged = callback;
        observer = this as unknown as IntersectionObserver;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  mediaQuery = Object.assign(new EventTarget(), {
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  });
  Object.defineProperty(mediaQuery, "matches", { get: () => reduced });
  vi.spyOn(window, "matchMedia").mockReturnValue(mediaQuery);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionActivityIndicator", () => {
  it("shows four primary-colored dots, with running taking precedence over unread", () => {
    const { container } = render(
      <SessionActivityIndicator isRunning hasUnread />,
    );
    expect(screen.getByRole("status")).toHaveAccessibleName("Chat active");
    expect(screen.getByRole("status")).toHaveClass("text-primary");
    expect(
      new Set(pose(container).map((dot) => `${dot[0]},${dot[1]}`)).size,
    ).toBe(4);
    expect(screen.queryByLabelText(/unread/i)).not.toBeInTheDocument();
  });

  it("preserves the SVG and current positions through completion, then stops scheduling", () => {
    const { container, rerender } = render(
      <SessionActivityIndicator isRunning />,
    );
    visible(true);
    step(20);
    const svg = container.querySelector("svg");
    const before = pose(container);
    rerender(<SessionActivityIndicator hasUnread />);
    expect(container.querySelector("svg")).toBe(svg);
    expect(pose(container)).toEqual(before);
    expect(screen.getByRole("status")).toHaveAccessibleName("Unread messages");
    step(45);
    expect(pose(container)).toEqual(
      Array.from({ length: 4 }, () => [10, 10, 3.5]),
    );
    expect(frames.size).toBe(0);
  });

  it("retains the pose across a same-frame stopped/unread gap without announcing unread early", () => {
    const { container, rerender } = render(
      <SessionActivityIndicator isRunning />,
    );
    visible(true);
    step(10);
    const before = pose(container);
    rerender(<SessionActivityIndicator />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<SessionActivityIndicator hasUnread />);
    expect(pose(container)).toEqual(before);
    step(45);
    expect(pose(container)).toEqual(
      Array.from({ length: 4 }, () => [10, 10, 3.5]),
    );
  });

  it("hides idle immediately and clears pending work, including a read during gathering", () => {
    const { container, rerender } = render(
      <SessionActivityIndicator isRunning />,
    );
    visible(true);
    step(10);
    rerender(<SessionActivityIndicator hasUnread />);
    step(5);
    rerender(<SessionActivityIndicator />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    step();
    expect(pose(container).every((dot) => dot[2] === 0)).toBe(true);
    expect(frames.size).toBe(0);
  });

  it("honors the live app animation preference and live reduced-motion changes", () => {
    const { container, rerender } = render(
      <SessionActivityIndicator isRunning />,
    );
    visible(true);
    step(5);
    act(() => setWorkingIndicatorAnimationEnabled(false));
    const still = pose(container);
    expect(frames.size).toBe(0);
    step(5);
    expect(pose(container)).toEqual(still);
    act(() => setWorkingIndicatorAnimationEnabled(true));
    expect(frames.size).toBe(1);
    act(() => {
      reduced = true;
      mediaQuery.dispatchEvent(new Event("change"));
    });
    expect(frames.size).toBe(0);
    rerender(<SessionActivityIndicator hasUnread />);
    expect(pose(container)).toEqual(
      Array.from({ length: 4 }, () => [10, 10, 3.5]),
    );
    act(() => {
      reduced = false;
      mediaQuery.dispatchEvent(new Event("change"));
    });
    rerender(<SessionActivityIndicator isRunning />);
    expect(frames.size).toBe(1);
  });

  it("pauses offscreen and in the background, and cleans up on unmount", () => {
    const { unmount } = render(<SessionActivityIndicator isRunning />);
    expect(frames.size).toBe(0);
    visible(true);
    expect(frames.size).toBe(1);
    visible(false);
    expect(frames.size).toBe(0);
    visible(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(frames.size).toBe(0);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps the same overlay origin for working and unread", () => {
    const { rerender } = render(
      <SessionActivityIndicator isRunning variant="overlay" />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveClass("absolute", "-right-2", "-top-2");
    rerender(<SessionActivityIndicator hasUnread variant="overlay" />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveClass("absolute", "-right-2", "-top-2");
  });
});
