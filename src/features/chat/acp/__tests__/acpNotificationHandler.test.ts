import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearReplayBuffer,
  getReplayBuffer,
} from "@/features/chat/hooks/replayBuffer";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import {
  messageSnippet,
  SNIPPET_SCAN_LIMIT,
} from "@/features/chat/lib/messageSnippet";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { McpAppPayload } from "@/shared/types/messages";
import {
  clearMessageTracking,
  handleSessionNotification,
} from "../acpNotificationHandler";
import { flushBufferedStreamingUpdatesForSession } from "../liveStreamingUpdates";
import { setActiveMessageId } from "@/shared/api/acpActiveMessageTracking";
import { registerPreparedSession } from "@/shared/api/acpSessionRegistry";
import { claimSessionPrompt } from "@/features/chat/lib/sessionPromptOwnership";

function createMcpAppPayload(): McpAppPayload {
  return {
    sessionId: "acp-session",
    toolCallId: "tool-1",
    toolCallTitle: "mcp_app_bench__inspect_host_info",
    source: "toolCallUpdateMeta",
    tool: {
      name: "mcp_app_bench__inspect_host_info",
      extensionName: "mcp_app_bench",
      resourceUri: "ui://inspect-host-info",
    },
    resource: {
      result: null,
    },
  };
}

function createModelConfigUpdate(
  currentValue: string,
  values: Array<{ value: string; name: string }>,
) {
  return {
    sessionUpdate: "config_option_update",
    options: [
      {
        id: "model",
        category: "model",
        kind: {
          type: "select",
          currentValue,
          options: {
            type: "ungrouped",
            values,
          },
        },
      },
    ],
  };
}

function createReasoningEffortConfigUpdate(currentValue: string) {
  return {
    sessionUpdate: "config_option_update",
    options: [
      {
        id: "thinking_effort",
        name: "Thinking effort",
        category: "thought_level",
        kind: {
          type: "select",
          currentValue,
          options: {
            type: "ungrouped",
            values: [
              { value: "off", name: "off" },
              { value: "low", name: "low" },
              { value: "medium", name: "medium" },
              { value: "high", name: "high" },
            ],
          },
        },
      },
    ],
  };
}

function markSessionReplayLoading(sessionId = "acp-session") {
  useChatStore.setState({
    loadingSessionIds: new Set([sessionId]),
  });
}

function getReplayMessage(sessionId = "acp-session") {
  return getReplayBuffer(sessionId)?.[0];
}

