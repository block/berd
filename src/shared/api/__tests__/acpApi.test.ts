import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  listSessions: vi.fn(),
  unstableForkSession: vi.fn(),
}));

vi.mock("../acpConnection", () => ({
  getClient: (...args: unknown[]) => mocks.getClient(...args),
}));

describe("listSessionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({
      listSessions: mocks.listSessions,
      unstable_forkSession: mocks.unstableForkSession,
    });
  });

  it("trims the cursor and maps session info", async () => {
    mocks.listSessions.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: "session-1",
          title: "Session one",
          updatedAt: "2026-05-01T00:00:00.000Z",
          cwd: "/tmp/project",
          _meta: {
            createdAt: "2026-04-30T00:00:00.000Z",
            archivedAt: "2026-05-02T00:00:00.000Z",
            userSetName: true,
            messageCount: 7,
            projectId: "project-1",
            providerId: "goose",
            modelId: "gpt-4.1",
            personaId: "persona-1",
          },
        },
      ],
      nextCursor: "cursor-2",
    });

    const { listSessionsPage } = await import("../acpApi");

    await expect(listSessionsPage({ cursor: " cursor-1 " })).resolves.toEqual({
      sessions: [
        {
          sessionId: "session-1",
          title: "Session one",
          updatedAt: "2026-05-01T00:00:00.000Z",
          createdAt: "2026-04-30T00:00:00.000Z",
          archivedAt: "2026-05-02T00:00:00.000Z",
          userSetName: true,
          messageCount: 7,
          workingDir: "/tmp/project",
          projectId: "project-1",
          providerId: "goose",
          modelId: "gpt-4.1",
          personaId: "persona-1",
        },
      ],
      nextCursor: "cursor-2",
    });
    expect(mocks.listSessions).toHaveBeenCalledWith({ cursor: "cursor-1" });
  });

  it("omits an empty or blank cursor at the API boundary", async () => {
    mocks.listSessions.mockResolvedValue({
      sessions: [],
      nextCursor: null,
    });

    const { listSessionsPage } = await import("../acpApi");

    await expect(listSessionsPage({ cursor: "" })).resolves.toEqual({
      sessions: [],
      nextCursor: null,
    });
    await expect(listSessionsPage({ cursor: "   " })).resolves.toEqual({
      sessions: [],
      nextCursor: null,
    });

    expect(mocks.listSessions).toHaveBeenNthCalledWith(1, {});
    expect(mocks.listSessions).toHaveBeenNthCalledWith(2, {});
  });

  it("normalizes missing and blank next cursors to null", async () => {
    mocks.listSessions
      .mockResolvedValueOnce({
        sessions: [],
      })
      .mockResolvedValueOnce({
        sessions: [],
        nextCursor: "   ",
      })
      .mockResolvedValueOnce({
        sessions: [],
        nextCursor: " cursor-2 ",
      });

    const { listSessionsPage } = await import("../acpApi");

    await expect(listSessionsPage()).resolves.toEqual({
      sessions: [],
      nextCursor: null,
    });
    await expect(listSessionsPage()).resolves.toEqual({
      sessions: [],
      nextCursor: null,
    });
    await expect(listSessionsPage()).resolves.toEqual({
      sessions: [],
      nextCursor: "cursor-2",
    });
  });

  it("propagates listSessions errors", async () => {
    const error = new Error("list failed");
    mocks.listSessions.mockRejectedValue(error);

    const { listSessionsPage } = await import("../acpApi");

    await expect(listSessionsPage()).rejects.toThrow(error);
  });
});

describe("forkSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({
      listSessions: mocks.listSessions,
      unstable_forkSession: mocks.unstableForkSession,
    });
  });

  it("passes the selected working dir and empty MCP server list", async () => {
    mocks.unstableForkSession.mockResolvedValueOnce({
      sessionId: "session-2",
      _meta: {
        createdAt: "2026-05-01T00:00:00.000Z",
        userSetName: true,
        messageCount: 7,
        projectId: "project-1",
        providerId: "goose",
        modelId: "gpt-4.1",
      },
    });

    const { forkSession } = await import("../acpApi");

    await expect(forkSession("session-1", "/tmp/project")).resolves.toEqual({
      sessionId: "session-2",
      title: null,
      updatedAt: null,
      createdAt: "2026-05-01T00:00:00.000Z",
      archivedAt: null,
      userSetName: true,
      messageCount: 7,
      workingDir: "/tmp/project",
      projectId: "project-1",
      providerId: "goose",
      modelId: "gpt-4.1",
      personaId: null,
    });
    expect(mocks.unstableForkSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/tmp/project",
      mcpServers: [],
    });
  });
});
