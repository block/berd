import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionConfigSnapshotHandlers,
  setSessionConfigSnapshotHandlers,
} from "../acpSessionConfigSnapshots";

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  listSessions: vi.fn(),
  unstableForkSession: vi.fn(),
  newSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
}));

const includeLastMessageSnippetMeta = {
  _meta: {
    goose: {
      includeLastMessageSnippet: true,
    },
  },
};

function createConfigOptionsResponse() {
  return {
    configOptions: [
      {
        id: "model",
        category: "model",
        kind: {
          type: "select",
          currentValue: "claude-opus-4-8",
          options: {
            type: "ungrouped",
            values: [{ value: "claude-opus-4-8", name: "Claude Opus 4.8" }],
          },
        },
      },
      {
        id: "thinking_effort",
        category: "thought_level",
        kind: {
          type: "select",
          currentValue: "high",
          options: {
            type: "ungrouped",
            values: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
        },
      },
    ],
  };
}

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
            lastMessageAt: "2026-05-01T12:00:00.000Z",
            archivedAt: "2026-05-02T00:00:00.000Z",
            userSetName: true,
            messageCount: 7,
            lastMessageSnippet: "Let's refactor the session list query",
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
          lastMessageAt: "2026-05-01T12:00:00.000Z",
          archivedAt: "2026-05-02T00:00:00.000Z",
          userSetName: true,
          messageCount: 7,
          subtitle: "Let's refactor the session list query",
          workingDir: "/tmp/project",
          projectId: "project-1",
          providerId: "goose",
          modelId: "gpt-4.1",
          personaId: "persona-1",
        },
      ],
      nextCursor: "cursor-2",
    });
    expect(mocks.listSessions).toHaveBeenCalledWith({
      ...includeLastMessageSnippetMeta,
      cursor: "cursor-1",
    });
  });

  it("ignores malformed session metadata values", async () => {
    mocks.listSessions.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: "session-1",
          title: "Session one",
          updatedAt: "2026-05-01T00:00:00.000Z",
          cwd: "/tmp/project",
          _meta: {
            createdAt: 123,
            lastMessageAt: { at: "2026-05-01T12:00:00.000Z" },
            archivedAt: false,
            messageCount: "7",
            projectId: ["project-1"],
            providerId: null,
            modelId: 4,
            personaId: true,
          },
        },
      ],
      nextCursor: null,
    });

    const { listSessionsPage } = await import("../acpApi");

    await expect(listSessionsPage()).resolves.toEqual({
      sessions: [
        {
          sessionId: "session-1",
          title: "Session one",
          updatedAt: "2026-05-01T00:00:00.000Z",
          createdAt: null,
          lastMessageAt: null,
          archivedAt: null,
          userSetName: false,
          messageCount: 0,
          subtitle: null,
          workingDir: "/tmp/project",
          projectId: null,
          providerId: null,
          modelId: null,
          personaId: null,
        },
      ],
      nextCursor: null,
    });
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

    expect(mocks.listSessions).toHaveBeenNthCalledWith(
      1,
      includeLastMessageSnippetMeta,
    );
    expect(mocks.listSessions).toHaveBeenNthCalledWith(
      2,
      includeLastMessageSnippetMeta,
    );
  });

  it("strips markdown and normalizes subtitles from session list metadata", async () => {
    // The backend reverted its markdown stripping, so the canonical snippet
    // ships raw markdown; the ACP->subtitle mapping must strip it on ingest.
    mocks.listSessions.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: "bold-session",
          _meta: { lastMessageSnippet: "**bold** update" },
        },
        {
          sessionId: "plain-session",
          _meta: { lastMessageSnippet: "hello world" },
        },
        {
          sessionId: "markdown-session",
          _meta: {
            lastMessageSnippet:
              "## **Big**   _Title_\n\nwith [docs](https://example.com)",
          },
        },
        {
          sessionId: "long-session",
          _meta: {
            lastMessageSnippet: `**${"x".repeat(130)}**`,
          },
        },
        {
          sessionId: "missing-snippet-session",
          _meta: {},
        },
        {
          sessionId: "missing-meta-session",
        },
        {
          sessionId: "blank-snippet-session",
          _meta: {
            lastMessageSnippet: "   ",
          },
        },
        {
          sessionId: "non-string-snippet-session",
          _meta: {
            lastMessageSnippet: 42,
          },
        },
        {
          sessionId: "markdown-only-session",
          _meta: {
            lastMessageSnippet: "***",
          },
        },
      ],
      nextCursor: null,
    });

    const { listSessionsPage } = await import("../acpApi");

    const page = await listSessionsPage();

    expect(
      page.sessions.map((session) => ({
        sessionId: session.sessionId,
        subtitle: session.subtitle,
      })),
    ).toEqual([
      // Inline strong is stripped on ingest.
      {
        sessionId: "bold-session",
        subtitle: "bold update",
      },
      // Plain text is idempotent: stripping leaves it byte-identical, so a
      // reload does not flip the live value.
      {
        sessionId: "plain-session",
        subtitle: "hello world",
      },
      // Heading + emphasis + link markers all stripped, whitespace collapsed.
      {
        sessionId: "markdown-session",
        subtitle: "Big Title with docs",
      },
      // Already at/over the 128-code-point cap: re-running messageSnippet on the
      // backend value preserves the existing ellipsis and never adds a second.
      {
        sessionId: "long-session",
        subtitle: `${"x".repeat(128)}\u2026`,
      },
      // Missing/undefined snippet maps to null.
      {
        sessionId: "missing-snippet-session",
        subtitle: null,
      },
      // Older or unsupported backends may omit the custom metadata entirely.
      {
        sessionId: "missing-meta-session",
        subtitle: null,
      },
      // Blank and non-string custom metadata are ignored.
      {
        sessionId: "blank-snippet-session",
        subtitle: null,
      },
      {
        sessionId: "non-string-snippet-session",
        subtitle: null,
      },
      // Markdown-only value strips to empty, so the subtitle is null.
      {
        sessionId: "markdown-only-session",
        subtitle: null,
      },
    ]);
    expect(mocks.listSessions).toHaveBeenCalledWith(
      includeLastMessageSnippetMeta,
    );
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
      lastMessageAt: null,
      archivedAt: null,
      userSetName: true,
      messageCount: 7,
      subtitle: null,
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