describe("acpNotificationHandler", () => {
  beforeEach(() => {
    clearMessageTracking();
    clearReplayBuffer("acp-session");
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
      loadingSessionIds: new Set<string>(),
      scrollTargetMessageBySession: {},
    });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
      modelSelectionIntentBySession: {},
    });
    useAgentStore.setState({ personas: [] });
  });

  it("keeps tool calls that arrive before the first text chunk on the pending assistant message", async () => {
    registerPreparedSession("acp-session", "goose", "/Users/aharvard");
    setActiveMessageId("acp-session", "assistant-1");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "mcp_app_bench__inspect_host_info",
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Opened the Host Info inspector.",
            },
          },
        ],
        _meta: {
          goose: {
            mcpApp: {
              toolName: "mcp_app_bench__inspect_host_info",
              extensionName: "mcp_app_bench",
              resourceUri: "ui://inspect-host-info",
            },
          },
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "The Host Info inspector is now open.",
        },
      },
    } as never);

    await waitFor(() => {
      const message =
        useChatStore.getState().messagesBySession["acp-session"]?.[0];
      expect(message?.content.some((block) => block.type === "mcpApp")).toBe(
        true,
      );
    });
    flushBufferedStreamingUpdatesForSession("acp-session", {
      flushSubtitle: true,
    });

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message.id).toBe("assistant-1");
    expect(message.content.map((block) => block.type)).toEqual([
      "toolRequest",
      "toolResponse",
      "mcpApp",
      "text",
    ]);
    expect(message.content[0]).toMatchObject({
      type: "toolRequest",
      id: "tool-1",
      name: "mcp_app_bench__inspect_host_info",
      toolName: "mcp_app_bench__inspect_host_info",
      extensionName: "mcp_app_bench",
      status: "completed",
    });
    expect(message.content[1]).toMatchObject({
      type: "toolResponse",
      id: "tool-1",
      name: "mcp_app_bench__inspect_host_info",
      result: "Opened the Host Info inspector.",
      isError: false,
    });
    expect(message.content[2]).toMatchObject({
      type: "mcpApp",
      id: "tool-1",
      payload: createMcpAppPayload(),
    });
    expect(message.content[3]).toMatchObject({
      type: "text",
      text: "The Host Info inspector is now open.",
    });
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId,
    ).toBe("assistant-1");
  });

  it("renders an image returned by a live tool result as an inline image block", async () => {
    // An image-producing MCP (e.g. imagegenerator) returns the image as an
    // image ContentBlock in the tool result. The completed tool_call_update must
    // surface it as an inline image block after the toolResponse, not drop it.
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-img-tool");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "img-1",
        title: "imagegenerator__generate",
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "img-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "Here is your image." },
          },
          {
            type: "content",
            content: {
              type: "image",
              data: "iVBORw0KGgo=",
              mimeType: "image/png",
            },
          },
        ],
      },
    } as never);

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message.content.map((block) => block.type)).toEqual([
      "toolRequest",
      "toolResponse",
      "image",
    ]);
    expect(message.content[2]).toMatchObject({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
  });

  it("bounds the per-chunk subtitle accumulator and still matches the canonical snippet", async () => {
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-1");
    const seeded: ChatSession = {
      id: "acp-session",
      title: "Test Session",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 0,
    };
    useChatSessionStore.setState({ sessions: [seeded] });

    // Spy with call-through so the subtitle still updates while we capture the
    // text the handler passes in on each chunk.
    const subtitleSpy = vi.spyOn(
      useChatSessionStore.getState(),
      "updateSessionSubtitleFromText",
    );

    try {
      // Feed many small chunks whose accumulated length far exceeds the scan
      // limit, so the handler's accumulator build is exercised past the bound.
      const chunk = "the quick brown fox ";
      const chunkCount = 300;
      expect(chunk.length * chunkCount).toBeGreaterThan(SNIPPET_SCAN_LIMIT);
      for (let i = 0; i < chunkCount; i++) {
        await handleSessionNotification({
          sessionId: "acp-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk },
          },
        } as never);
      }

      flushBufferedStreamingUpdatesForSession("acp-session", {
        flushSubtitle: true,
      });

      // Step 2 lock-in: the handler never materializes more than a bounded
      // leading prefix, so no subtitle call exceeds SNIPPET_SCAN_LIMIT units.
      expect(subtitleSpy).toHaveBeenCalled();
      for (const [, text] of subtitleSpy.mock.calls) {
        expect((text as string).length).toBeLessThanOrEqual(SNIPPET_SCAN_LIMIT);
      }

      // Liveness preserved: the bounded accumulator yields exactly the snippet of
      // the full reply, so the live value won't flip on the next loadSessions().
      const fullText = chunk.repeat(chunkCount);
      expect(
        useChatSessionStore.getState().getSession("acp-session")?.subtitle,
      ).toBe(messageSnippet(fullText));
    } finally {
      subtitleSpy.mockRestore();
    }
  });

  it("strips markdown from the live subtitle and reconciles to messageSnippet", async () => {
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-1");
    const seeded: ChatSession = {
      id: "acp-session",
      title: "Test Session",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 0,
    };
    useChatSessionStore.setState({ sessions: [seeded] });

    // Stream the reply in pieces that split markdown constructs across chunk
    // boundaries (the `**`, the code fence, and the link all straddle a seam),
    // so we exercise the live accumulate-then-strip path rather than stripping a
    // single complete string.
    const chunks = [
      "**Hel",
      "lo** world. Check `co",
      "de` and [a li",
      "nk](https://example.com) here.",
    ];
    for (const text of chunks) {
      await handleSessionNotification({
        sessionId: "acp-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      } as never);
    }

    flushBufferedStreamingUpdatesForSession("acp-session", {
      flushSubtitle: true,
    });

    const fullText = chunks.join("");
    const subtitle = useChatSessionStore
      .getState()
      .getSession("acp-session")?.subtitle;
    // The live subtitle is the stripped, plain-text form...
    expect(subtitle).toBe("Hello world. Check code and a link here.");
    // ...and it equals the canonical snippet of the whole reply, so it will not
    // flip when the next loadSessions() overwrites it with the backend's value.
    expect(subtitle).toBe(messageSnippet(fullText));
  });

  it("attaches active persona identity to the live assistant message", async () => {
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-1", {
      personaId: "persona-1",
      personaName: "Builder",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Ready to build.",
        },
      },
    } as never);

    flushBufferedStreamingUpdatesForSession("acp-session", {
      flushSubtitle: true,
    });

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      metadata: {
        personaId: "persona-1",
        personaName: "Builder",
        completionStatus: "inProgress",
      },
    });
  });

  it("uses goose steer metadata as the live stream boundary", async () => {
    useChatStore.getState().setMessages("acp-session", [
      {
        id: "assistant-before-steer",
        role: "assistant",
        created: 1,
        content: [{ type: "text", text: "Initial answer" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          completionStatus: "inProgress",
          personaId: "persona-a",
          personaName: "Persona A",
        },
      },
      {
        id: "steer-message",
        role: "user",
        created: 2,
        content: [{ type: "text", text: "make it shorter" }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          delivery: "steer",
        },
      },
    ]);
    useChatStore
      .getState()
      .setStreamingMessageId("acp-session", "assistant-before-steer");
    useChatStore.getState().setPendingInterventionBoundary("acp-session", {
      interventionMessageId: "steer-message",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: " make it shorter can appear naturally",
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "steer-message",
        content: {
          type: "text",
          text: "make it shorter",
        },
        _meta: {
          goose: {
            steer: true,
            messageId: "steer-message",
            activeRunId: "run-2",
          },
        },
      },
    } as never);

    const continuationMessageId =
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId ?? "";

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Revised answer",
        },
      },
    } as never);

    flushBufferedStreamingUpdatesForSession("acp-session", {
      flushSubtitle: true,
    });

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toEqual([
      {
        type: "text",
        text: "Initial answer make it shorter can appear naturally",
      },
    ]);
    expect(messages[2]).toMatchObject({
      id: continuationMessageId,
      role: "assistant",
      content: [{ type: "text", text: "Revised answer" }],
      metadata: {
        completionStatus: "inProgress",
        personaId: "persona-a",
        personaName: "Persona A",
      },
    });
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .pendingInterventionBoundary,
    ).toBeNull();
  });

  it("attaches replay assistant persona identity from update metadata", async () => {
    markSessionReplayLoading();

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Ready.",
        },
        _meta: {
          goose: {
            messageId: "assistant-replay-1",
            personaId: "persona-meta",
            personaName: "Meta Persona",
          },
        },
      },
    } as never);

    expect(getReplayMessage()).toMatchObject({
      id: "assistant-replay-1",
      role: "assistant",
      metadata: {
        personaId: "persona-meta",
        personaName: "Meta Persona",
      },
    });
  });

  it("falls back to session persona identity for replay assistant messages", async () => {
    markSessionReplayLoading();
    useChatSessionStore.getState().addSession({
      id: "acp-session",
      title: "Chat",
      personaId: "persona-session",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 1,
    });
    useAgentStore.setState({
      personas: [
        {
          id: "persona-session",
          displayName: "Session Persona",
          systemPrompt: "",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Ready.",
        },
        _meta: {
          goose: {
            messageId: "assistant-replay-2",
          },
        },
      },
    } as never);

    expect(getReplayMessage()).toMatchObject({
      id: "assistant-replay-2",
      role: "assistant",
      metadata: {
        personaId: "persona-session",
        personaName: "Session Persona",
      },
    });
  });

  it("restores replayed user message origin metadata", async () => {
    markSessionReplayLoading();

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text: "Cross-session prompt",
        },
        _meta: {
          goose: {
            messageId: "user-replay-1",
            origin: "berdctl_cross_session",
          },
        },
      },
    } as never);

    expect(getReplayMessage()).toMatchObject({
      id: "user-replay-1",
      role: "user",
      metadata: {
        origin: "berdctl_cross_session",
      },
    });
  });

  it("does not let a stale backend model snapshot overwrite a pending selected model", async () => {
    useChatSessionStore.getState().addSession({
      id: "acp-session",
      title: "Chat",
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 0,
    });
    useChatSessionStore.getState().beginModelSelectionIntent("acp-session", {
      requestId: "request-1",
      kind: "model",
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
      previousProviderId: "openai",
      previousModelId: "gpt-4o",
      previousModelName: "GPT-4o",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: createModelConfigUpdate("gpt-4o", [
        { value: "gpt-4o", name: "GPT-4o" },
        { value: "claude-sonnet-4", name: "Claude Sonnet 4" },
      ]),
    } as never);

    expect(
      useChatSessionStore.getState().getSession("acp-session"),
    ).toMatchObject({
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
  });

  it("updates the display name from a matching backend model snapshot", async () => {
    useChatSessionStore.getState().addSession({
      id: "acp-session",
      title: "Chat",
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "gpt-4o",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 0,
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: createModelConfigUpdate("gpt-4o", [
        { value: "gpt-4o", name: "GPT-4o Latest" },
      ]),
    } as never);

    expect(
      useChatSessionStore.getState().getSession("acp-session"),
    ).toMatchObject({
      modelId: "gpt-4o",
      modelName: "GPT-4o Latest",
    });
  });

  it("hydrates an empty session model from a backend model snapshot", async () => {
    useChatSessionStore.getState().addSession({
      id: "acp-session",
      title: "Chat",
      providerId: "openai",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 0,
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: createModelConfigUpdate("gpt-4o", [
        { value: "gpt-4o", name: "GPT-4o" },
      ]),
    } as never);

    expect(
      useChatSessionStore.getState().getSession("acp-session"),
    ).toMatchObject({
      modelId: "gpt-4o",
      modelName: "GPT-4o",
    });
  });

  it("hydrates reasoning effort from a thought-level config option", async () => {
    useChatSessionStore.getState().addSession({
      id: "acp-session",
      title: "Chat",
      providerId: "goose",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 0,
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: createReasoningEffortConfigUpdate("high"),
    } as never);

    expect(
      useChatSessionStore.getState().getSession("acp-session"),
    ).toMatchObject({
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "high",
        options: [
          { id: "off", name: "off" },
          { id: "low", name: "low" },
          { id: "medium", name: "medium" },
          { id: "high", name: "high" },
        ],
      },
    });
  });

  it("preserves reasoning effort when a partial config update omits it", async () => {
    useChatSessionStore.getState().addSession({
      id: "acp-session",
      title: "Chat",
      providerId: "goose",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 0,
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: createReasoningEffortConfigUpdate("high"),
    } as never);
    await handleSessionNotification({
      sessionId: "acp-session",
      update: createModelConfigUpdate("gpt-4o", [
        { value: "gpt-4o", name: "GPT-4o" },
      ]),
    } as never);

    expect(
      useChatSessionStore.getState().getSession("acp-session"),
    ).toMatchObject({
      modelId: "gpt-4o",
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "high",
      },
    });
  });

  it("drops stale reasoning effort snapshot during a model selection intent", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    useChatSessionStore.getState().addSession({
      id: "acp-session",
      title: "Chat",
      providerId: "goose",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 0,
    });
    useChatSessionStore.getState().beginModelSelectionIntent("acp-session", {
      requestId: "model-request-1",
      kind: "model",
      modelId: "gpt-5.5",
      previousModelId: "claude-opus-4-8",
      previousModelName: "Claude Opus 4.8",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: createReasoningEffortConfigUpdate("high"),
    } as never);

    expect(
      useChatSessionStore.getState().getSession("acp-session")?.reasoningEffort,
    ).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "Dropped stale ACP reasoningEffort config snapshot",
      expect.objectContaining({
        intentKind: "model",
      }),
    );
    warnSpy.mockRestore();
  });

  it("does not hydrate an old model snapshot during a provider-only switch", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    useChatSessionStore.getState().addSession({
      id: "acp-session",
      title: "Chat",
      providerId: "anthropic",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      messageCount: 0,
    });
    useChatSessionStore.getState().beginModelSelectionIntent("acp-session", {
      requestId: "provider-request-1",
      kind: "provider",
      providerId: "anthropic",
      previousProviderId: "openai",
      previousModelId: "gpt-4o",
      previousModelName: "GPT-4o",
    });

    await handleSessionNotification({
      sessionId: "acp-session",
      update: createModelConfigUpdate("gpt-4o", [
        { value: "gpt-4o", name: "GPT-4o" },
      ]),
    } as never);

    expect(
      useChatSessionStore.getState().getSession("acp-session"),
    ).not.toMatchObject({
      modelId: "gpt-4o",
      modelName: "GPT-4o",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "Dropped divergent ACP model config snapshot",
      expect.objectContaining({
        localModelId: undefined,
        snapshotModelId: "gpt-4o",
        intentKind: "provider",
      }),
    );
    warnSpy.mockRestore();
  });

  it("preserves ACP tool kind and locations on tool requests", async () => {
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-1");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "write_file",
        kind: "edit",
        locations: [{ path: "/tmp/report.md", line: 7 }],
        rawInput: { path: "/tmp/report.md" },
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        locations: [{ path: "/tmp/report.md", line: 9 }],
      },
    } as never);

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message.content[0]).toMatchObject({
      type: "toolRequest",
      id: "tool-1",
      arguments: { path: "/tmp/report.md" },
      toolKind: "edit",
      locations: [{ path: "/tmp/report.md", line: 9 }],
      status: "completed",
    });
  });

  it("attributes a completed live tool response to the matching request when a sibling is still executing", async () => {
    // Regression: with two sibling tool requests, completing the first
    // while the second is still unpaired must label the response with the
    // first request's name. Previously the live path used the latest
    // unpaired request, which could swap names across siblings.
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-1");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-a",
        title: "read_file",
        rawInput: { path: "/tmp/notes.md" },
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-b",
        title: "grep",
        rawInput: { pattern: "TODO" },
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-a",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "file contents" },
          },
        ],
      },
    } as never);

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message.content.map((block) => block.type)).toEqual([
      "toolRequest",
      "toolRequest",
      "toolResponse",
    ]);
    expect(message.content[0]).toMatchObject({
      type: "toolRequest",
      id: "tool-a",
      name: "read_file",
      status: "completed",
    });
    expect(message.content[1]).toMatchObject({
      type: "toolRequest",
      id: "tool-b",
      name: "grep",
      status: "in_progress",
    });
    expect(message.content[2]).toMatchObject({
      type: "toolResponse",
      id: "tool-a",
      name: "read_file",
      result: "file contents",
      isError: false,
    });
  });

  it("keeps a late live tool response from moving the streaming pointer back to its owner message", async () => {
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-1");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-a",
        title: "read_file",
        rawInput: { path: "/tmp/notes.md" },
      },
    } as never);

    const beforeMessages =
      useChatStore.getState().messagesBySession["acp-session"] ?? [];
    useChatStore.setState((state) => ({
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        "acp-session": [
          ...beforeMessages,
          {
            id: "assistant-2",
            role: "assistant",
            created: Date.now(),
            content: [],
            metadata: {
              userVisible: true,
              agentVisible: true,
              completionStatus: "inProgress",
            },
          },
        ],
      },
    }));
    useChatStore.getState().setStreamingMessageId("acp-session", "assistant-2");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-a",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "file contents" },
          },
        ],
      },
    } as never);

    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId,
    ).toBe("assistant-2");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Continuing with the answer.",
        },
      },
    } as never);

    flushBufferedStreamingUpdatesForSession("acp-session", {
      flushSubtitle: true,
    });

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    const ownerMessage = messages.find((m) => m.id === "assistant-1");
    const currentMessage = messages.find((m) => m.id === "assistant-2");

    expect(ownerMessage?.content.map((block) => block.type)).toEqual([
      "toolRequest",
      "toolResponse",
    ]);
    expect(currentMessage?.content).toEqual([
      { type: "text", text: "Continuing with the answer." },
    ]);
  });

  it("does not redirect a late chunk with its original message id into the current stream", async () => {
    registerPreparedSession("acp-session", "goose", "/Users/test");
    claimSessionPrompt("acp-session");
    setActiveMessageId("acp-session", "assistant-1");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: "first response" },
      },
    } as never);
    flushBufferedStreamingUpdatesForSession("acp-session");

    const firstMessages =
      useChatStore.getState().messagesBySession["acp-session"] ?? [];
    useChatStore.setState((state) => ({
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        "acp-session": [
          ...firstMessages,
          {
            id: "assistant-2",
            role: "assistant",
            created: Date.now(),
            content: [],
            metadata: {
              userVisible: true,
              agentVisible: true,
              completionStatus: "inProgress",
            },
          },
        ],
      },
    }));
    useChatStore.getState().setStreamingMessageId("acp-session", "assistant-2");
    claimSessionPrompt("acp-session");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: " late stale text" },
      },
    } as never);
    flushBufferedStreamingUpdatesForSession("acp-session");

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    expect(
      messages.find((message) => message.id === "assistant-1")?.content,
    ).toEqual([{ type: "text", text: "first response" }]);
    expect(
      messages.find((message) => message.id === "assistant-2")?.content,
    ).toEqual([]);
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId,
    ).toBe("assistant-2");
  });

  it("does not apply a late image chunk from a superseded assistant stream", async () => {
    registerPreparedSession("acp-session", "goose", "/Users/test");
    claimSessionPrompt("acp-session");
    setActiveMessageId("acp-session", "assistant-1");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: "first response" },
      },
    } as never);
    flushBufferedStreamingUpdatesForSession("acp-session");

    const firstMessages =
      useChatStore.getState().messagesBySession["acp-session"] ?? [];
    useChatStore.setState((state) => ({
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        "acp-session": [
          ...firstMessages,
          {
            id: "assistant-2",
            role: "assistant",
            created: Date.now(),
            content: [],
            metadata: {
              userVisible: true,
              agentVisible: true,
              completionStatus: "inProgress",
            },
          },
        ],
      },
    }));
    useChatStore.getState().setStreamingMessageId("acp-session", "assistant-2");
    claimSessionPrompt("acp-session");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
        },
      },
    } as never);

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    expect(
      messages.find((message) => message.id === "assistant-1")?.content,
    ).toEqual([{ type: "text", text: "first response" }]);
    expect(
      messages.find((message) => message.id === "assistant-2")?.content,
    ).toEqual([]);
    expect(
      useChatStore.getState().getSessionRuntime("acp-session")
        .streamingMessageId,
    ).toBe("assistant-2");
  });

  it("preserves structured tool output when ACP provides rawOutput", async () => {
    registerPreparedSession(
      "acp-session",
      "goose",
      "/Users/aharvard/.goose/artifacts",
    );
    setActiveMessageId("acp-session", "assistant-1");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "mcp_app_bench__inspect_host_info",
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Opened the Host Info inspector.",
            },
          },
        ],
        rawOutput: {
          inspector: "host-info",
          supported: true,
        },
      },
    } as never);

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message.content[1]).toMatchObject({
      type: "toolResponse",
      id: "tool-1",
      result: "Opened the Host Info inspector.",
      structuredContent: {
        inspector: "host-info",
        supported: true,
      },
      isError: false,
    });
  });

  it("replay replaces cumulative thought snapshots instead of appending them", async () => {
    const replaySessionId = "replay-thought-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "assistant-thought-1",
        content: { type: "text", text: "Plan" },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "assistant-thought-1",
        content: { type: "text", text: "Plan next step" },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer?.[0]?.content).toEqual([
      { type: "thinking", text: "Plan next step" },
    ]);
  });

  it("replay keeps tool and MCP app content on an assistant message when tool events arrive before text", async () => {
    const replaySessionId = "replay-acp-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: {
          type: "text",
          text: "run the app bench",
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "mcp_app_bench__inspect_host_info",
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Opened the Host Info inspector.",
            },
          },
        ],
        _meta: {
          goose: {
            mcpApp: {
              toolName: "mcp_app_bench__inspect_host_info",
              extensionName: "mcp_app_bench",
              resourceUri: "ui://inspect-host-info",
            },
          },
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: {
          type: "text",
          text: "The Host Info inspector is now open.",
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer).toHaveLength(2);
    expect(buffer?.[0]).toMatchObject({
      id: "user-1",
      role: "user",
      content: [{ type: "text", text: "run the app bench" }],
    });
    expect(
      buffer?.[0]?.content.some((block) => block.type === "toolRequest"),
    ).toBe(false);

    expect(buffer?.[1]?.id).toBe("assistant-1");
    expect(buffer?.[1]?.role).toBe("assistant");
    expect(buffer?.[1]?.content.map((block) => block.type)).toEqual([
      "toolRequest",
      "toolResponse",
      "mcpApp",
      "text",
    ]);
    expect(buffer?.[1]?.content[0]).toMatchObject({
      type: "toolRequest",
      toolName: "mcp_app_bench__inspect_host_info",
      extensionName: "mcp_app_bench",
    });
    expect(buffer?.[1]?.content[2]).toMatchObject({
      type: "mcpApp",
      id: "tool-1",
      payload: {
        ...createMcpAppPayload(),
        sessionId: replaySessionId,
      },
    });
  });

  it("replay restores skill chips from assistant-only user chunks", async () => {
    const replaySessionId = "replay-skill-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: {
          type: "text",
          text: "Use these skills for this request: capture-task.",
          annotations: { audience: ["assistant"] },
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: {
          type: "text",
          text: "redo the settings modal",
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer).toHaveLength(1);
    expect(buffer?.[0]).toMatchObject({
      id: "user-1",
      role: "user",
      content: [{ type: "text", text: "redo the settings modal" }],
      metadata: {
        chips: [{ label: "capture-task", type: "skill" }],
      },
    });
  });

  it("replay preserves ordered user text and image chunks", async () => {
    const replaySessionId = "replay-user-image-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: {
          type: "text",
          text: "what is in this image?",
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer).toHaveLength(1);
    expect(buffer?.[0]).toMatchObject({
      id: "user-1",
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      metadata: {
        userVisible: true,
        agentVisible: true,
      },
    });
  });

  it("replay keeps image-only user messages visible", async () => {
    const replaySessionId = "replay-user-image-only-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-image-only",
        content: {
          type: "image",
          uri: "file:///tmp/screenshot.png",
          mimeType: "image/png",
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer).toHaveLength(1);
    expect(buffer?.[0]).toMatchObject({
      id: "user-image-only",
      role: "user",
      content: [
        {
          type: "image",
          uri: "file:///tmp/screenshot.png",
          mimeType: "image/png",
        },
      ],
      metadata: {
        userVisible: true,
        agentVisible: true,
      },
    });
  });

  it("replay appends assistant image chunks in message order", async () => {
    const replaySessionId = "replay-assistant-image-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: {
          type: "text",
          text: "here is the generated image:",
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          uri: "file:///tmp/generated.png",
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer).toHaveLength(1);
    expect(buffer?.[0]).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      content: [
        { type: "text", text: "here is the generated image:" },
        {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          uri: "file:///tmp/generated.png",
        },
      ],
    });
  });

  it("appends live assistant image chunks inline during the turn", async () => {
    // Live counterpart to "replay appends assistant image chunks in message
    // order". A session not in loadingSessionIds takes the handleLive path. An
    // image chunk that follows a text chunk must be appended to the streaming
    // assistant message so it renders during the turn (regression guard for the
    // previously-missing live image branch).
    registerPreparedSession("acp-session", "goose", "/Users/test");
    setActiveMessageId("acp-session", "assistant-img-live", {});

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "here is the generated image:",
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          uri: "file:///tmp/generated.png",
        },
      },
    } as never);

    const [message] = useChatStore.getState().messagesBySession["acp-session"];
    expect(message).toMatchObject({
      id: "assistant-img-live",
      role: "assistant",
      content: [
        { type: "text", text: "here is the generated image:" },
        {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          uri: "file:///tmp/generated.png",
        },
      ],
    });
  });

  it("replay preserves timestamps from goose metadata on user and assistant chunks", async () => {
    const replaySessionId = "replay-timestamp-session";
    const userCreated = 1_700_000_000;
    const assistantCreated = 1_700_000_120;
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text: "what time was this sent?",
        },
        _meta: {
          goose: {
            messageId: "user-from-meta",
            created: userCreated,
          },
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "At the original replay time.",
        },
        _meta: {
          goose: {
            messageId: "assistant-from-meta",
            created: assistantCreated,
          },
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer?.[0]).toMatchObject({
      id: "user-from-meta",
      role: "user",
      created: userCreated * 1000,
    });
    expect(buffer?.[1]).toMatchObject({
      id: "assistant-from-meta",
      role: "assistant",
      created: assistantCreated * 1000,
    });
  });

  it("replay attaches MCP app payloads to tool-only assistant messages", async () => {
    const replaySessionId = "replay-acp-session-2";
    const replayCreated = 1_700_000_240;
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "mcp_app_bench__inspect_host_info",
        _meta: {
          goose: {
            messageId: "assistant-tool-only",
            created: replayCreated,
          },
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        _meta: {
          goose: {
            mcpApp: {
              toolName: "mcp_app_bench__inspect_host_info",
              extensionName: "mcp_app_bench",
              resourceUri: "ui://inspect-host-info",
            },
            messageId: "assistant-tool-only",
            created: replayCreated,
          },
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    const assistant = buffer?.[0];
    expect(assistant).toMatchObject({
      id: "assistant-tool-only",
      created: replayCreated * 1000,
    });
    const mcpAppBlock = assistant?.content.find(
      (block) => block.type === "mcpApp",
    );
    expect(mcpAppBlock).toMatchObject({
      type: "mcpApp",
      payload: expect.objectContaining({
        sessionId: replaySessionId,
      }),
    });
  });

  it("replay falls back to tracked assistant when a tool update ID is not buffered", async () => {
    const replaySessionId = "replay-tool-response-id-session";
    const assistantCreated = 1_700_000_120;
    const toolResponseCreated = 1_700_000_240;
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "I'll check that.",
        },
        _meta: {
          goose: {
            messageId: "assistant-1",
            created: assistantCreated,
          },
        },
      },
    } as never);

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Tool completed.",
            },
          },
        ],
        _meta: {
          goose: {
            messageId: "tool-response-user-message",
            created: toolResponseCreated,
          },
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    const assistant = buffer?.[0];
    expect(assistant).toMatchObject({
      id: "assistant-1",
      created: assistantCreated * 1000,
    });
    expect(assistant?.content.map((block) => block.type)).toEqual([
      "text",
      "toolResponse",
    ]);
    expect(assistant?.content[1]).toMatchObject({
      type: "toolResponse",
      id: "tool-1",
      result: "Tool completed.",
      isError: false,
    });
  });

  it("threads tool chain summary onto the streaming tool request (live)", async () => {
    registerPreparedSession("acp-session", "goose", "/tmp");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "running ls",
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-2",
        title: "running pwd",
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        _meta: {
          goose: {
            toolChainSummary: {
              summary: "inspected working directory",
              count: 2,
            },
          },
        },
      },
    } as never);

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    expect(messages).toBeTruthy();
    const toolReqs =
      messages?.flatMap((m) =>
        m.content.filter((c) => c.type === "toolRequest"),
      ) ?? [];
    const first = toolReqs.find(
      (c) => c.type === "toolRequest" && c.id === "tc-1",
    );
    const second = toolReqs.find(
      (c) => c.type === "toolRequest" && c.id === "tc-2",
    );
    expect(first?.type === "toolRequest" && first.chainSummary).toEqual({
      summary: "inspected working directory",
      count: 2,
    });
    expect(
      second?.type === "toolRequest" && second.chainSummary,
    ).toBeUndefined();
  });

  it("threads tool chain summary onto the first tool call even when the agent has moved to the next assistant message (live)", async () => {
    registerPreparedSession("acp-session", "goose", "/tmp");

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "running ls",
      },
    } as never);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-2",
        title: "running pwd",
      },
    } as never);

    // Simulate the agent moving on to the next assistant message: the
    // streamingMessageId now points to a brand-new message that does not
    // contain the original tool requests. This is what happens in practice
    // by the time the chain summary task fires (after all tool responses
    // have been emitted and the next agent turn has begun).
    const beforeMessages =
      useChatStore.getState().messagesBySession["acp-session"] ?? [];
    const newAssistantId = "next-assistant-msg";
    useChatStore.setState((state) => ({
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        "acp-session": [
          ...beforeMessages,
          {
            id: newAssistantId,
            role: "assistant",
            created: Date.now(),
            content: [{ type: "text", text: "ok" }],
            metadata: {
              userVisible: true,
              agentVisible: true,
              completionStatus: "inProgress",
            },
          },
        ],
      },
    }));
    useChatStore
      .getState()
      .setStreamingMessageId("acp-session", newAssistantId);

    await handleSessionNotification({
      sessionId: "acp-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        _meta: {
          goose: {
            toolChainSummary: {
              summary: "inspected working directory",
              count: 2,
            },
          },
        },
      },
    } as never);

    const messages = useChatStore.getState().messagesBySession["acp-session"];
    const toolReqs =
      messages?.flatMap((m) =>
        m.content.filter((c) => c.type === "toolRequest"),
      ) ?? [];
    const first = toolReqs.find(
      (c) => c.type === "toolRequest" && c.id === "tc-1",
    );
    expect(first?.type === "toolRequest" && first.chainSummary).toEqual({
      summary: "inspected working directory",
      count: 2,
    });
    // The new assistant message must not have been mutated to absorb the
    // chain summary (regression guard: it doesn't own the tool request).
    const nextMsg = messages?.find((m) => m.id === newAssistantId);
    expect(nextMsg?.content.some((c) => c.type === "toolRequest")).toBe(false);
  });

  it("attaches tool chain summary on initial tool_call during replay", async () => {
    const replaySessionId = "replay-chain-summary-session";
    useChatStore.setState({
      loadingSessionIds: new Set<string>([replaySessionId]),
    });

    await handleSessionNotification({
      sessionId: replaySessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "ran two things",
        _meta: {
          goose: {
            toolChainSummary: {
              summary: "applied dark mode polish",
              count: 4,
            },
          },
        },
      },
    } as never);

    const buffer = getReplayBuffer(replaySessionId);
    expect(buffer).toBeTruthy();
    const tc = buffer
      ?.flatMap((m) => m.content)
      .find((c) => c.type === "toolRequest" && c.id === "tc-1");
    expect(tc?.type === "toolRequest" && tc.chainSummary).toEqual({
      summary: "applied dark mode polish",
      count: 4,
    });
  });

  describe("usage_update cost handling", () => {
    const sessionId = "acp-session";

    const sendUsage = (cost: unknown) =>
      handleSessionNotification({
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 100,
          size: 1000,
          ...(cost === "omit" ? {} : { cost }),
        },
      } as never);

    const readCost = () =>
      useChatStore.getState().sessionStateById[sessionId]?.tokenState
        ?.accumulatedCost;

    it("updates the accumulated cost when a finite amount is present", async () => {
      await sendUsage({ amount: 0.42 });
      expect(readCost()).toBe(0.42);
    });

    it("preserves the previous cost when cost is omitted on a later update", async () => {
      await sendUsage({ amount: 0.42 });
      await sendUsage("omit");
      expect(readCost()).toBe(0.42);
    });

    it("clears the cost when an explicit null cost arrives", async () => {
      await sendUsage({ amount: 0.42 });
      await sendUsage(null);
      expect(readCost()).toBeNull();
    });

    it("clears the cost when the amount is null (no pricing)", async () => {
      await sendUsage({ amount: 0.42 });
      await sendUsage({ amount: null });
      expect(readCost()).toBeNull();
    });
  });
});
