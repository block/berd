import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSessionConfigSnapshotHandlers } from "../acpSessionConfigSnapshots";

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  interceptSessionNotifications: vi.fn(),
  listSessions: vi.fn(),
  unstableForkSession: vi.fn(),
  newSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
  extMethod: vi.fn(),
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
  interceptSessionNotifications: (...args: unknown[]) =>
    mocks.interceptSessionNotifications(...args),
}));

describe("promptForText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collects streamed text from only the private session", async () => {
    let intercept:
      | ((notification: {
          sessionId: string;
          update: {
            sessionUpdate: "agent_message_chunk";
            content: { type: "text"; text: string };
          };
        }) => boolean)
      | undefined;
    const stopIntercepting = vi.fn();
    mocks.interceptSessionNotifications.mockImplementation((callback) => {
      intercept = callback;
      return stopIntercepting;
    });

    const prompt = vi.fn(async () => {
      expect(
        intercept?.({
          sessionId: "visible-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ignore me" },
          },
        }),
      ).toBe(false);
      expect(
        intercept?.({
          sessionId: "private-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Encoded payload " },
          },
        }),
      ).toBe(true);
      intercept?.({
        sessionId: "private-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "could conceal instructions." },
        },
      });
      return { stopReason: "end_turn" };
    });
    const cancel = vi.fn();
    mocks.getClient.mockResolvedValue({ prompt, cancel });

    const { promptForText } = await import("../acpApi");
    await expect(
      promptForText(
        "private-session",
        [{ type: "text", text: "Explain this command" }],
        1000,
      ),
    ).resolves.toBe("Encoded payload could conceal instructions.");

    expect(stopIntercepting).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels a private prompt that exceeds its timeout", async () => {
    vi.useFakeTimers();
    const stopIntercepting = vi.fn();
    mocks.interceptSessionNotifications.mockReturnValue(stopIntercepting);
    const cancel = vi.fn().mockResolvedValue(undefined);
    mocks.getClient.mockResolvedValue({
      prompt: vi.fn(() => new Promise(() => {})),
      cancel,
    });

    const { promptForText } = await import("../acpApi");
    const result = promptForText(
      "private-session",
      [{ type: "text", text: "Explain this command" }],
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledWith({ sessionId: "private-session" });
    expect(stopIntercepting).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it("acknowledges transport only around the real client prompt invocation", async () => {
    const order: string[] = [];
    const clientPrompt = vi.fn(() => {
      order.push("client.prompt");
      return Promise.resolve({ stopReason: "end_turn" });
    });
    mocks.getClient.mockImplementation(async () => {
      order.push("getClient");
      return { prompt: clientPrompt };
    });
    const { prompt } = await import("../acpApi");

    await prompt("session-1", [{ type: "text", text: "hello" }], undefined, {
      onPromptDispatching: () => order.push("dispatching"),
      onPromptDispatched: () => order.push("dispatched"),
    });

    expect(order).toEqual([
      "getClient",
      "dispatching",
      "client.prompt",
      "dispatched",
    ]);
  });

  it("does not acknowledge transport when client acquisition fails", async () => {
    const onPromptDispatching = vi.fn();
    const onPromptDispatched = vi.fn();
    mocks.getClient.mockRejectedValueOnce(new Error("client unavailable"));
    const { prompt } = await import("../acpApi");

    await expect(
      prompt("session-1", [{ type: "text", text: "hello" }], undefined, {
        onPromptDispatching,
        onPromptDispatched,
      }),
    ).rejects.toThrow("client unavailable");
    expect(onPromptDispatching).not.toHaveBeenCalled();
    expect(onPromptDispatched).not.toHaveBeenCalled();
  });
});

