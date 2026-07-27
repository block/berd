import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrCreateTerminalSession: vi.fn(),
  getTerminalSession: vi.fn(),
  stopTerminalSession: vi.fn(),
}));

vi.mock("./terminalSessionManager", () => mocks);

describe("ACP terminal manager", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("crypto", { randomUUID: () => "terminal-1" });
  });

  it("creates an agent terminal, captures output, and exposes it for opening", async () => {
    let onOutput: ((data: string) => void) | undefined;
    let onExit:
      | ((status: { exitCode: number | null; signal: string | null }) => void)
      | undefined;
    mocks.getOrCreateTerminalSession.mockImplementation((options) => {
      onOutput = options.onOutput;
      onExit = options.onExit;
      return { kill: vi.fn(() => Promise.resolve()) };
    });

    const manager = await import("./acpTerminalManager");
    const created = await manager.createAcpTerminal({
      sessionId: "session-1",
      command: "pnpm",
      args: ["dev"],
      cwd: "/repo",
      outputByteLimit: 1024,
    });

    expect(created).toEqual({ terminalId: "agent-terminal-1" });
    expect(mocks.getOrCreateTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "session-1:agent-terminal-1",
        cwd: "/repo",
        launch: { command: "pnpm", args: ["dev"], env: {} },
      }),
    );

    onOutput?.("Server ready on http://localhost:5173");
    await expect(
      manager.readAcpTerminalOutput({
        sessionId: "session-1",
        terminalId: created.terminalId,
      }),
    ).resolves.toMatchObject({
      output: "Server ready on http://localhost:5173",
      truncated: false,
      exitStatus: null,
    });

    const listener = vi.fn();
    manager.subscribeAcpTerminalOpenRequests(listener);
    expect(
      manager.requestOpenAcpTerminal("session-1", created.terminalId),
    ).toBe(true);
    expect(listener).toHaveBeenCalledWith({
      sessionId: "session-1",
      terminalId: created.terminalId,
      cwd: "/repo",
      title: "pnpm dev",
      focus: true,
    });

    onExit?.({ exitCode: 0, signal: null });
    await expect(
      manager.waitForAcpTerminalExit({
        sessionId: "session-1",
        terminalId: created.terminalId,
      }),
    ).resolves.toEqual({ exitCode: 0, signal: null });
  });

  it("uses the shell expression as the tab title for wrapped commands", async () => {
    mocks.getOrCreateTerminalSession.mockReturnValue({
      kill: vi.fn(() => Promise.resolve()),
    });

    const manager = await import("./acpTerminalManager");
    const { terminalId } = await manager.createAcpTerminal({
      sessionId: "session-1",
      command: "sh",
      args: [
        "-c",
        'python3 -m http.server 8775\n__goose_command_status=$?\nwait\nexit "$__goose_command_status"',
      ],
    });
    const listener = vi.fn();
    manager.subscribeAcpTerminalOpenRequests(listener);

    expect(manager.requestOpenAcpTerminal("session-1", terminalId)).toBe(true);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ title: "python3 -m http.server 8775" }),
    );
  });

  it("seeds externally managed terminals with honest process context", async () => {
    const writeOutput = vi.fn();
    mocks.getOrCreateTerminalSession.mockReturnValue({
      kill: vi.fn(() => Promise.resolve()),
      writeOutput,
    });

    const manager = await import("./acpTerminalManager");
    const registration = {
      sessionId: "session-1",
      terminalId: "codex-command-1",
      cwd: "/repo",
      title: "python3 -m http.server 8767",
    };
    await manager.registerExternalAcpTerminal(registration);
    await manager.registerExternalAcpTerminal(registration);

    expect(mocks.getOrCreateTerminalSession).toHaveBeenCalledTimes(1);
    expect(writeOutput).toHaveBeenCalledTimes(2);
    expect(writeOutput).toHaveBeenNthCalledWith(
      1,
      "$ python3 -m http.server 8767\r\n",
    );
    expect(writeOutput).toHaveBeenNthCalledWith(
      2,
      "Running in /repo · live output is read-only\r\n\r\n",
    );

    const listener = vi.fn();
    manager.subscribeAcpTerminalOpenRequests(listener);
    expect(manager.requestOpenAcpTerminal("session-1", "codex-command-1")).toBe(
      true,
    );
    manager.closeAcpTerminalDisplay("session-1", "codex-command-1");
    expect(
      manager.requestOpenAcpTerminal("session-1", "codex-command-1", {
        automatic: true,
      }),
    ).toBe(false);
    expect(manager.requestOpenAcpTerminal("session-1", "codex-command-1")).toBe(
      true,
    );
  });

  it("notifies capability subscribers across registration and teardown", async () => {
    mocks.getOrCreateTerminalSession.mockReturnValue({
      kill: vi.fn(() => Promise.resolve()),
      writeOutput: vi.fn(),
      finishExternal: vi.fn(),
    });
    const manager = await import("./acpTerminalManager");
    const listener = vi.fn();
    manager.subscribeAcpTerminalCapability(
      "session-1",
      "provider-command",
      listener,
    );

    await manager.registerExternalAcpTerminal({
      sessionId: "session-1",
      terminalId: "provider-command",
      cwd: "/repo",
      title: "server",
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.hasAcpTerminal("session-1", "provider-command")).toBe(true);

    await manager.teardownAcpTerminals();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(manager.hasAcpTerminal("session-1", "provider-command")).toBe(false);

    await manager.registerExternalAcpTerminal({
      sessionId: "session-1",
      terminalId: "provider-command",
      cwd: "/repo",
      title: "server again",
    });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("isolates equal terminal ids across ACP sessions", async () => {
    mocks.getOrCreateTerminalSession.mockImplementation(() => ({
      kill: vi.fn(() => Promise.resolve()),
      writeOutput: vi.fn(),
      finishExternal: vi.fn(),
    }));

    const manager = await import("./acpTerminalManager");
    await manager.registerExternalAcpTerminal({
      sessionId: "session-1",
      terminalId: "command-1",
      cwd: "/one",
      title: "one",
    });
    await manager.registerExternalAcpTerminal({
      sessionId: "session-2",
      terminalId: "command-1",
      cwd: "/two",
      title: "two",
    });

    expect(mocks.getOrCreateTerminalSession).toHaveBeenCalledTimes(2);
    expect(manager.hasAcpTerminal("session-1", "command-1")).toBe(true);
    expect(manager.hasAcpTerminal("session-2", "command-1")).toBe(true);

    const listener = vi.fn();
    manager.subscribeAcpTerminalOpenRequests(listener);
    manager.closeAcpTerminalDisplay("session-1", "command-1");
    expect(
      manager.requestOpenAcpTerminal("session-1", "command-1", {
        automatic: true,
      }),
    ).toBe(false);
    expect(
      manager.requestOpenAcpTerminal("session-2", "command-1", {
        automatic: true,
      }),
    ).toBe(true);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-2", cwd: "/two" }),
    );
  });

  it("buffers external output and exit until registration", async () => {
    const writeOutput = vi.fn();
    const finishExternal = vi.fn();
    mocks.getOrCreateTerminalSession.mockReturnValue({
      kill: vi.fn(() => Promise.resolve()),
      writeOutput,
      finishExternal,
    });

    const manager = await import("./acpTerminalManager");
    await manager.appendExternalAcpTerminalOutput(
      "session-1",
      "command-1",
      "early output\n",
    );
    await manager.finishExternalAcpTerminal("session-1", "command-1", {
      exitCode: 7,
      signal: null,
    });
    await manager.registerExternalAcpTerminal({
      sessionId: "session-1",
      terminalId: "command-1",
      cwd: "/repo",
      title: "build",
    });

    expect(writeOutput).toHaveBeenCalledWith("early output\n");
    expect(finishExternal).toHaveBeenCalledWith({ exitCode: 7, signal: null });
  });

  it("enforces the ACP output byte limit at a character boundary", async () => {
    let onOutput: ((data: string) => void) | undefined;
    mocks.getOrCreateTerminalSession.mockImplementation((options) => {
      onOutput = options.onOutput;
      return { kill: vi.fn(() => Promise.resolve()) };
    });

    const manager = await import("./acpTerminalManager");
    const { terminalId } = await manager.createAcpTerminal({
      sessionId: "session-1",
      command: "echo",
      outputByteLimit: 2,
    });
    onOutput?.("aéz");

    await expect(
      manager.readAcpTerminalOutput({ sessionId: "session-1", terminalId }),
    ).resolves.toMatchObject({ output: "z", truncated: true });
  });

  it("notifies stop capability subscribers when ownership starts and ends", async () => {
    let onExit:
      | ((status: { exitCode: number | null; signal: string | null }) => void)
      | undefined;
    mocks.getOrCreateTerminalSession.mockImplementation((options) => {
      onExit = options.onExit;
      return { kill: vi.fn(() => Promise.resolve()) };
    });

    const manager = await import("./acpTerminalManager");
    const listener = vi.fn();
    const unsubscribe = manager.subscribeAcpTerminalCapability(
      "session-1",
      "agent-terminal-1",
      listener,
    );
    const { terminalId } = await manager.createAcpTerminal({
      sessionId: "session-1",
      command: "server",
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(manager.canStopAcpTerminal("session-1", terminalId)).toBe(true);
    onExit?.({ exitCode: 0, signal: null });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(manager.canStopAcpTerminal("session-1", terminalId)).toBe(false);
    unsubscribe();
  });

  it("stops client-hosted terminals but not provider-hosted displays", async () => {
    let onExit:
      | ((status: { exitCode: number | null; signal: string | null }) => void)
      | undefined;
    const kill = vi.fn(async () => {
      onExit?.({ exitCode: 0, signal: null });
    });
    mocks.getOrCreateTerminalSession.mockImplementation((options) => {
      onExit = options.onExit;
      return { kill, writeOutput: vi.fn() };
    });

    const manager = await import("./acpTerminalManager");
    const { terminalId } = await manager.createAcpTerminal({
      sessionId: "session-1",
      command: "server",
    });
    expect(manager.canStopAcpTerminal("session-1", terminalId)).toBe(true);
    await expect(
      manager.stopAcpTerminal("session-1", terminalId),
    ).resolves.toBe(true);
    expect(kill).toHaveBeenCalledOnce();

    await manager.registerExternalAcpTerminal({
      sessionId: "session-1",
      terminalId: "provider-command",
      cwd: "/repo",
      title: "provider server",
    });
    expect(manager.canStopAcpTerminal("session-1", "provider-command")).toBe(
      false,
    );
    await expect(
      manager.stopAcpTerminal("session-1", "provider-command"),
    ).resolves.toBe(false);
  });

  it("does not resolve Stop until the native backend reports exit", async () => {
    let onExit:
      | ((status: { exitCode: number | null; signal: string | null }) => void)
      | undefined;
    let resolveKill: (() => void) | undefined;
    const kill = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveKill = resolve;
        }),
    );
    mocks.getOrCreateTerminalSession.mockImplementation((options) => {
      onExit = options.onExit;
      return { kill };
    });

    const manager = await import("./acpTerminalManager");
    const { terminalId } = await manager.createAcpTerminal({
      sessionId: "session-1",
      command: "server",
    });
    const stopped = manager.stopAcpTerminal("session-1", terminalId);
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    onExit?.({ exitCode: null, signal: "SIGHUP" });
    resolveKill?.();
    await expect(stopped).resolves.toBe(true);
  });

  it("keeps a released terminal displayable while invalidating ACP methods", async () => {
    let onExit:
      | ((status: { exitCode: number | null; signal: string | null }) => void)
      | undefined;
    const kill = vi.fn(async () => {
      onExit?.({ exitCode: 0, signal: null });
    });
    mocks.getOrCreateTerminalSession.mockImplementation((options) => {
      onExit = options.onExit;
      return { kill };
    });

    const manager = await import("./acpTerminalManager");
    const { terminalId } = await manager.createAcpTerminal({
      sessionId: "session-1",
      command: "server",
    });
    await manager.releaseAcpTerminal({ sessionId: "session-1", terminalId });

    expect(kill).toHaveBeenCalledOnce();
    expect(manager.hasAcpTerminal("session-1", terminalId)).toBe(true);
    await expect(
      manager.readAcpTerminalOutput({ sessionId: "session-1", terminalId }),
    ).rejects.toThrow("Terminal session was not found");
  });

  it("tears down connection-owned terminals, waiters, displays, and tabs", async () => {
    const kill = vi.fn(() => Promise.resolve());
    const terminalSession = {
      kill,
      writeOutput: vi.fn(),
      finishExternal: vi.fn(),
    };
    mocks.getOrCreateTerminalSession.mockReturnValue(terminalSession);
    mocks.getTerminalSession.mockReturnValue(terminalSession);

    const tabState = await import("./acpTerminalTabState");
    const manager = await import("./acpTerminalManager");
    const { terminalId } = await manager.createAcpTerminal({
      sessionId: "session-1",
      command: "server",
    });
    const exit = manager.waitForAcpTerminalExit({
      sessionId: "session-1",
      terminalId,
    });
    tabState.setAgentTerminalTabState("session-1", {
      tabs: [{ id: terminalId, cwd: "/repo", source: "agent" }],
      activeTabId: terminalId,
      expanded: true,
      placement: {
        kind: "docked",
        region: "chatColumn",
        slot: "bottom",
        size: { height: 300 },
      },
    });

    await manager.teardownAcpTerminals();

    await expect(exit).resolves.toEqual({ exitCode: null, signal: "SIGTERM" });
    expect(kill).toHaveBeenCalledOnce();
    expect(mocks.stopTerminalSession).toHaveBeenCalledWith(
      `session-1:${terminalId}`,
    );
    expect(manager.hasAcpTerminal("session-1", terminalId)).toBe(false);
    expect(tabState.getAgentTerminalTabState("session-1").tabs).toEqual([]);
    await expect(
      manager.readAcpTerminalOutput({ sessionId: "session-1", terminalId }),
    ).rejects.toThrow("Terminal session was not found");
  });

  it("bounds unknown terminal output before registration", async () => {
    const writeOutput = vi.fn();
    mocks.getOrCreateTerminalSession.mockReturnValue({
      kill: vi.fn(() => Promise.resolve()),
      writeOutput,
      finishExternal: vi.fn(),
    });
    const manager = await import("./acpTerminalManager");
    const chunk = "x".repeat(1024 * 1024);

    await manager.appendExternalAcpTerminalOutput(
      "session-1",
      "unknown-terminal",
      `prefix${chunk}suffix`,
    );
    await manager.registerExternalAcpTerminal({
      sessionId: "session-1",
      terminalId: "unknown-terminal",
      cwd: "/repo",
      title: "server",
    });

    const bufferedOutput = writeOutput.mock.calls.at(-1)?.[0] as string;
    expect(
      new TextEncoder().encode(bufferedOutput).byteLength,
    ).toBeLessThanOrEqual(1024 * 1024);
    expect(bufferedOutput.endsWith("suffix")).toBe(true);
    expect(bufferedOutput.startsWith("prefix")).toBe(false);
  });

  it("honors an ACP output byte limit of zero", async () => {
    let onOutput: ((data: string) => void) | undefined;
    mocks.getOrCreateTerminalSession.mockImplementation((options) => {
      onOutput = options.onOutput;
      return { kill: vi.fn(() => Promise.resolve()) };
    });

    const manager = await import("./acpTerminalManager");
    const { terminalId } = await manager.createAcpTerminal({
      sessionId: "session-1",
      command: "echo",
      outputByteLimit: 0,
    });
    onOutput?.("output");

    await expect(
      manager.readAcpTerminalOutput({ sessionId: "session-1", terminalId }),
    ).resolves.toMatchObject({ output: "", truncated: true });
  });
});
