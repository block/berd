import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { SessionChatRuntime } from "@/shared/types/chat";
import { QueuedMessageOwnershipLostError } from "./preCommitSendRejection";
import { dispatchPrompt } from "./sendCore";
import { registerRealtimeEmissary } from "@/features/voice-conversation/lib/realtimeEmissaryBridge";

const mocks = vi.hoisted(() => ({
  acpSendMessage: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpSendMessage: (...args: unknown[]) => mocks.acpSendMessage(...args),
}));

describe("dispatchPrompt pre-commit rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
    useChatSessionStore.setState({ sessions: [], activeSessionId: null });
  });

  it("preserves the complete newer-owner runtime on ownership loss", async () => {
    let newerOwnerRuntime: SessionChatRuntime | undefined;
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        const store = useChatStore.getState();
        store.setError("session-1", "newer owner error");
        store.setChatState("session-1", "streaming");
        store.setPendingAssistantProvider("session-1", "newer-provider");
        store.setActiveRunId("session-1", "newer-run");
        store.setRunCancellationPending("session-1", true);
        newerOwnerRuntime = structuredClone(
          store.getSessionRuntime("session-1"),
        );
        options.onPromptDispatching();
        return Promise.resolve();
      },
    );

    await expect(
      dispatchPrompt("session-1", "stale queued turn", {
        beforeUserMessageCommitted: () => {
          throw new QueuedMessageOwnershipLostError();
        },
      }),
    ).rejects.toBeInstanceOf(QueuedMessageOwnershipLostError);

    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
    expect(useChatStore.getState().getSessionRuntime("session-1")).toEqual(
      newerOwnerRuntime,
    );
  });

  it("never sends local attachment paths to a remote session", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Remote chat",
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
          messageCount: 0,
          remoteHost: "devbox",
        },
      ],
      activeSessionId: "session-1",
    });
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "review", {
      attachments: [
        {
          id: "file",
          kind: "file",
          name: "notes.md",
          path: "/Users/me/notes.md",
        },
        {
          id: "image",
          kind: "image",
          name: "diagram.png",
          path: "/Users/me/diagram.png",
          mimeType: "image/png",
          base64: "abc",
          previewUrl: "asset://diagram.png",
        },
      ],
    });

    expect(mocks.acpSendMessage).toHaveBeenCalledWith(
      "session-1",
      "review",
      expect.objectContaining({ images: [["abc", "image/png"]] }),
    );
  });
});

describe("dispatchPrompt voice conversation no-op", () => {
  const emptyResponseError =
    "The model returned an empty response. Please resend your message to continue.";

  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
  });

  function rejectCommittedPrompt(message: string): void {
    mocks.acpSendMessage.mockImplementationOnce(
      (
        sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        const store = useChatStore.getState();
        store.addMessage(sessionId, {
          id: "empty-assistant",
          role: "assistant",
          created: Date.now(),
          content: [],
          metadata: { completionStatus: "inProgress" },
        });
        store.setStreamingMessageId(sessionId, "empty-assistant");
        return Promise.reject(new Error(message));
      },
    );
  }

  it("preserves a provisional voice transcript's original ordering timestamp", async () => {
    useChatStore.getState().addMessage("session-1", {
      id: "voice-user",
      role: "user",
      created: 100,
      content: [{ type: "text", text: "provisional" }],
      metadata: { origin: "voice_conversation" },
    });
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "final transcript", {
      displayText: "final transcript",
      userMessageId: "voice-user",
      userMessageMetadata: { origin: "voice_conversation" },
    });

    expect(
      useChatStore
        .getState()
        .messagesBySession["session-1"]?.find(
          (message) => message.id === "voice-user",
        ),
    ).toMatchObject({ created: 100 });
  });

  it("treats a committed voice empty response as a clean semantic no-op", async () => {
    rejectCommittedPrompt(emptyResponseError);

    await expect(
      dispatchPrompt("session-1", "Emissary said: Hello", {
        userMessageMetadata: { origin: "voice_conversation" },
      }),
    ).resolves.toBeUndefined();

    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "user",
      metadata: { origin: "voice_conversation" },
    });
    expect(messages[1]).toMatchObject({
      id: "empty-assistant",
      role: "assistant",
      metadata: { completionStatus: "completed" },
    });
    expect(messages.some((message) => message.role === "system")).toBe(false);

    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.chatState).toBe("idle");
    expect(runtime.error).toBeNull();
    expect(runtime.streamingMessageId).toBeNull();
    expect(runtime.pendingAssistantProviderId).toBeNull();
  });

  it("does not suppress a different error for a voice turn", async () => {
    rejectCommittedPrompt("Provider authentication failed");

    await expect(
      dispatchPrompt("session-1", "User said: Hello", {
        userMessageMetadata: { origin: "voice_conversation" },
      }),
    ).rejects.toThrow("Provider authentication failed");

    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages.at(-1)).toMatchObject({ role: "system" });
    expect(useChatStore.getState().getSessionRuntime("session-1").error).toBe(
      "Provider authentication failed",
    );
  });

  it("does not suppress the empty-response error for a non-voice turn", async () => {
    rejectCommittedPrompt(emptyResponseError);

    await expect(dispatchPrompt("session-1", "Hello", {})).rejects.toThrow(
      emptyResponseError,
    );

    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages.at(-1)).toMatchObject({ role: "system" });
    expect(useChatStore.getState().getSessionRuntime("session-1").error).toBe(
      emptyResponseError,
    );
  });
});

