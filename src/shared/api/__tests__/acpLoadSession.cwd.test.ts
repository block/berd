import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBackendClient: vi.fn(),
  sessionInfo: vi.fn(),
  resolvePath: vi.fn(),
  loadSession: vi.fn(),
  invalidateBackendConnection: vi.fn(),
  generations: new Map<string, number>(),
}));

vi.mock("../acpConnection", () => ({
  getClient: mocks.getBackendClient,
  getBackendClient: mocks.getBackendClient,
  invalidateBackendConnection: mocks.invalidateBackendConnection,
  captureBackendConnectionGeneration: (backendId: string) => {
    const generation = mocks.generations.get(backendId) ?? 0;
    return {
      isCurrent: () => (mocks.generations.get(backendId) ?? 0) === generation,
      invalidate: () => mocks.invalidateBackendConnection(backendId),
    };
  },
  interceptSessionNotifications: vi.fn(),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: mocks.resolvePath,
}));

// Keep acpLoadSession, the mutation registry, and acpApi real. A mock at the
// acpLoadSession boundary would hide the literal "~" sent to the backend.
describe("acpLoadSession working directory at the transport boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.generations.clear();
    mocks.resolvePath.mockResolvedValue({ path: "/Users/dev" });
    mocks.invalidateBackendConnection.mockImplementation(
      async (backendId: string) => {
        mocks.generations.set(
          backendId,
          (mocks.generations.get(backendId) ?? 0) + 1,
        );
      },
    );
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

  it.each([
    ["~/goose artifacts", "/Users/dev", "/Users/dev/goose artifacts"],
    ["~", "/Users/dev", "/Users/dev"],
    ["~\\project", "C:\\Users\\dev", "C:\\Users\\dev\\project"],
    [
      "~/ project with trailing space ",
      "/Users/dev",
      "/Users/dev/ project with trailing space ",
    ],
  ])("expands the local home prefix in %s before transport", async (cwd, home, expected) => {
    const { acpLoadSession } = await import("../acp");
    mocks.resolvePath.mockResolvedValue({ path: home });

    await acpLoadSession("session-1", cwd);

    expect(mocks.resolvePath).toHaveBeenCalledExactlyOnceWith({ parts: ["~"] });
    expect(mocks.sessionInfo).not.toHaveBeenCalled();
    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: expected,
      mcpServers: [],
    });
    // The prepared cwd is absolute too, so a later reload needs no resolution.
    await acpLoadSession("session-1");
    expect(mocks.resolvePath).toHaveBeenCalledOnce();
    expect(mocks.loadSession).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      cwd: expected,
      mcpServers: [],
    });
  });

  it.each([
    "prepared",
    "metadata",
  ])("expands a local home prefix from %s", async (source) => {
    const registry = await import("../acpSessionRegistry");
    const { acpLoadSession } = await import("../acp");
    if (source === "prepared") {
      registry.registerPreparedSession(
        "session-1",
        "openai",
        "~/goose artifacts",
      );
    } else {
      mocks.sessionInfo.mockResolvedValue({
        session: { sessionId: "session-1", cwd: "~/goose artifacts" },
      });
    }

    await acpLoadSession("session-1");

    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/Users/dev/goose artifacts",
      mcpServers: [],
    });
  });

  it.each([
    "ssh:devbox#session-1",
    "registered-remote",
  ])("preserves remote home paths for %s", async (sessionId) => {
    const { registerSessionBackend } = await import("../acpSessionBackends");
    const { acpLoadSession } = await import("../acp");
    if (sessionId === "registered-remote") {
      registerSessionBackend(sessionId, "ssh:devbox", "session-1");
    }
    mocks.loadSession.mockResolvedValue({ configOptions: [] });

    await acpLoadSession(sessionId, "~/goose artifacts");

    expect(mocks.resolvePath).not.toHaveBeenCalled();
    expect(mocks.getBackendClient).toHaveBeenLastCalledWith("ssh:devbox");
    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "~/goose artifacts",
      mcpServers: [],
    });
  });

  it("does not expand named-user home paths", async () => {
    const { acpLoadSession } = await import("../acp");

    await expect(
      acpLoadSession("session-1", "~someone/project"),
    ).rejects.toThrow("cwd must be an absolute path");

    expect(mocks.resolvePath).not.toHaveBeenCalled();
  });

  it("does not dispatch history when home resolution fails", async () => {
    const { acpLoadSession } = await import("../acp");
    mocks.resolvePath.mockRejectedValue(new Error("home unavailable"));

    await expect(
      acpLoadSession("session-1", "~/goose artifacts"),
    ).rejects.toThrow("home unavailable");

    expect(mocks.loadSession).not.toHaveBeenCalled();
  });

  it("times out home resolution and admits a queued absolute load", async () => {
    vi.useFakeTimers();
    const { acpLoadSession } = await import("../acp");
    let resolveHome!: (value: { path: string }) => void;
    mocks.resolvePath.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHome = resolve;
      }),
    );
    const rejection = expect(
      acpLoadSession("session-1", "~/goose artifacts"),
    ).rejects.toThrow("ACP operation timed out");
    await vi.advanceTimersByTimeAsync(0);
    const newerLoad = acpLoadSession("session-1", "/new/project");

    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    await newerLoad;
    resolveHome({ path: "/stale/home" });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.invalidateBackendConnection).toHaveBeenCalledExactlyOnceWith(
      "local",
    );
    expect(mocks.loadSession).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-1",
      cwd: "/new/project",
      mcpServers: [],
    });
    await acpLoadSession("session-1");
    expect(mocks.loadSession).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      cwd: "/new/project",
      mcpServers: [],
    });
  });

  it("does not dispatch replay when the connection detaches during home resolution", async () => {
    const { acpLoadSession } = await import("../acp");
    let resolveHome!: (value: { path: string }) => void;
    mocks.resolvePath.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHome = resolve;
      }),
    );
    const rejection = expect(
      acpLoadSession("session-1", "~/goose artifacts"),
    ).rejects.toThrow("ACP history replay was abandoned");
    await vi.waitFor(() => expect(mocks.resolvePath).toHaveBeenCalledOnce());

    await mocks.invalidateBackendConnection("local");
    resolveHome({ path: "/Users/dev" });
    await rejection;

    expect(mocks.loadSession).not.toHaveBeenCalled();
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

  it.each([
    { sessionId: "session-1", backendId: "local" },
    { sessionId: "ssh:devbox#session-1", backendId: "ssh:devbox" },
  ])("does not commit or publish a detached $backendId replay", async ({
    sessionId,
    backendId,
  }) => {
    const registry = await import("../acpSessionRegistry");
    const { acpLoadSession } = await import("../acp");
    const { setSessionConfigSnapshotHandlers } = await import(
      "../acpSessionConfigSnapshots"
    );
    const publish = vi.fn();
    setSessionConfigSnapshotHandlers({ applyConfigSnapshots: publish });
    registry.registerPreparedSession(
      sessionId,
      "openai",
      "/old/project",
      "old-model",
    );
    let resolveLoad!: (value: unknown) => void;
    mocks.loadSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const replay = acpLoadSession(sessionId);
    const rejection = expect(replay).rejects.toThrow(
      "ACP history replay was abandoned",
    );
    await vi.waitFor(() => expect(mocks.loadSession).toHaveBeenCalledOnce());
    await mocks.invalidateBackendConnection(backendId);
    registry.registerPreparedSession(
      sessionId,
      "anthropic",
      "/replacement/project",
      "replacement-model",
    );
    resolveLoad({
      configOptions: [
        {
          id: "provider",
          kind: { type: "select", currentValue: "openai", options: [] },
        },
        {
          id: "model",
          category: "model",
          kind: { type: "select", currentValue: "stale-model", options: [] },
        },
      ],
    });
    await rejection;
    expect(publish).not.toHaveBeenCalled();
    expect(registry.requireSessionInvocationSelection(sessionId)).toEqual({
      providerId: "anthropic",
      modelId: "replacement-model",
    });
    await acpLoadSession(sessionId);
    expect(mocks.sessionInfo).not.toHaveBeenCalled();
    expect(mocks.loadSession).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      cwd: "/replacement/project",
      mcpServers: [],
    });
  });

  it("rechecks the replay generation after registry settlement and before snapshot publication", async () => {
    const registry = await import("../acpSessionRegistry");
    const { acpLoadSession } = await import("../acp");
    const { setSessionConfigSnapshotHandlers } = await import(
      "../acpSessionConfigSnapshots"
    );
    const publish = vi.fn();
    setSessionConfigSnapshotHandlers({ applyConfigSnapshots: publish });
    const realLoad = registry.loadSession;
    const spy = vi
      .spyOn(registry, "loadSession")
      .mockImplementationOnce(async (...args) => {
        const result = await realLoad(...args);
        await mocks.invalidateBackendConnection("local");
        registry.registerPreparedSession(
          "session-1",
          "anthropic",
          "/replacement/project",
          "replacement-model",
        );
        return result;
      });
    try {
      await expect(acpLoadSession("session-1", "/old/project")).rejects.toThrow(
        "ACP history replay was abandoned",
      );
      expect(publish).not.toHaveBeenCalled();
      expect(registry.requireSessionInvocationSelection("session-1")).toEqual({
        providerId: "anthropic",
        modelId: "replacement-model",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("does not dispatch replay after its client lookup detaches", async () => {
    const { acpLoadSession } = await import("../acp");
    let resolveClient!: (value: unknown) => void;
    mocks.getBackendClient.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClient = resolve;
      }),
    );
    const replay = acpLoadSession("session-1", "/old/project");
    const rejection = expect(replay).rejects.toThrow(
      "ACP history replay was abandoned",
    );
    await vi.waitFor(() =>
      expect(mocks.getBackendClient).toHaveBeenCalledOnce(),
    );
    await mocks.invalidateBackendConnection("local");
    resolveClient({ loadSession: mocks.loadSession });
    await rejection;
    expect(mocks.loadSession).not.toHaveBeenCalled();
  });

  it("does not dispatch metadata after a timed-out client lookup settles", async () => {
    vi.useFakeTimers();
    const { acpLoadSession } = await import("../acp");
    let resolveClient!: (value: unknown) => void;
    mocks.getBackendClient.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClient = resolve;
      }),
    );
    const recovery = acpLoadSession("session-1");
    const rejection = expect(recovery).rejects.toThrow(
      "ACP operation timed out",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    await acpLoadSession("session-1", "/new/project");

    resolveClient({ goose: { GooseUnstableSessionInfo: mocks.sessionInfo } });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.sessionInfo).not.toHaveBeenCalled();
    expect(mocks.loadSession).toHaveBeenCalledOnce();
    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/new/project",
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