describe("provider wire translation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({
      newSession: mocks.newSession,
      setSessionConfigOption: mocks.setSessionConfigOption,
    });
    mocks.newSession.mockResolvedValue({ sessionId: "session-9" });
    mocks.setSessionConfigOption.mockResolvedValue(undefined);
    clearSessionConfigSnapshotHandlers();
  });

  it("sends the default model provider when newSession is given the goose sentinel", async () => {
    const { newSession } = await import("../acpApi");

    await newSession("/tmp/project", "goose");

    expect(mocks.newSession).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      mcpServers: [],
      _meta: { provider: "databricks_v2" },
    });
  });

  it("passes a real provider id through newSession unchanged", async () => {
    const { newSession } = await import("../acpApi");

    await newSession("/tmp/project", "claude-acp", "project-1");

    expect(mocks.newSession).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      mcpServers: [],
      _meta: { provider: "claude-acp", projectId: "project-1" },
    });
  });

  it("persists the default model provider when setProvider is given the goose sentinel", async () => {
    const { setProvider } = await import("../acpApi");

    await setProvider("session-9", "goose");

    expect(mocks.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-9",
      configId: "provider",
      value: "databricks_v2",
    });
  });

  it("passes a real provider id through setProvider unchanged", async () => {
    const { setProvider } = await import("../acpApi");

    await setProvider("session-9", "codex-acp");

    expect(mocks.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-9",
      configId: "provider",
      value: "codex-acp",
    });
  });

  it("sets a generic session config option", async () => {
    const { setSessionConfigOption } = await import("../acpApi");

    await setSessionConfigOption("session-9", "thinking_effort", "high");

    expect(mocks.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-9",
      configId: "thinking_effort",
      value: "high",
    });
  });

  it("applies config snapshots from the set config response", async () => {
    const applyModelConfigSnapshot = vi.fn();
    const applyReasoningEffortConfigSnapshot = vi.fn();
    setSessionConfigSnapshotHandlers({
      applyModelConfigSnapshot,
      applyReasoningEffortConfigSnapshot,
    });
    mocks.setSessionConfigOption.mockResolvedValueOnce(
      createConfigOptionsResponse(),
    );

    const { setModel } = await import("../acpApi");

    await setModel("session-9", "claude-opus-4-8");

    expect(applyModelConfigSnapshot).toHaveBeenCalledWith("session-9", {
      modelId: "claude-opus-4-8",
      modelName: "Claude Opus 4.8",
    });
    expect(applyReasoningEffortConfigSnapshot).toHaveBeenCalledWith(
      "session-9",
      {
        configId: "thinking_effort",
        currentValue: "high",
        options: [
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
        ],
      },
    );
  });

  it("warns instead of silently dropping snapshots when no handlers are registered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.setSessionConfigOption.mockResolvedValueOnce(
      createConfigOptionsResponse(),
    );

    const { setModel } = await import("../acpApi");

    await setModel("session-9", "claude-opus-4-8");

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Dropped ACP model config snapshot"),
      { sessionId: "session-9".slice(0, 8) },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Dropped ACP reasoningEffort config snapshot"),
      { sessionId: "session-9".slice(0, 8) },
    );

    warn.mockRestore();
  });
});