describe("dispatchPrompt realtime Master turn lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
  });

  it("publishes the normal final Master text at the terminal prompt boundary", async () => {
    const beginMasterTurn = vi.fn();
    const endMasterTurn = vi.fn();
    const release = registerRealtimeEmissary({
      sessionId: "session-1",
      beginMasterTurn,
      endMasterTurn,
      sendMasterMessage: vi.fn(),
    });
    mocks.acpSendMessage.mockImplementationOnce(
      (
        sessionId: string,
        _prompt: string,
        options: {
          onPromptDispatching(): void;
          onPromptDispatched(): void;
        },
      ) => {
        options.onPromptDispatching();
        options.onPromptDispatched();
        useChatStore.getState().addMessage(sessionId, {
          id: "master-final",
          role: "assistant",
          created: Date.now(),
          content: [{ type: "text", text: "There are 20 repositories." }],
          metadata: {
            agentVisible: true,
            userVisible: true,
            completionStatus: "completed",
          },
        });
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "Count repositories", {});

    expect(beginMasterTurn).toHaveBeenCalledOnce();
    const turnId = beginMasterTurn.mock.calls[0]?.[0];
    expect(turnId).toEqual(expect.any(String));
    expect(endMasterTurn).toHaveBeenCalledWith({
      turnId,
      status: "completed",
      finalText: "There are 20 repositories.",
    });
    release();
  });

  it("publishes final text appended to a reused streaming assistant row", async () => {
    const beginMasterTurn = vi.fn();
    const endMasterTurn = vi.fn();
    const release = registerRealtimeEmissary({
      sessionId: "session-1",
      beginMasterTurn,
      endMasterTurn,
      sendMasterMessage: vi.fn(),
    });
    useChatStore.getState().addMessage("session-1", {
      id: "reused-stream",
      role: "assistant",
      created: Date.now(),
      content: [{ type: "text", text: "" }],
      metadata: { agentVisible: true, userVisible: true },
    });
    mocks.acpSendMessage.mockImplementationOnce(
      (
        sessionId: string,
        _prompt: string,
        options: {
          onPromptDispatching(): void;
          onPromptDispatched(): void;
        },
      ) => {
        options.onPromptDispatching();
        options.onPromptDispatched();
        useChatStore
          .getState()
          .updateMessage(sessionId, "reused-stream", (message) => ({
            ...message,
            content: [{ type: "text", text: "There are 20 repositories." }],
          }));
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "Count repositories", {});

    expect(endMasterTurn).toHaveBeenCalledWith({
      turnId: expect.any(String),
      status: "completed",
      finalText: "There are 20 repositories.",
    });
    release();
  });

  it("includes a final Master notification delivered just after prompt resolution", async () => {
    const endMasterTurn = vi.fn();
    const release = registerRealtimeEmissary({
      sessionId: "session-1",
      beginMasterTurn: vi.fn(),
      endMasterTurn,
      sendMasterMessage: vi.fn(),
    });
    mocks.acpSendMessage.mockImplementationOnce(
      (
        sessionId: string,
        _prompt: string,
        options: {
          onPromptDispatching(): void;
          onPromptDispatched(): void;
        },
      ) => {
        options.onPromptDispatching();
        options.onPromptDispatched();
        window.setTimeout(() => {
          useChatStore.getState().addMessage(sessionId, {
            id: "late-master-final",
            role: "assistant",
            created: Date.now(),
            content: [{ type: "text", text: "The late final answer." }],
            metadata: {
              agentVisible: true,
              userVisible: true,
              completionStatus: "completed",
            },
          });
        }, 0);
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "Check the answer", {});

    expect(endMasterTurn).toHaveBeenCalledWith({
      turnId: expect.any(String),
      status: "completed",
      finalText: "The late final answer.",
    });
    release();
  });

  it("does not forward the backend empty-response placeholder as Master output", async () => {
    const beginMasterTurn = vi.fn();
    const endMasterTurn = vi.fn();
    const release = registerRealtimeEmissary({
      sessionId: "session-1",
      beginMasterTurn,
      endMasterTurn,
      sendMasterMessage: vi.fn(),
    });
    mocks.acpSendMessage.mockImplementationOnce(
      (
        sessionId: string,
        _prompt: string,
        options: {
          onPromptDispatching(): void;
          onPromptDispatched(): void;
        },
      ) => {
        options.onPromptDispatching();
        options.onPromptDispatched();
        useChatStore.getState().addMessage(sessionId, {
          id: "master-empty-fallback",
          role: "assistant",
          created: Date.now(),
          content: [
            {
              type: "text",
              text: "The model returned an empty response. Please resend your message to continue.",
            },
          ],
          metadata: { agentVisible: true, userVisible: true },
        });
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "[Voice transcript] User said: hello", {
      userMessageMetadata: { origin: "voice_conversation" },
    });

    expect(endMasterTurn).toHaveBeenCalledWith({
      turnId: expect.any(String),
      status: "completed",
      finalText: undefined,
    });
    release();
  });
});