describe("listSessionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({
      listSessions: mocks.listSessions,
      unstable_forkSession: mocks.unstableForkSession,
    });
  });

  it("sends the keyword filter as top-level _meta.query", async () => {
    mocks.listSessions.mockResolvedValueOnce({
      sessions: [],
      nextCursor: null,
    });

    const { listSessionsPage } = await import("../acpApi");

    await expect(
      listSessionsPage({ query: "  refactor plan  " }),
    ).resolves.toEqual({ sessions: [], nextCursor: null });
    expect(mocks.listSessions).toHaveBeenCalledWith({
      _meta: {
        goose: { includeLastMessageSnippet: true },
        query: "refactor plan",
      },
    });
  });

  it("omits the keyword filter for blank or absent queries", async () => {
    mocks.listSessions.mockResolvedValue({ sessions: [], nextCursor: null });

    const { listSessionsPage } = await import("../acpApi");

    await listSessionsPage({ query: "   " });
    await listSessionsPage();
    for (const call of mocks.listSessions.mock.calls) {
      expect(call[0]).toEqual(includeLastMessageSnippetMeta);
    }
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

  it("preserves explicit active-run metadata and omits unknown state", async () => {
    mocks.listSessions.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: "active-session",
          title: null,
          updatedAt: null,
          cwd: "/tmp/active",
          _meta: { goose: { activeRunId: "run-1" } },
        },
        {
          sessionId: "settled-session",
          title: null,
          updatedAt: null,
          cwd: "/tmp/settled",
          _meta: { goose: { activeRunId: null } },
        },
        {
          sessionId: "unknown-session",
          title: null,
          updatedAt: null,
          cwd: "/tmp/unknown",
          _meta: {},
        },
        {
          sessionId: "unsupported-top-level-session",
          title: null,
          updatedAt: null,
          cwd: "/tmp/unsupported",
          _meta: { activeRunId: null },
        },
      ],
      nextCursor: null,
    });

    const { listSessionsPage } = await import("../acpApi");
    const page = await listSessionsPage();

    expect(page.sessions[0]).toHaveProperty("activeRunId", "run-1");
    expect(page.sessions[1]).toHaveProperty("activeRunId", null);
    expect(page.sessions[2]).not.toHaveProperty("activeRunId");
    expect(page.sessions[3]).not.toHaveProperty("activeRunId");
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

  it("passes the selected working dir and empty MCP server list without fork metadata", async () => {
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

  it("includes conversationBefore metadata for truncated forks", async () => {
    mocks.unstableForkSession.mockResolvedValueOnce({
      sessionId: "session-2",
      _meta: {},
    });

    const { forkSession } = await import("../acpApi");

    await forkSession("session-1", "/tmp/project", {
      conversationBefore: 1_700_000_123,
    });

    expect(mocks.unstableForkSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/tmp/project",
      mcpServers: [],
      _meta: { conversationBefore: 1_700_000_123 },
    });
  });

  it("omits malformed conversationBefore metadata", async () => {
    mocks.unstableForkSession.mockResolvedValue({
      sessionId: "session-2",
      _meta: {},
    });

    const { forkSession } = await import("../acpApi");

    await forkSession("session-1", "/tmp/project", {
      conversationBefore: Number.POSITIVE_INFINITY,
    });
    await forkSession("session-1", "/tmp/project", {
      conversationBefore: 1_700_000_123.5,
    });

    expect(mocks.unstableForkSession).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      cwd: "/tmp/project",
      mcpServers: [],
    });
    expect(mocks.unstableForkSession).toHaveBeenNthCalledWith(2, {
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
    setSessionConfigSnapshotHandlers({});
  });

  it("sends the default model provider when newSession is given the goose sentinel", async () => {
    const { newSession } = await import("../acpApi");

    await newSession("/tmp/project", { providerId: "goose" });

    expect(mocks.newSession).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      mcpServers: [],
      _meta: { provider: "goose" },
    });
  });

  it("passes a real provider id through newSession unchanged", async () => {
    const { newSession } = await import("../acpApi");

    await newSession("/tmp/project", {
      providerId: "claude-acp",
      projectId: "project-1",
    });

    expect(mocks.newSession).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      mcpServers: [],
      _meta: { provider: "claude-acp", projectId: "project-1" },
    });
  });

  it("marks the session hidden with a boolean _meta.hidden when requested", async () => {
    const { newSession } = await import("../acpApi");

    await newSession("/tmp", { hidden: true });

    expect(mocks.newSession).toHaveBeenCalledWith({
      cwd: "/tmp",
      mcpServers: [],
      _meta: { hidden: true },
    });
  });

  it("persists the default model provider when setProvider is given the goose sentinel", async () => {
    const { setProvider } = await import("../acpApi");

    await setProvider("session-9", "goose");

    expect(mocks.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-9",
      configId: "provider",
      value: "goose",
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

    await expect(setModel("session-9", "claude-opus-4-8")).resolves.toEqual({
      model: {
        modelId: "claude-opus-4-8",
        modelName: "Claude Opus 4.8",
      },
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "high",
        options: [
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
        ],
      },
    });

    expect(applyModelConfigSnapshot).toHaveBeenCalledWith(
      "session-9",
      {
        modelId: "claude-opus-4-8",
        modelName: "Claude Opus 4.8",
      },
      {
        origin: "response",
        modelId: "claude-opus-4-8",
      },
    );
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
      {
        origin: "response",
        modelId: "claude-opus-4-8",
      },
    );
  });

  it("passes provider context with snapshots from the setProvider response", async () => {
    const applyModelConfigSnapshot = vi.fn();
    const applyReasoningEffortConfigSnapshot = vi.fn();
    setSessionConfigSnapshotHandlers({
      applyModelConfigSnapshot,
      applyReasoningEffortConfigSnapshot,
    });
    mocks.setSessionConfigOption.mockResolvedValueOnce(
      createConfigOptionsResponse(),
    );

    const { setProvider } = await import("../acpApi");

    await setProvider("session-9", "codex-acp");

    expect(applyModelConfigSnapshot).toHaveBeenCalledWith(
      "session-9",
      {
        modelId: "claude-opus-4-8",
        modelName: "Claude Opus 4.8",
      },
      {
        origin: "response",
        providerId: "codex-acp",
        modelId: "claude-opus-4-8",
      },
    );
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
      {
        origin: "response",
        providerId: "codex-acp",
        modelId: "claude-opus-4-8",
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

describe("steerSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({ extMethod: mocks.extMethod });
  });

  it("returns the backend message id used to correlate steer delivery", async () => {
    mocks.extMethod.mockResolvedValue({
      runId: "run-2",
      messageId: "steer-message",
    });

    const { steerSession } = await import("../acpApi");

    await expect(
      steerSession(
        "session-1",
        [{ type: "text", text: "make it shorter" }],
        "run-1",
      ),
    ).resolves.toEqual({ runId: "run-2", messageId: "steer-message" });
    expect(mocks.extMethod).toHaveBeenCalledWith(
      "_goose/unstable/session/steer",
      {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "make it shorter" }],
        expectedRunId: "run-1",
      },
    );
  });

  it("keeps the delivery message id when retrying with the actual run", async () => {
    mocks.extMethod
      .mockRejectedValueOnce({ data: { actualRunId: "run-2" } })
      .mockResolvedValueOnce({
        runId: "run-2",
        messageId: "steer-message",
      });

    const { steerSession } = await import("../acpApi");

    await expect(
      steerSession(
        "session-1",
        [{ type: "text", text: "make it shorter" }],
        "run-1",
      ),
    ).resolves.toEqual({ runId: "run-2", messageId: "steer-message" });
    expect(mocks.extMethod).toHaveBeenNthCalledWith(
      2,
      "_goose/unstable/session/steer",
      {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "make it shorter" }],
        expectedRunId: "run-2",
      },
    );
  });
});
