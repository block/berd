import { render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_CONTEXT_PANEL_COMPACT_BASE_WIDTH,
  CHAT_CONTEXT_PANEL_COMPACT_QUERY,
  ChatContextPanel,
  getChatContextPanelCompactQuery,
  useChatContextPanelCompactViewport,
} from "../ChatContextPanel";

const mockContextPanelWorktreeTracker = vi.hoisted(() => vi.fn());
const mockContextPanel = vi.hoisted(() => vi.fn());

vi.mock("../ContextPanel", () => ({
  ContextPanel: (props: unknown) => {
    mockContextPanel(props);
    return <div data-testid="context-panel-content" />;
  },
  ContextPanelWorktreeTracker: (props: unknown) => {
    mockContextPanelWorktreeTracker(props);
    return <div data-testid="context-panel-worktree-tracker" />;
  },
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
    mockContextPanelWorktreeTracker.mockClear();
    mockContextPanel.mockClear();
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

  it("keeps scrolling inside the tab body so the header remains pinned", () => {
    const { container } = render(
      <ChatContextPanel activeSessionId="session-1" isVisible />,
    );

    expect(container.querySelector(".chat-context-panel-surface")).toHaveClass(
      "overflow-hidden",
    );
    expect(
      container.querySelector(".chat-context-panel-surface"),
    ).not.toHaveClass("overflow-y-auto");
  });

  it("shows the panel at full material opacity without a fade", () => {
    const { container } = render(
      <ChatContextPanel activeSessionId="session-1" isVisible />,
    );

    const panel = container.querySelector(".chat-context-panel-surface");
    expect(panel?.parentElement).not.toHaveStyle({ opacity: "0" });
    expect(panel?.parentElement).not.toHaveStyle({ opacity: "0.5" });
  });

  it("keeps worktree tracking mounted while the panel is closed", () => {
    render(
      <ChatContextPanel
        activeSessionId="session-1"
        isVisible={false}
        project={{ workingDirs: ["/Users/test/project"] }}
        sessionWorkingDir="/Users/test/project"
      />,
    );

    expect(screen.getByTestId("context-panel-worktree-tracker")).toBeVisible();
    expect(mockContextPanelWorktreeTracker).toHaveBeenCalledWith({
      sessionId: "session-1",
      projectWorkingDirs: ["/Users/test/project"],
      sessionWorkingDir: "/Users/test/project",
    });
    expect(screen.getByTestId("context-panel-content")).not.toBeVisible();
  });

  it.each([
    ["hidden", false],
    ["visible", true],
  ])("does not re-render %s panel content when the parent re-renders with equivalent props", (_state, isVisible) => {
    // Regression: ChatView re-renders on every debounced composer draft flush
    // and on streaming updates. The memo boundary must keep ContextPanel from
    // re-executing on those parent renders, whether the rail is open or closed.
    const project = { workingDirs: ["/Users/test/project"] };
    const { rerender } = render(
      <ChatContextPanel
        activeSessionId="session-1"
        isVisible={isVisible}
        project={project}
        sessionWorkingDir="/Users/test/project"
      />,
    );

    const rendersAfterMount = mockContextPanel.mock.calls.length;
    expect(rendersAfterMount).toBeGreaterThan(0);

    // Same prop identities — simulates a draft-flush parent render.
    rerender(
      <ChatContextPanel
        activeSessionId="session-1"
        isVisible={isVisible}
        project={project}
        sessionWorkingDir="/Users/test/project"
      />,
    );

    expect(mockContextPanel.mock.calls.length).toBe(rendersAfterMount);

    // A genuine prop change must still get through the boundary.
    rerender(
      <ChatContextPanel
        activeSessionId="session-1"
        isVisible={isVisible}
        project={project}
        sessionWorkingDir="/Users/test/other-project"
      />,
    );

    expect(mockContextPanel.mock.calls.length).toBeGreaterThan(
      rendersAfterMount,
    );
  });
});
