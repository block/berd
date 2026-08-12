import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateTerminalSession } from "../../lib/terminalSessionManager";
import { TerminalPanel } from "../TerminalPanel";

const mocks = vi.hoisted(() => ({
  attach: vi.fn(() => vi.fn()),
  detach: vi.fn(),
  deferResize: vi.fn(),
  focusAndResize: vi.fn(),
  resumeResize: vi.fn(),
  restart: vi.fn(),
  resolvedTheme: "light" as "dark" | "light",
  sessionStatus: "running",
  stop: vi.fn(),
  statusListener: null as (() => void) | null,
  subscribeTerminalSessionStatus: vi.fn(
    (_sessionKey: string, listener: () => void) => {
      mocks.statusListener = listener;
      return vi.fn();
    },
  ),
  scheduleAfterNextPaint: vi.fn((callback: () => void) => {
    const frameId = window.requestAnimationFrame(() => callback());
    return () => window.cancelAnimationFrame(frameId);
  }),
  subscribe: vi.fn((listener: () => void) => {
    mocks.subscriptionListener = listener;
    return vi.fn();
  }),
  subscriptionListener: null as (() => void) | null,
  t: vi.fn((key: string) => key),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock("@/shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ resolvedTheme: mocks.resolvedTheme }),
}));

vi.mock("@/app/lib/scheduleAfterNextPaint", () => ({
  scheduleAfterNextPaint: (callback: () => void) =>
    mocks.scheduleAfterNextPaint(callback),
}));

vi.mock("../../lib/terminalSessionManager", () => ({
  getTerminalSessionStatus: vi.fn(() => mocks.sessionStatus),
  getOrCreateTerminalSession: vi.fn(() => ({
    attach: mocks.attach.mockImplementation(() => mocks.detach),
    deferResize: mocks.deferResize,
    focusAndResize: mocks.focusAndResize,
    resumeResize: mocks.resumeResize,
    restart: mocks.restart,
    get status() {
      return mocks.sessionStatus;
    },
    stop: mocks.stop,
    updateLabels: vi.fn(),
  })),
  subscribeTerminalSessionStatus: (sessionKey: string, listener: () => void) =>
    mocks.subscribeTerminalSessionStatus(sessionKey, listener),
}));

const getOrCreateTerminalSessionMock = vi.mocked(getOrCreateTerminalSession);

function mockAnimationFrames() {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestAnimationFrameSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      callbacks.set(frameId, callback);
      return frameId;
    });
  const cancelAnimationFrameSpy = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((frameId) => {
      callbacks.delete(frameId);
    });

  return {
    restore: () => {
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    },
    runAll: () => {
      for (const [frameId, callback] of Array.from(callbacks)) {
        callbacks.delete(frameId);
        callback(performance.now());
      }
    },
  };
}

