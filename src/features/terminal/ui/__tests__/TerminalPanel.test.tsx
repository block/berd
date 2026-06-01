import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "../TerminalPanel";

const mocks = vi.hoisted(() => ({
  attach: vi.fn(() => vi.fn()),
  focusAndResize: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  t: vi.fn((key: string) => key),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock("@/shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("../../lib/terminalSessionManager", () => ({
  getOrCreateTerminalSession: vi.fn(() => ({
    attach: mocks.attach,
    focusAndResize: mocks.focusAndResize,
    restart: mocks.restart,
    status: "running",
    stop: mocks.stop,
    subscribe: mocks.subscribe,
    updateLabels: vi.fn(),
  })),
}));

describe("TerminalPanel", () => {
  beforeEach(() => {
    mocks.attach.mockClear();
    mocks.focusAndResize.mockClear();
    mocks.restart.mockClear();
    mocks.stop.mockClear();
    mocks.subscribe.mockClear();
    mocks.t.mockClear();
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
      screen.getByRole("button", { name: "terminal.stopAndClose" }),
    );
    expect(screen.getByText("terminal.confirmStopTitle")).toBeInTheDocument();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "common:actions.cancel" }),
    );
    expect(
      screen.queryByText("terminal.confirmStopTitle"),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "terminal.stopAndClose" }),
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
