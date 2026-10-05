import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBackendClient: vi.fn(),
  sessionInfo: vi.fn(),
  loadSession: vi.fn(),
}));

vi.mock("../acpConnection", () => ({
  getClient: mocks.getBackendClient,
  getBackendClient: mocks.getBackendClient,
  invalidateBackendConnection: vi.fn(),
  interceptSessionNotifications: vi.fn(),
}));

// Keep acpLoadSession, the mutation registry, and acpApi real. A mock at the
// acpLoadSession boundary would hide the literal "~" sent to the backend.
describe("acpLoadSession working directory at the transport boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
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