describe("TerminalPanel", () => {
  let frames: ReturnType<typeof mockAnimationFrames>;

  beforeEach(() => {
    frames = mockAnimationFrames();
    mocks.attach.mockClear();
    mocks.detach.mockClear();
    mocks.deferResize.mockClear();
    mocks.focusAndResize.mockClear();
    mocks.resumeResize.mockClear();
    mocks.restart.mockClear();
    mocks.resolvedTheme = "light";
    mocks.sessionStatus = "running";
    mocks.stop.mockClear();
    mocks.statusListener = null;
    mocks.scheduleAfterNextPaint.mockClear();
    mocks.subscribeTerminalSessionStatus.mockClear();
    mocks.subscriptionListener = null;
    mocks.subscribe.mockClear();
    mocks.t.mockClear();
    getOrCreateTerminalSessionMock.mockClear();
    document.documentElement.style.removeProperty("--scrollbar-thumb-alpha");
    document.documentElement.style.removeProperty(
      "--scrollbar-thumb-hover-alpha",
    );
    document.documentElement.style.removeProperty("--foreground");
    document.documentElement.style.removeProperty("--card");
    document.documentElement.style.removeProperty("--primary");
    document.documentElement.style.removeProperty("--accent");
  });

  afterEach(() => {
    frames.restore();
    vi.useRealTimers();
  });

  it("does not defer terminal resize when mounted expanded", () => {
    render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        onCollapse={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    act(() => {
      frames.runAll();
    });

    expect(mocks.deferResize).not.toHaveBeenCalled();
    expect(mocks.resumeResize).not.toHaveBeenCalled();
  });

  it("lets xterm own the terminal body inset", () => {
    render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        onCollapse={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const terminalBody = screen
      .getByRole("region", { name: "terminal.title" })
      .querySelector(".goose-terminal");

    expect(terminalBody).toHaveClass("px-0", "py-0");
    expect(terminalBody).not.toHaveClass("p-2");
  });

  it("focuses xterm when the pane jump focus event is dispatched", () => {
    render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        onCollapse={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    act(() => {
      frames.runAll();
    });

    screen
      .getByRole("region", { name: "terminal.title" })
      .dispatchEvent(new CustomEvent("goose-terminal-focus"));

    expect(mocks.focusAndResize).toHaveBeenCalledOnce();
  });

  it("does not focus on mount when focusRequest is still zero", () => {
    render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        focusRequest={0}
      />,
    );

    act(() => {
      frames.runAll();
    });

    expect(mocks.focusAndResize).not.toHaveBeenCalled();
  });

  it("focuses the terminal when focusRequest increments", () => {
    const { rerender } = render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        focusRequest={0}
      />,
    );

    act(() => {
      frames.runAll();
    });
    expect(mocks.focusAndResize).not.toHaveBeenCalled();

    rerender(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        focusRequest={1}
      />,
    );

    act(() => {
      frames.runAll();
    });

    expect(mocks.focusAndResize).toHaveBeenCalledOnce();
  });

  it("defers focus until a starting session becomes running", () => {
    mocks.sessionStatus = "starting";
    const { rerender } = render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        focusRequest={0}
      />,
    );

    act(() => {
      frames.runAll();
    });

    // User opens the terminal while it is still starting up.
    rerender(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        focusRequest={1}
      />,
    );

    act(() => {
      frames.runAll();
    });

    // Too early: xterm is not settled, so focus is held back.
    expect(mocks.focusAndResize).not.toHaveBeenCalled();

    // Session finishes starting and notifies subscribers.
    mocks.sessionStatus = "running";
    act(() => {
      mocks.statusListener?.();
    });
    act(() => {
      frames.runAll();
    });

    expect(mocks.focusAndResize).toHaveBeenCalledOnce();
  });

  it("does not focus on a focusRequest while collapsed", () => {
    const { rerender } = render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed
        focusRequest={0}
      />,
    );

    act(() => {
      frames.runAll();
    });

    rerender(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed
        focusRequest={1}
      />,
    );

    act(() => {
      frames.runAll();
    });

    expect(mocks.focusAndResize).not.toHaveBeenCalled();
  });

  it("passes the app scrollbar opacity tokens to xterm", () => {
    document.documentElement.style.setProperty(
      "--scrollbar-thumb-alpha",
      "14%",
    );
    document.documentElement.style.setProperty(
      "--scrollbar-thumb-hover-alpha",
      "22%",
    );

    render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        onCollapse={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    act(() => {
      frames.runAll();
    });

    expect(getOrCreateTerminalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({
          scrollbarSliderBackground: "rgba(36, 36, 36, 0.14)",
          scrollbarSliderHoverBackground: "rgba(36, 36, 36, 0.22)",
          scrollbarSliderActiveBackground: "rgba(36, 36, 36, 0.22)",
        }),
      }),
    );
  });

  it("keeps terminal selections visible when the dark accent matches the background", () => {
    mocks.resolvedTheme = "dark";
    document.documentElement.style.setProperty("--foreground", "#ffffff");
    document.documentElement.style.setProperty("--card", "#1f2937");
    document.documentElement.style.setProperty("--primary", "#ffffff");
    document.documentElement.style.setProperty("--accent", "#1f2937");

    render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        onCollapse={vi.fn()}
        onExpand={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    act(() => {
      frames.runAll();
    });

    expect(getOrCreateTerminalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({
          background: "rgb(31, 41, 55)",
          selectionBackground: "rgba(255, 255, 255, 0.3)",
          selectionForeground: "rgb(255, 255, 255)",
          selectionInactiveBackground: "rgba(255, 255, 255, 0.18)",
        }),
      }),
    );

    const [{ theme }] = getOrCreateTerminalSessionMock.mock.calls[0];
    expect(theme.selectionBackground).not.toBe(theme.background);
    expect(theme.selectionInactiveBackground).not.toBe(theme.background);
  });

  it("resumes terminal resize after expansion even without a transition event", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <TerminalPanel
          sessionKey="session:/repo"
          cwd="/Users/test/repo"
          collapsed
          onCollapse={vi.fn()}
          onExpand={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      expect(mocks.deferResize).toHaveBeenCalledTimes(1);
      expect(mocks.resumeResize).not.toHaveBeenCalled();

      act(() => {
        frames.runAll();
      });

      expect(mocks.deferResize).toHaveBeenCalledTimes(1);
      expect(mocks.resumeResize).not.toHaveBeenCalled();

      rerender(
        <TerminalPanel
          sessionKey="session:/repo"
          cwd="/Users/test/repo"
          collapsed={false}
          onCollapse={vi.fn()}
          onExpand={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      expect(mocks.deferResize).toHaveBeenCalledTimes(2);
      expect(mocks.resumeResize).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(mocks.resumeResize).toHaveBeenCalledWith({ focus: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders without the built-in header for external tab chrome", () => {
    render(
      <TerminalPanel
        sessionKey="session:tab-1"
        cwd="/Users/test/repo"
        collapsed={false}
        showHeader={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "terminal.restart" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "terminal.collapse" }),
    ).toBeNull();
    expect(getOrCreateTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(mocks.attach).toHaveBeenCalledTimes(1);

    act(() => {
      frames.runAll();
    });

    expect(getOrCreateTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });

  it("reattaches the terminal surface after a selected tab was detached", () => {
    const { unmount } = render(
      <TerminalPanel
        sessionKey="session:tab-1"
        cwd="/Users/test/repo"
        collapsed={false}
        showHeader={false}
      />,
    );

    act(() => {
      frames.runAll();
    });

    expect(mocks.attach).toHaveBeenCalledTimes(1);

    unmount();
    expect(mocks.detach).toHaveBeenCalledTimes(1);

    render(
      <TerminalPanel
        sessionKey="session:tab-1"
        cwd="/Users/test/repo"
        collapsed={false}
        showHeader={false}
      />,
    );

    act(() => {
      frames.runAll();
    });

    expect(mocks.attach).toHaveBeenCalledTimes(2);
  });

  it("does not close itself when mounted with an already exited session", () => {
    mocks.sessionStatus = "exited";

    render(
      <TerminalPanel
        sessionKey="session:tab-1"
        cwd="/Users/test/repo"
        collapsed={false}
      />,
    );

    expect(screen.getByText("terminal.status.exited")).toBeInTheDocument();
    act(() => {
      frames.runAll();
    });
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });

  it("updates terminal status through the external store subscription", () => {
    render(
      <TerminalPanel
        sessionKey="session:tab-1"
        cwd="/Users/test/repo"
        collapsed={false}
      />,
    );

    expect(screen.getByText("terminal.status.running")).toBeInTheDocument();

    mocks.sessionStatus = "exited";
    act(() => {
      mocks.statusListener?.();
    });

    expect(screen.getByText("terminal.status.exited")).toBeInTheDocument();
  });

  it("toggles when the header background is clicked", async () => {
    const user = userEvent.setup();
    const onCollapse = vi.fn();
    const onExpand = vi.fn();

    const { rerender } = render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        onCollapse={onCollapse}
        onExpand={onExpand}
        onClose={vi.fn()}
      />,
    );

    await user.click(
      screen.getAllByRole("button", { name: "terminal.collapse" })[0],
    );
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onExpand).not.toHaveBeenCalled();

    rerender(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed
        onCollapse={onCollapse}
        onExpand={onExpand}
        onClose={vi.fn()}
      />,
    );

    await user.click(
      screen.getAllByRole("button", { name: "terminal.expand" })[0],
    );
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("keeps header action buttons scoped to their own actions", async () => {
    const user = userEvent.setup();
    const onCollapse = vi.fn();
    const onClose = vi.fn();

    render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed={false}
        onCollapse={onCollapse}
        onExpand={vi.fn()}
        onClose={onClose}
      />,
    );

    act(() => {
      frames.runAll();
    });

    await user.click(screen.getByRole("button", { name: "terminal.restart" }));
    expect(mocks.restart).toHaveBeenCalledTimes(1);
    expect(onCollapse).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "terminal.stopAndCloseTab" }),
    );
    expect(
      screen.getByText("terminal.confirmStopTabTitle"),
    ).toBeInTheDocument();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "common:actions.cancel" }),
    );
    expect(
      screen.queryByText("terminal.confirmStopTabTitle"),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "terminal.stopAndCloseTab" }),
    );
    await user.click(screen.getByRole("button", { name: "terminal.stop" }));

    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it("expands a collapsed terminal when restart is clicked", async () => {
    const user = userEvent.setup();
    const onExpand = vi.fn();

    render(
      <TerminalPanel
        sessionKey="session:/repo"
        cwd="/Users/test/repo"
        collapsed
        onCollapse={vi.fn()}
        onExpand={onExpand}
        onClose={vi.fn()}
      />,
    );

    act(() => {
      frames.runAll();
    });

    await user.click(screen.getByRole("button", { name: "terminal.restart" }));

    expect(mocks.restart).toHaveBeenCalledTimes(1);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
