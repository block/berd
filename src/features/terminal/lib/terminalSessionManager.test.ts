import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEvent } from "../api/terminal";

const mocks = vi.hoisted(() => ({
  resizeTerminal: vi.fn(() => Promise.resolve()),
  startTerminal: vi.fn(),
  stopTerminal: vi.fn(() => Promise.resolve()),
  writeTerminal: vi.fn(() => Promise.resolve()),
}));

class FakeTerminal {
  cols = 80;
  rows = 24;
  element: HTMLElement | null = null;
  options: { theme?: unknown; fontFamily?: string } = {};

  clear() {}
  dispose() {}
  focus() {}
  loadAddon(addon: { activate?: (terminal: FakeTerminal) => void }) {
    addon.activate?.(this);
  }
  onData() {
    return { dispose: vi.fn() };
  }
  open(container: HTMLElement) {
    this.element = document.createElement("div");
    container.appendChild(this.element);
  }
  refresh() {}
  write() {}
  writeln() {}
}

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: FakeTerminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate() {}
    fit() {}
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    activate() {}
  },
}));

vi.mock("../api/terminal", () => mocks);

const labels = {
  exitedWithSignal: (signal: string) => `exited ${signal}`,
  startFailed: "failed",
  stopped: "stopped",
};

describe("terminalSessionManager", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resizeTerminal.mockClear();
    mocks.startTerminal.mockReset();
    mocks.stopTerminal.mockClear();
    mocks.writeTerminal.mockClear();
  });

  it("clears queued commands when a starting terminal session is stopped", async () => {
    const { getOrCreateTerminalSession, queueTerminalCommand } = await import(
      "./terminalSessionManager"
    );
    let resolveFirstStart: (terminalId: string) => void = () => undefined;
    mocks.startTerminal.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFirstStart = resolve;
        }),
    );
    mocks.startTerminal.mockResolvedValueOnce("terminal-2");

    queueTerminalCommand("session:/repo", "pnpm test");
    const firstSession = getOrCreateTerminalSession({
      key: "session:/repo",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    firstSession.stop();
    resolveFirstStart("terminal-1");
    await Promise.resolve();

    getOrCreateTerminalSession({
      key: "session:/repo",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    expect(mocks.writeTerminal).not.toHaveBeenCalledWith(
      "terminal-2",
      "pnpm test\r",
    );
  });

  it("clears queued commands when an unmounted tab session is stopped", async () => {
    const {
      getOrCreateTerminalSession,
      queueTerminalCommand,
      stopTerminalSession,
    } = await import("./terminalSessionManager");
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");

    queueTerminalCommand("session:tab-1", "pnpm test");

    expect(stopTerminalSession("session:tab-1")).toBe(false);

    getOrCreateTerminalSession({
      key: "session:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    expect(mocks.writeTerminal).not.toHaveBeenCalledWith(
      "terminal-1",
      "pnpm test\r",
    );
  });

  it("stops an existing tab session through the helper", async () => {
    const { getOrCreateTerminalSession, stopTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");

    getOrCreateTerminalSession({
      key: "session:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    expect(stopTerminalSession("session:tab-1", { writeStopped: true })).toBe(
      true,
    );
    expect(mocks.stopTerminal).toHaveBeenCalledWith("terminal-1");
  });

  it("restarts an existing tab session through the helper", async () => {
    const { getOrCreateTerminalSession, restartTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");
    mocks.startTerminal.mockResolvedValueOnce("terminal-2");

    getOrCreateTerminalSession({
      key: "session:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    expect(restartTerminalSession("session:tab-1")).toBe(true);

    expect(mocks.stopTerminal).toHaveBeenCalledWith("terminal-1");
    expect(mocks.startTerminal).toHaveBeenCalledTimes(2);
  });

  it("notifies session status subscribers when the backend exits", async () => {
    const changes: unknown[] = [];
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    const { getOrCreateTerminalSession, subscribeTerminalSessionStatus } =
      await import("./terminalSessionManager");
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      emitTerminalEvent = onEvent;
      return Promise.resolve("terminal-1");
    });

    subscribeTerminalSessionStatus("session:tab-1", (change) => {
      changes.push(change);
    });
    getOrCreateTerminalSession({
      key: "session:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    emitTerminalEvent({
      event: "exited",
      data: { terminalId: "terminal-1", exitCode: 0, signal: null },
    });

    expect(changes).toContainEqual({
      key: "session:tab-1",
      status: "exited",
      previousStatus: "running",
      source: "backend-exit",
    });
  });

  it("keeps pre-session status subscriptions for later backend exits", async () => {
    const changes: unknown[] = [];
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    const { getOrCreateTerminalSession, subscribeTerminalSessionStatus } =
      await import("./terminalSessionManager");
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      emitTerminalEvent = onEvent;
      return Promise.resolve("terminal-1");
    });

    subscribeTerminalSessionStatus("session:later-tab", (change) => {
      changes.push(change);
    });

    getOrCreateTerminalSession({
      key: "session:later-tab",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    emitTerminalEvent({
      event: "exited",
      data: { terminalId: "terminal-1", exitCode: 0, signal: null },
    });

    expect(changes).toContainEqual(
      expect.objectContaining({
        key: "session:later-tab",
        status: "exited",
        source: "backend-exit",
      }),
    );
  });

  it("emits client-stop when a tab session is explicitly stopped", async () => {
    const changes: unknown[] = [];
    const {
      getOrCreateTerminalSession,
      stopTerminalSession,
      subscribeTerminalSessionStatus,
    } = await import("./terminalSessionManager");
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");

    getOrCreateTerminalSession({
      key: "session:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    subscribeTerminalSessionStatus("session:tab-1", (change) => {
      changes.push(change);
    });

    stopTerminalSession("session:tab-1", { writeStopped: true });

    expect(changes).toContainEqual({
      key: "session:tab-1",
      status: "exited",
      previousStatus: "running",
      source: "client-stop",
    });
  });
});
