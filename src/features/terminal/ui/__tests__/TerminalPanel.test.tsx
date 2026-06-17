import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  subscriptionListener: null as (() => void) | null,
  subscribe: vi.fn((listener: () => void) => {
    mocks.subscriptionListener = listener;
    return vi.fn();
  }),
  t: vi.fn((key: string) => key),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock("@/shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ resolvedTheme: mocks.resolvedTheme }),
}));

vi.mock("../../lib/terminalSessionManager", () => ({
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
    subscribe: mocks.subscribe,
    updateLabels: vi.fn(),
  })),
}));

const getOrCreateTerminalSessionMock = vi.mocked(getOrCreateTerminalSession);

describe("TerminalPanel", () => {
  beforeEach(() => {
    mocks.attach.mockClear();
    mocks.detach.mockClear();
    mocks.deferResize.mockClear();
    mocks.focusAndResize.mockClear();
    mocks.resumeResize.mockClear();
    mocks.restart.mockClear();
    mocks.resolvedTheme = "light";
    mocks.sessionStatus = "running";
    mocks.stop.mockClear();
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

    expect(mocks.deferResize).not.toHaveBeenCalled();
    expect(mocks.resumeResize).not.toHaveBeenCalled();
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

    screen
      .getByRole("region", { name: "terminal.title" })
      .dispatchEvent(new CustomEvent("goose-terminal-focus"));

    expect(mocks.focusAndResize).toHaveBeenCalledOnce();
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
    expect(mocks.attach).toHaveBeenCalledTimes(1);
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

    await user.click(screen.getByRole("button", { name: "terminal.restart" }));

    expect(mocks.restart).toHaveBeenCalledTimes(1);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
