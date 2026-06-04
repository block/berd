import { describe, expect, it, vi } from "vitest";

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

describe("terminalSessionManager", () => {
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
      labels: {
        exitedWithSignal: (signal) => `exited ${signal}`,
        startFailed: "failed",
        stopped: "stopped",
      },
      theme: {},
      fontFamily: "monospace",
    });

    firstSession.stop();
    resolveFirstStart("terminal-1");
    await Promise.resolve();

    getOrCreateTerminalSession({
      key: "session:/repo",
      cwd: "/repo",
      labels: {
        exitedWithSignal: (signal) => `exited ${signal}`,
        startFailed: "failed",
        stopped: "stopped",
      },
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    expect(mocks.writeTerminal).not.toHaveBeenCalledWith(
      "terminal-2",
      "pnpm test\r",
    );
  });
});
