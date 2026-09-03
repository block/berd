import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { SessionChatRuntime } from "@/shared/types/chat";
import { QueuedMessageOwnershipLostError } from "./preCommitSendRejection";
import { dispatchPrompt } from "./sendCore";
import { registerRealtimeEmissary } from "@/features/voice-conversation/lib/realtimeEmissaryBridge";
import { setVoiceConversationMode } from "@/features/voice-conversation/lib/voiceConversationModePreference";

const mocks = vi.hoisted(() => ({
  acpExportSession: vi.fn(),
  acpSendMessage: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpExportSession: (...args: unknown[]) => mocks.acpExportSession(...args),
  acpSendMessage: (...args: unknown[]) => mocks.acpSendMessage(...args),
}));

describe("dispatchPrompt pre-commit rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.removeItem("goose:voice-conversation-mode");
    mocks.acpExportSession.mockResolvedValue("{}");
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

  it("does not inspect prior assistant text for an ordinary text prompt", async () => {
    const inaccessibleText = { type: "text" } as {
      type: "text";
      text: string;
    };
    Object.defineProperty(inaccessibleText, "text", {
      get: () => {
        throw new Error("ordinary text sends must not scan transcript content");
      },
    });
    useChatStore.getState().addMessage("session-1", {
      id: "prior-assistant",
      role: "assistant",
      created: 1,
      content: [inaccessibleText],
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

    await expect(
      dispatchPrompt("session-1", "ordinary text", {}),
    ).resolves.toBeUndefined();
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
    mocks.acpExportSession.mockResolvedValue("{}");
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

describe("dispatchPrompt realtime Master transcript recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acpExportSession.mockResolvedValue("{}");
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
  });

  it("does not notify the emissary when a Master turn completes", async () => {
    const sendMasterMessage = vi.fn();
    const completeMasterTurn = vi.fn();
    const release = registerRealtimeEmissary({
      sessionId: "session-1",
      sendMasterMessage,
      dismissHandoffs: vi.fn(),
      completeMasterTurn,
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

    expect(sendMasterMessage).not.toHaveBeenCalled();
    expect(completeMasterTurn).toHaveBeenCalledWith({
      reminderHandoffIds: [],
    });
    expect(useChatStore.getState().messagesBySession["session-1"]).toHaveLength(
      2,
    );
    release();
  });

  it("keeps a completed Expert turn successful when Realtime completion fails", async () => {
    const release = registerRealtimeEmissary({
      sessionId: "session-1",
      sendMasterMessage: vi.fn(),
      dismissHandoffs: vi.fn(),
      completeMasterTurn: () => {
        throw new Error("Realtime owner disappeared");
      },
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
          content: [{ type: "text", text: "The Expert finished." }],
          metadata: { completionStatus: "completed" },
        });
        return Promise.resolve();
      },
    );

    await expect(
      dispatchPrompt("session-1", "Complete the work", {}),
    ).resolves.toBeUndefined();
    expect(
      useChatStore.getState().getSessionRuntime("session-1").error,
    ).toBeNull();
    release();
  });

  it("returns private reminder handoff ids to the realtime bridge", async () => {
    const completeMasterTurn = vi.fn();
    const release = registerRealtimeEmissary({
      sessionId: "session-1",
      sendMasterMessage: vi.fn(),
      dismissHandoffs: vi.fn(),
      completeMasterTurn,
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
          id: "master-reminder-final",
          role: "assistant",
          created: Date.now(),
          content: [{ type: "text", text: "Reminder handled." }],
          metadata: {
            agentVisible: true,
            userVisible: true,
            completionStatus: "completed",
          },
        });
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "Private reminder", {
      acpGooseMetadata: {
        realtimeHandoffReminderIds: ["handoff-1", "handoff-2"],
      },
    });

    expect(completeMasterTurn).toHaveBeenCalledWith({
      reminderHandoffIds: ["handoff-1", "handoff-2"],
    });
    release();
  });

  it("completes a realtime lifecycle that joins an existing Master run", async () => {
    let finishPrompt: (() => void) | undefined;
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
        return new Promise<void>((resolve) => {
          finishPrompt = () => {
            useChatStore.getState().addMessage(sessionId, {
              id: "master-final-after-realtime-start",
              role: "assistant",
              created: Date.now(),
              content: [{ type: "text", text: "The Expert finished." }],
              metadata: {
                agentVisible: true,
                userVisible: true,
                completionStatus: "completed",
              },
            });
            resolve();
          };
        });
      },
    );

    const prompt = dispatchPrompt("session-1", "Already running", {});
    await vi.waitFor(() => expect(finishPrompt).toBeTypeOf("function"));

    setVoiceConversationMode("openai-realtime");
    const completeMasterTurn = vi.fn();
    const release = registerRealtimeEmissary({
      sessionId: "session-1",
      sendMasterMessage: vi.fn(),
      dismissHandoffs: vi.fn(),
      completeMasterTurn,
    });
    finishPrompt?.();
    await prompt;

    expect(completeMasterTurn).toHaveBeenCalledWith({
      reminderHandoffIds: [],
    });
    release();
  });

  it("keeps a new-session Master turn owned until hydration publishes its final text", async () => {
    const release = registerRealtimeEmissary({
      sessionId: "session-1",
      sendMasterMessage: vi.fn(),
      dismissHandoffs: vi.fn(),
      completeMasterTurn: vi.fn(),
    });
    useChatStore.getState().setSessionLoading("session-1", true);
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
            id: "hydrating-master-final",
            role: "assistant",
            created: Date.now(),
            content: [{ type: "text", text: "The hydrated final answer." }],
            metadata: {
              agentVisible: true,
              userVisible: true,
              completionStatus: "completed",
            },
          });
          useChatStore.getState().setSessionLoading(sessionId, false);
        }, 20);
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "Check the answer", {});

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.at(-1),
    ).toMatchObject({
      id: "hydrating-master-final",
      content: [{ type: "text", text: "The hydrated final answer." }],
    });
    release();
  });

  it("recovers missed Master thinking, tools, and final text from the durable turn", async () => {
    const release = registerRealtimeEmissary({
      sessionId: "session-1",
      sendMasterMessage: vi.fn(),
      dismissHandoffs: vi.fn(),
      completeMasterTurn: vi.fn(),
    });
    mocks.acpExportSession.mockResolvedValue(
      JSON.stringify({
        conversation: [
          {
            id: "master-user",
            role: "user",
            created: 1_788_111_502,
            content: [{ type: "text", text: "Count repositories" }],
          },
          {
            id: "master-work",
            role: "assistant",
            created: 1_788_111_505,
            content: [
              { type: "thinking", thinking: "I should inspect the disk." },
              {
                type: "toolRequest",
                id: "tool-1",
                toolCall: {
                  status: "success",
                  value: { name: "shell", arguments: { command: "find" } },
                },
              },
            ],
          },
          {
            id: "master-tool-result",
            role: "user",
            created: 1_788_111_505,
            content: [
              {
                type: "toolResponse",
                id: "tool-1",
                toolResult: {
                  status: "success",
                  value: {
                    content: [{ type: "text", text: "21" }],
                    isError: false,
                  },
                },
              },
            ],
          },
          {
            id: "master-final",
            role: "assistant",
            created: 1_788_111_506,
            content: [{ type: "text", text: "There are 21 repositories." }],
          },
        ],
      }),
    );
    mocks.acpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options: {
          onPromptDispatching(): void;
          onPromptDispatched(): void;
        },
      ) => {
        options.onPromptDispatching();
        options.onPromptDispatched();
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "Count repositories", {});

    const recovered = useChatStore
      .getState()
      .messagesBySession["session-1"]?.filter(
        (message) => message.role === "assistant",
      );
    expect(recovered).toMatchObject([
      {
        id: "master-work",
        content: [
          { type: "thinking", text: "I should inspect the disk." },
          { type: "toolRequest", id: "tool-1", status: "completed" },
          { type: "toolResponse", id: "tool-1", result: "21" },
        ],
      },
      {
        id: "master-final",
        content: [{ type: "text", text: "There are 21 repositories." }],
      },
    ]);
    release();
  });
});
