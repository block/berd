import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEvent } from "../api/terminal";

const mocks = vi.hoisted(() => ({
  resizeTerminal: vi.fn(() => Promise.resolve()),
  startTerminal: vi.fn(),
  stopTerminal: vi.fn(() => Promise.resolve()),
  terminalWriteCallbacks: [] as (() => void)[],
  writeTerminal: vi.fn(() => Promise.resolve()),
}));

class FakeTerminal {
  cols = 80;
  rows = 24;
  element: HTMLElement | null = null;
  options: { theme?: unknown; fontFamily?: string } = {};

  clear() {}
  dispose() {}
  focus = vi.fn();
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
  write = vi.fn((_data: string, callback?: () => void) => {
    if (callback) {
      mocks.terminalWriteCallbacks.push(callback);
    }
  });
  writeln = vi.fn();
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

function mockAnimationFrames() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });

  return {
    runAll: () => {
      while (callbacks.size > 0) {
        const next = callbacks.entries().next().value;
        if (!next) {
          return;
        }
        const [id, callback] = next;
        callbacks.delete(id);
        callback(performance.now());
      }
    },
  };
}

describe("terminalSessionManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mocks.resizeTerminal.mockClear();
    mocks.startTerminal.mockReset();
    mocks.stopTerminal.mockClear();
    mocks.terminalWriteCallbacks = [];
    mocks.writeTerminal.mockClear();
    document.getElementById("goose-terminal-parking-root")?.remove();
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

    queueTerminalCommand("chat-session-id:tab-1", "pnpm test");

    expect(stopTerminalSession("chat-session-id:tab-1")).toBe(false);

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
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
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    expect(
      stopTerminalSession("chat-session-id:tab-1", { writeStopped: true }),
    ).toBe(true);
    expect(mocks.stopTerminal).toHaveBeenCalledWith("terminal-1");
  });

  it("restarts an existing tab session through the helper", async () => {
    const { getOrCreateTerminalSession, restartTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");
    mocks.startTerminal.mockResolvedValueOnce("terminal-2");

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    expect(restartTerminalSession("chat-session-id:tab-1")).toBe(true);

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

    subscribeTerminalSessionStatus("chat-session-id:tab-1", (change) => {
      changes.push(change);
    });
    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
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
      key: "chat-session-id:tab-1",
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
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    await Promise.resolve();

    subscribeTerminalSessionStatus("chat-session-id:tab-1", (change) => {
      changes.push(change);
    });

    stopTerminalSession("chat-session-id:tab-1", { writeStopped: true });

    expect(changes).toContainEqual({
      key: "chat-session-id:tab-1",
      status: "exited",
      previousStatus: "running",
      source: "client-stop",
    });
  });

  it("parks a stable xterm host outside the unmounting container when detached", async () => {
    const { getOrCreateTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");
    const firstContainer = document.createElement("div");
    const secondContainer = document.createElement("div");
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    const detach = session.attach(firstContainer);
    const host = firstContainer.firstElementChild;
    const element = host?.firstElementChild;
    expect(host).toBeTruthy();
    expect(element).toBeTruthy();

    detach();

    expect(firstContainer).toBeEmptyDOMElement();
    expect(host?.parentElement).toBe(
      document.getElementById("goose-terminal-parking-root"),
    );

    session.attach(secondContainer);

    expect(secondContainer.firstElementChild).toBe(host);
    expect(host?.firstElementChild).toBe(element);
  });

  it("does not focus xterm while attaching a visible terminal", async () => {
    const { getOrCreateTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    session.attach(document.createElement("div"));

    expect(session.terminal.focus).not.toHaveBeenCalled();
  });

  it("returns terminal status snapshots", async () => {
    const { getOrCreateTerminalSession, getTerminalSessionStatus } =
      await import("./terminalSessionManager");
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");

    expect(getTerminalSessionStatus("chat-session-id:tab-1")).toBeNull();

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    expect(getTerminalSessionStatus("chat-session-id:tab-1")).toBe("starting");

    await Promise.resolve();

    expect(getTerminalSessionStatus("chat-session-id:tab-1")).toBe("running");
  });

  it("tracks chat sessions that have visible terminal state", async () => {
    const {
      getChatSessionIdsWithTerminals,
      getOrCreateTerminalSession,
      stopTerminalSession,
      subscribeTerminalSessionRegistry,
    } = await import("./terminalSessionManager");
    const snapshots: string[][] = [];
    mocks.startTerminal.mockResolvedValueOnce("terminal-1");

    const unsubscribe = subscribeTerminalSessionRegistry(() => {
      snapshots.push(Array.from(getChatSessionIdsWithTerminals()));
    });

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    expect(getChatSessionIdsWithTerminals()).toEqual(
      new Set(["chat-session-id"]),
    );
    await Promise.resolve();
    expect(getChatSessionIdsWithTerminals()).toEqual(
      new Set(["chat-session-id"]),
    );

    stopTerminalSession("chat-session-id:tab-1");
    expect(getChatSessionIdsWithTerminals()).toEqual(new Set());
    expect(snapshots).toEqual([["chat-session-id"], []]);

    unsubscribe();
  });

  it("keeps errored terminals in the chat-session terminal registry", async () => {
    const { getChatSessionIdsWithTerminals, getOrCreateTerminalSession } =
      await import("./terminalSessionManager");
    mocks.startTerminal.mockRejectedValueOnce(new Error("no shell"));

    getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });

    await Promise.resolve();

    expect(getChatSessionIdsWithTerminals()).toEqual(
      new Set(["chat-session-id"]),
    );
  });

  it("drains terminal output on animation frames after xterm parses the previous chunk", async () => {
    const frames = mockAnimationFrames();
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    const { getOrCreateTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      emitTerminalEvent = onEvent;
      return Promise.resolve("terminal-1");
    });
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    session.attach(document.createElement("div"));
    await Promise.resolve();

    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "a" },
    });
    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "b" },
    });

    expect(session.terminal.write).not.toHaveBeenCalled();

    frames.runAll();

    expect(session.terminal.write).toHaveBeenCalledTimes(1);
    expect(session.terminal.write).toHaveBeenCalledWith(
      "ab",
      expect.anything(),
    );

    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "c" },
    });

    frames.runAll();

    expect(session.terminal.write).toHaveBeenCalledTimes(1);

    mocks.terminalWriteCallbacks.shift()?.();

    frames.runAll();

    expect(session.terminal.write).toHaveBeenCalledTimes(2);
    expect(session.terminal.write).toHaveBeenLastCalledWith(
      "c",
      expect.anything(),
    );
  });

  it("queues terminal output while detached and resumes draining after attach", async () => {
    const frames = mockAnimationFrames();
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    const { getOrCreateTerminalSession } = await import(
      "./terminalSessionManager"
    );
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      emitTerminalEvent = onEvent;
      return Promise.resolve("terminal-1");
    });
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    const detach = session.attach(document.createElement("div"));
    await Promise.resolve();
    detach();

    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "detached output" },
    });
    frames.runAll();

    expect(session.terminal.write).not.toHaveBeenCalled();

    session.attach(document.createElement("div"));
    frames.runAll();

    expect(session.terminal.write).toHaveBeenCalledWith(
      "detached output",
      expect.anything(),
    );
  });

  it("buffers terminal output while rendering is suspended and resumes after", async () => {
    const frames = mockAnimationFrames();
    let emitTerminalEvent: (event: TerminalEvent) => void = () => undefined;
    const { getOrCreateTerminalSession, setTerminalRenderingSuspended } =
      await import("./terminalSessionManager");
    mocks.startTerminal.mockImplementationOnce(({ onEvent }) => {
      emitTerminalEvent = onEvent;
      return Promise.resolve("terminal-1");
    });
    const session = getOrCreateTerminalSession({
      key: "chat-session-id:tab-1",
      cwd: "/repo",
      labels,
      theme: {},
      fontFamily: "monospace",
    });
    session.attach(document.createElement("div"));
    await Promise.resolve();

    setTerminalRenderingSuspended(true);
    emitTerminalEvent({
      event: "output",
      data: { terminalId: "terminal-1", data: "suspended output" },
    });
    frames.runAll();

    expect(session.terminal.write).not.toHaveBeenCalled();

    setTerminalRenderingSuspended(false);
    frames.runAll();

    expect(session.terminal.write).toHaveBeenCalledWith(
      "suspended output",
      expect.anything(),
    );
  });
});
