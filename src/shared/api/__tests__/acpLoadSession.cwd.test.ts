import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBackendClient: vi.fn(),
  sessionInfo: vi.fn(),
  loadSession: vi.fn(),
  invalidateBackendConnection: vi.fn(),
}));

vi.mock("../acpConnection", () => ({
  getClient: mocks.getBackendClient,
  getBackendClient: mocks.getBackendClient,
  invalidateBackendConnection: mocks.invalidateBackendConnection,
  captureBackendConnectionGeneration: (backendId: string) => ({
    isCurrent: () => true,
    invalidate: () => mocks.invalidateBackendConnection(backendId),
  }),
  interceptSessionNotifications: vi.fn(),
}));

// Keep acpLoadSession, the mutation registry, and acpApi real. A mock at the
// acpLoadSession boundary would hide the literal "~" sent to the backend.
describe("acpLoadSession working directory at the transport boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.invalidateBackendConnection.mockResolvedValue(undefined);
    mocks.getBackendClient.mockResolvedValue({
      goose: { GooseUnstableSessionInfo: mocks.sessionInfo },
      loadSession: mocks.loadSession,
    });
    mocks.sessionInfo.mockResolvedValue({
      session: { sessionId: "session-1", cwd: "/saved/project" },
    });
    mocks.loadSession.mockImplementation(async ({ cwd }: { cwd: string }) => {
      if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(cwd)) {
        throw new Error("cwd must be an absolute path");
      }
      return { configOptions: [] };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers the saved directory when the renderer has no workspace path", async () => {
    const { acpLoadSession } = await import("../acp");

    await acpLoadSession("session-1");

    expect(mocks.sessionInfo).toHaveBeenCalledWith({
      sessionId: "session-1",
    });
    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/saved/project",
      mcpServers: [],
    });
  });

  it("reuses the prepared directory for a post-compaction reload", async () => {
    const registry = await import("../acpSessionRegistry");
    const { acpLoadSession } = await import("../acp");
    registry.registerPreparedSession(
      "session-1",
      "openai",
      "/prepared/project",
      "test-model",
    );

    await acpLoadSession("session-1");

    expect(mocks.sessionInfo).not.toHaveBeenCalled();
    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/prepared/project",
      mcpServers: [],
    });
  });

  it.each([
    "/chosen/project",
    "/chosen/project with trailing space ",
    "C:\\Users\\dev\\project",
    "\\\\server\\share\\project",
  ])("preserves the explicit directory %s", async (workingDir) => {
    const registry = await import("../acpSessionRegistry");
    const { acpLoadSession } = await import("../acp");
    registry.registerPreparedSession("session-1", "openai", "/old/project");

    await acpLoadSession("session-1", workingDir);

    expect(mocks.sessionInfo).not.toHaveBeenCalled();
    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: workingDir,
      mcpServers: [],
    });
  });

  it("recovers a remote directory from its owning backend, not the local home", async () => {
    const { acpLoadSession } = await import("../acp");
    mocks.sessionInfo.mockResolvedValue({
      session: { sessionId: "session-1", cwd: "/remote/project" },
    });

    await acpLoadSession("ssh:devbox#session-1");

    expect(mocks.getBackendClient).toHaveBeenCalledTimes(2);
    expect(mocks.getBackendClient).toHaveBeenNthCalledWith(1, "ssh:devbox");
    expect(mocks.getBackendClient).toHaveBeenNthCalledWith(2, "ssh:devbox");
    expect(mocks.sessionInfo).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/remote/project",
      mcpServers: [],
    });
  });

  it.each([
    "",
    " \t\n",
  ])("recovers a remote directory when the renderer path is blank (%j)", async (workingDir) => {
    const { acpLoadSession } = await import("../acp");
    mocks.sessionInfo.mockResolvedValue({
      session: { sessionId: "session-1", cwd: "/remote/project" },
    });

    await acpLoadSession("ssh:devbox#session-1", workingDir);

    expect(mocks.getBackendClient).toHaveBeenCalledTimes(2);
    expect(mocks.getBackendClient).toHaveBeenNthCalledWith(1, "ssh:devbox");
    expect(mocks.getBackendClient).toHaveBeenNthCalledWith(2, "ssh:devbox");
    expect(mocks.sessionInfo).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/remote/project",
      mcpServers: [],
    });
  });

  it("reuses a prepared directory when the renderer path is blank", async () => {
    const registry = await import("../acpSessionRegistry");
    const { acpLoadSession } = await import("../acp");
    registry.registerPreparedSession(
      "session-1",
      "openai",
      "/prepared/project",
    );

    await acpLoadSession("session-1", "");

    expect(mocks.sessionInfo).not.toHaveBeenCalled();
    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/prepared/project",
      mcpServers: [],
    });
  });

  it.each([
    "",
    " \t\n",
  ])("recovers the saved directory when the prepared path is blank (%j)", async (workingDir) => {
    const registry = await import("../acpSessionRegistry");
    const { acpLoadSession } = await import("../acp");
    registry.registerPreparedSession("session-1", "openai", workingDir);

    await acpLoadSession("session-1");

    expect(mocks.sessionInfo).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/saved/project",
      mcpServers: [],
    });
  });

  it.each([
    null,
    "",
    " \t\n",
  ])("does not invent a directory when backend metadata returns %s", async (cwd) => {
    const { acpLoadSession } = await import("../acp");
    mocks.sessionInfo.mockResolvedValue({
      session: { sessionId: "session-1", cwd },
    });

    await expect(acpLoadSession("session-1")).rejects.toThrow(
      "Session working directory is unavailable",
    );

    expect(mocks.loadSession).not.toHaveBeenCalled();
  });

  it("does not send a fallback directory when metadata lookup fails", async () => {
    const { acpLoadSession } = await import("../acp");
    mocks.sessionInfo.mockRejectedValue(new Error("session info unavailable"));

    await expect(acpLoadSession("session-1")).rejects.toThrow(
      "session info unavailable",
    );

    expect(mocks.loadSession).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: "session-1", backendId: "local", stalledCleanup: false },
    {
      sessionId: "ssh:devbox#session-1",
      backendId: "ssh:devbox",
      stalledCleanup: false,
    },
    { sessionId: "session-1", backendId: "local", stalledCleanup: true },
    {
      sessionId: "ssh:devbox#session-1",
      backendId: "ssh:devbox",
      stalledCleanup: true,
    },
  ])("times out stuck metadata for $sessionId and admits an explicit queued load (stalled cleanup: $stalledCleanup)", async ({
    sessionId,
    backendId,
    stalledCleanup,
  }) => {
    vi.useFakeTimers();
    const { acpLoadSession } = await import("../acp");
    mocks.sessionInfo.mockReturnValueOnce(new Promise(() => {}));
    if (stalledCleanup) {
      mocks.invalidateBackendConnection.mockReturnValueOnce(
        new Promise(() => {}),
      );
    }

    let recoveryRejected = false;
    const recovery = acpLoadSession(sessionId);
    const recoveryRejection = expect(recovery)
      .rejects.toThrow("ACP operation timed out")
      .then(() => {
        recoveryRejected = true;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sessionInfo).toHaveBeenCalledOnce();
    const newerLoad = acpLoadSession(sessionId, "/new/project");

    await vi.advanceTimersByTimeAsync(59_999);
    expect(mocks.invalidateBackendConnection).not.toHaveBeenCalled();
    expect(mocks.loadSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.invalidateBackendConnection).toHaveBeenCalledOnce();
    expect(mocks.invalidateBackendConnection).toHaveBeenCalledWith(backendId);
    // Check settlement before awaiting, so stalled cleanup fails at the
    // liveness bound instead of hanging the test itself.
    expect(recoveryRejected).toBe(true);
    await recoveryRejection;
    await newerLoad;

    expect(mocks.getBackendClient).toHaveBeenLastCalledWith(backendId);
    expect(mocks.loadSession).toHaveBeenCalledOnce();
    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/new/project",
      mcpServers: [],
    });
    expect(
      mocks.invalidateBackendConnection.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.loadSession.mock.invocationCallOrder[0]);

    await acpLoadSession(sessionId);
    expect(mocks.sessionInfo).toHaveBeenCalledOnce();
    expect(mocks.loadSession).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      cwd: "/new/project",
      mcpServers: [],
    });
  });

  it.each([
    "resolve",
    "reject",
  ])("ignores metadata that %ss after a timeout and a newer explicit load", async (settlement) => {
    vi.useFakeTimers();
    const { acpLoadSession } = await import("../acp");
    let resolveInfo!: (value: unknown) => void;
    let rejectInfo!: (reason: unknown) => void;
    mocks.sessionInfo.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        resolveInfo = resolve;
        rejectInfo = reject;
      }),
    );
    const recovery = acpLoadSession("ssh:devbox#session-1");
    const recoveryRejection = expect(recovery).rejects.toThrow(
      "ACP operation timed out",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.invalidateBackendConnection).toHaveBeenCalledOnce();
    await recoveryRejection;
    await acpLoadSession("ssh:devbox#session-1", "/new/project");

    if (settlement === "resolve") {
      resolveInfo({
        session: { sessionId: "session-1", cwd: "/stale/project" },
      });
    } else {
      rejectInfo(new Error("late metadata failure"));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.loadSession).toHaveBeenCalledOnce();
    expect(mocks.invalidateBackendConnection).toHaveBeenCalledOnce();

    await acpLoadSession("ssh:devbox#session-1");
    expect(mocks.sessionInfo).toHaveBeenCalledOnce();
    expect(mocks.loadSession).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      cwd: "/new/project",
      mcpServers: [],
    });
  });

  it("does not apply the metadata timeout to a long history replay", async () => {
    vi.useFakeTimers();
    const { acpLoadSession } = await import("../acp");
    let resolveLoad!: (value: unknown) => void;
    mocks.loadSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const load = acpLoadSession("session-1");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.sessionInfo).toHaveBeenCalledOnce();
    expect(mocks.loadSession).toHaveBeenCalledOnce();
    expect(mocks.invalidateBackendConnection).not.toHaveBeenCalled();

    resolveLoad({ configOptions: [] });
    await load;
    await acpLoadSession("session-1");
    expect(mocks.sessionInfo).toHaveBeenCalledOnce();
    expect(mocks.loadSession).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      cwd: "/saved/project",
      mcpServers: [],
    });
  });

  it("serializes directory recovery with later loads and retains the latest cwd", async () => {
    const { acpLoadSession } = await import("../acp");
    let resolveInfo!: (value: unknown) => void;
    mocks.sessionInfo.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInfo = resolve;
      }),
    );

    const coldLoad = acpLoadSession("session-1");
    await vi.waitFor(() => expect(mocks.sessionInfo).toHaveBeenCalledTimes(1));
    const newerLoad = acpLoadSession("session-1", "/new/project");
    expect(mocks.loadSession).not.toHaveBeenCalled();

    resolveInfo({ session: { sessionId: "session-1", cwd: "/saved/project" } });
    await Promise.all([coldLoad, newerLoad]);
    await acpLoadSession("session-1");

    expect(mocks.sessionInfo).toHaveBeenCalledTimes(1);
    expect(
      mocks.loadSession.mock.calls.map(([request]) => request.cwd),
    ).toEqual(["/saved/project", "/new/project", "/new/project"]);
  });
});
