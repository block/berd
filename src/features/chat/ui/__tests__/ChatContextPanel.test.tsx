import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatContextPanel } from "../ChatContextPanel";

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
  useReducedMotion: () => false,
}));

vi.mock("../ContextPanel", () => ({
  ContextPanel: () => <div data-testid="context-panel-content" />,
}));

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

describe("ChatContextPanel", () => {
  beforeEach(() => {
    mockMatchMedia(false);
  });

  it("hugs content height without overlay shadow in inline mode", () => {
    const { container } = render(
      <ChatContextPanel activeSessionId="session-1" isOpen />,
    );

    const frame = container.querySelector("aside")?.parentElement;
    const panel = container.querySelector("aside");

    expect(frame).toHaveClass("self-start");
    expect(frame).toHaveClass("max-h-full");
    expect(frame).not.toHaveClass("h-full");
    expect(frame).not.toHaveClass(
      "max-h-[calc(100%-var(--spacing-app-panel-gutter-top)-var(--spacing-app-panel-gutter-bottom))]",
    );
    expect(panel).toHaveClass("h-auto");
    expect(panel).toHaveClass("max-h-full");
    expect(panel).not.toHaveClass("h-full");
    expect(panel).not.toHaveClass("shadow-popover");
  });

  it("hugs content and uses a shadow in compact overlay mode", () => {
    mockMatchMedia(true);

    const { container } = render(
      <ChatContextPanel activeSessionId="session-1" isOpen />,
    );

    const frame = container.querySelector("aside")?.parentElement;
    const panel = container.querySelector("aside");

    expect(frame).toHaveClass(
      "max-h-[calc(100%-var(--spacing-app-panel-gutter-top)-var(--spacing-app-panel-gutter-bottom))]",
    );
    expect(frame).not.toHaveClass("bottom-3");
    expect(panel).toHaveClass("max-h-full");
    expect(panel).toHaveClass("shadow-popover");
    expect(panel).not.toHaveClass("h-full");
  });
});
