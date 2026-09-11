import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { SessionChatRuntime } from "@/shared/types/chat";
import { QueuedMessageOwnershipLostError } from "./preCommitSendRejection";
import { dispatchPrompt } from "./sendCore";

const mocks = vi.hoisted(() => ({
  acpExportSession: vi.fn(),
  acpSendMessage: vi.fn(),
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpExportSession: (...args: unknown[]) => mocks.acpExportSession(...args),
  acpSendMessage: (...args: unknown[]) => mocks.acpSendMessage(...args),
}));

vi.mock("@/shared/api/acpApi", () => ({
  archiveSession: (...args: unknown[]) => mocks.archiveSession(...args),
  unarchiveSession: (...args: unknown[]) => mocks.unarchiveSession(...args),
  renameSession: vi.fn().mockResolvedValue(undefined),
  updateSessionProject: vi.fn().mockResolvedValue(undefined),
  updateWorkingDir: vi.fn().mockResolvedValue(undefined),
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

  it("applies the final ACP update before marking the response complete", async () => {
    mocks.acpSendMessage.mockImplementationOnce(
      (
        sessionId: string,
        _prompt: string,
        options: { onPromptDispatching(): void },
      ) => {
        options.onPromptDispatching();
        const store = useChatStore.getState();
        store.addMessage(sessionId, {
          id: "assistant-1",
          role: "assistant",
          created: Date.now(),
          content: [{ type: "text", text: "N" }],
          metadata: { completionStatus: "inProgress" },
        });
        store.setStreamingMessageId(sessionId, "assistant-1");
        window.setTimeout(() => {
          useChatStore
            .getState()
            .appendStreamingText(sessionId, "assistant-1", "ora arrived.");
        }, 0);
        return Promise.resolve();
      },
    );

    await dispatchPrompt("session-1", "Tell me a story", {});

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.at(-1),
    ).toMatchObject({
      content: [{ type: "text", text: "Nora arrived." }],
      metadata: { completionStatus: "completed" },
    });
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
      dispatchPrompt("session-1", "GptLive said: Hello", {
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

describe("dispatchPrompt archived session restore", () => {
  const ARCHIVED_AT = "2026-04-02T00:00:00.000Z";

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function seedSession(overrides: Partial<ChatSession> = {}): ChatSession {
    const session: ChatSession = {
      id: "session-1",
      title: "Test Session",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 1,
      ...overrides,
    };
    useChatSessionStore.setState((state) => ({
      sessions: [
        session,
        ...state.sessions.filter((candidate) => candidate.id !== session.id),
      ],
    }));
    return session;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acpSendMessage.mockResolvedValue(undefined);
    mocks.unarchiveSession.mockResolvedValue(undefined);
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      activeWorkspaceBySession: {},
      archiveMutationBySessionId: {},
    });
  });

  it("restores an archived session before dispatching the prompt", async () => {
    seedSession({ archivedAt: ARCHIVED_AT });

    await dispatchPrompt("session-1", "hello again", {});

    expect(mocks.unarchiveSession).toHaveBeenCalledTimes(1);
    expect(mocks.unarchiveSession).toHaveBeenCalledWith("session-1");
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toBeUndefined();
    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.unarchiveSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acpSendMessage.mock.invocationCallOrder[0],
    );
  });

  it("waits for a shared durable restore before dispatching", async () => {
    seedSession({ archivedAt: ARCHIVED_AT });
    const restore = deferred<void>();
    mocks.unarchiveSession.mockReturnValue(restore.promise);

    const firstSend = dispatchPrompt("session-1", "one", {});
    const secondSend = dispatchPrompt("session-1", "two", {});
    await Promise.resolve();

    expect(mocks.unarchiveSession).toHaveBeenCalledTimes(1);
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    restore.resolve(undefined);
    await Promise.all([firstSend, secondSend]);
    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch if a newer archive wins the restore race", async () => {
    seedSession({ archivedAt: ARCHIVED_AT });
    const restore = deferred<void>();
    mocks.unarchiveSession.mockReturnValue(restore.promise);

    const send = dispatchPrompt("session-1", "hello", {});
    await Promise.resolve();
    await useChatSessionStore.getState().archiveSession("session-1");
    restore.resolve(undefined);

    await expect(send).rejects.toThrow("was archived");
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toEqual(expect.any(String));
  });

  it("leaves active sessions untouched", async () => {
    seedSession();

    await dispatchPrompt("session-1", "hello", {});

    expect(mocks.unarchiveSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when the restore fails", async () => {
    seedSession({ archivedAt: ARCHIVED_AT });
    mocks.unarchiveSession.mockRejectedValue(new Error("backend down"));

    await expect(
      dispatchPrompt("session-1", "hello again", {}),
    ).rejects.toThrow("backend down");
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toBe(ARCHIVED_AT);
  });

  it("does not restore a rejected preparation", async () => {
    seedSession({ archivedAt: ARCHIVED_AT });

    await expect(
      dispatchPrompt("session-1", "stale", {
        prepare: () => {
          throw new Error("superseded");
        },
      }),
    ).rejects.toThrow("superseded");
    expect(mocks.unarchiveSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
  });

  it("does not restore a cancelled send", async () => {
    seedSession({ archivedAt: ARCHIVED_AT });
    const controller = new AbortController();
    controller.abort();

    await expect(
      dispatchPrompt("session-1", "hello", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(mocks.unarchiveSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toBe(ARCHIVED_AT);
  });

  it("does not dispatch a send cancelled while the restore is in flight", async () => {
    seedSession({ archivedAt: ARCHIVED_AT });
    const controller = new AbortController();
    const restore = deferred<void>();
    mocks.unarchiveSession.mockReturnValue(restore.promise);

    const send = dispatchPrompt("session-1", "hello", {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    restore.resolve(undefined);

    await expect(send).rejects.toThrow();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
  });
});
