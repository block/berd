import type { ReactNode } from "react";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_CONTEXT_PANEL_COMPACT_BASE_WIDTH,
  CHAT_CONTEXT_PANEL_COMPACT_QUERY,
  ChatContextPanel,
  getChatContextPanelCompactQuery,
  useChatContextPanelCompactViewport,
} from "../ChatContextPanel";

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

  it("switches to compact overlay mode at 800px and below", () => {
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === CHAT_CONTEXT_PANEL_COMPACT_QUERY,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMedia,
    });

    const { result } = renderHook(() => useChatContextPanelCompactViewport());

    expect(CHAT_CONTEXT_PANEL_COMPACT_BASE_WIDTH).toBe(800);
    expect(CHAT_CONTEXT_PANEL_COMPACT_QUERY).toBe("(max-width: 800px)");
    expect(result.current).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 800px)");
  });

  it("moves the compact breakpoint wider when the left nav occupies viewport width", () => {
    const compactQuery = getChatContextPanelCompactQuery(212);
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === compactQuery,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMedia,
    });

    const { result } = renderHook(() =>
      useChatContextPanelCompactViewport(212),
    );

    expect(compactQuery).toBe("(max-width: 1012px)");
    expect(result.current).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 1012px)");
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
    expect(panel).toHaveClass("rounded-md");
    expect(panel).not.toHaveClass("rounded-sm");
    expect(panel).toHaveClass(
      "[backdrop-filter:var(--backdrop-chat-context-panel)]",
    );
    expect(panel).toHaveClass(
      "[-webkit-backdrop-filter:var(--backdrop-chat-context-panel)]",
    );
    expect(panel).not.toHaveClass("backdrop-blur-md");
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

    expect(frame).toHaveClass("absolute");
    expect(frame).toHaveClass(
      "max-h-[calc(100%-var(--spacing-app-panel-gutter-top)-var(--spacing-app-panel-gutter-bottom))]",
    );
    expect(frame).not.toHaveClass("bottom-3");
    expect(panel).toHaveClass("max-h-full");
    expect(panel).toHaveClass("shadow-popover");
    expect(panel).not.toHaveClass("h-full");
  });

  it("requests close on outside pointer down only", () => {
    mockMatchMedia(true);
    const onRequestClose = vi.fn();
    render(
      <>
        <button type="button">Outside</button>
        <ChatContextPanel
          activeSessionId="session-1"
          isOpen
          onRequestClose={onRequestClose}
        />
      </>,
    );

    fireEvent.pointerDown(screen.getByTestId("context-panel-content"));
    expect(onRequestClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("does not request close on the context panel toggle in compact overlay mode", () => {
    mockMatchMedia(true);
    const onRequestClose = vi.fn();
    render(
      <>
        <button type="button" data-context-panel-toggle="true">
          Toggle context
        </button>
        <ChatContextPanel
          activeSessionId="session-1"
          isOpen
          onRequestClose={onRequestClose}
        />
      </>,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Toggle context" }),
    );

    expect(onRequestClose).not.toHaveBeenCalled();
  });
});
