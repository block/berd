import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "../../stores/chatStore";
import {
  useChatSessionStore,
  type ChatSession,
} from "../../stores/chatSessionStore";
import { workspaceAttachmentIdForPath } from "../../lib/workspaceAttachments";
import type { Message } from "@/shared/types/messages";
import { clearReplayBuffer } from "../replayBuffer";
import {
  clearStreamingMessageOwners,
  enqueueStreamingTextUpdate,
  flushAllBufferedStreamingUpdates,
} from "../../acp/liveStreamingUpdates";
import { claimSessionPrompt } from "../../lib/sessionPromptOwnership";

const mockAcpSendMessage = vi.fn();
const mockAcpSteerMessage = vi.fn();
const mockAcpCancelSession = vi.fn();
const mockAcpLoadSession = vi.fn();
const mockAcpPrepareSession = vi.fn();
let mockAcpDispatches = true;

vi.mock("@/shared/api/acp", () => ({
  acpSendMessage: (...args: unknown[]) => {
    const result = mockAcpSendMessage(...args);
    const options = args[2] as
      | {
          onPromptDispatching?: () => void;
          onPromptDispatched?: () => void;
        }
      | undefined;
    if (mockAcpDispatches) {
      options?.onPromptDispatching?.();
      options?.onPromptDispatched?.();
    }
    return result;
  },
  acpSteerMessage: (...args: unknown[]) => mockAcpSteerMessage(...args),
  acpCancelSession: (...args: unknown[]) => mockAcpCancelSession(...args),
  acpLoadSession: (...args: unknown[]) => mockAcpLoadSession(...args),
  acpPrepareSession: (...args: unknown[]) => mockAcpPrepareSession(...args),
}));

import { handleSessionNotification } from "../../acp/acpNotificationHandler";
import { useChat } from "../useChat";

function addStreamingAssistantMessage(
  sessionId: string,
  messageId: string,
  personaId: string,
  personaName: string,
) {
  const message: Message = {
    id: messageId,
    role: "assistant",
    created: Date.now(),
    content: [],
    metadata: {
      userVisible: true,
      agentVisible: true,
      personaId,
      personaName,
      completionStatus: "inProgress",
    },
  };

  useChatStore.getState().addMessage(sessionId, message);
  useChatStore.getState().setStreamingMessageId(sessionId, messageId);
}

function createDeferredPromise<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function seedChatSession(overrides: Partial<ChatSession> = {}) {
  useChatSessionStore.setState({
    sessions: [
      {
        id: "session-1",
        title: "New Chat",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        messageCount: 0,
        ...overrides,
      },
    ],
  });
}

describe("useChat", () => {
  beforeEach(() => {
    mockAcpSendMessage.mockReset();
    mockAcpSteerMessage.mockReset();
    mockAcpCancelSession.mockReset();
    mockAcpLoadSession.mockReset();
    mockAcpPrepareSession.mockReset();
    mockAcpDispatches = true;
    clearReplayBuffer("session-1");
    clearReplayBuffer("session-2");
    clearStreamingMessageOwners();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      activeSessionId: null,
      isConnected: true,
    });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
    useAgentStore.setState({
      personas: [
        {
          id: "persona-a",
          displayName: "Persona A",
          systemPrompt: "",
          isBuiltin: false,
          writable: true,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "persona-b",
          displayName: "Persona B",
          systemPrompt: "",
          isBuiltin: false,
          writable: true,
          createdAt: "",
          updatedAt: "",
        },
      ],
      personasLoading: false,
      agents: [],
      agentsLoading: false,
      activeAgentId: null,
      isLoading: false,
    });
    mockAcpSendMessage.mockResolvedValue(undefined);
    mockAcpSteerMessage.mockResolvedValue({
      runId: "run-1",
      messageId: "steer-message",
    });
    mockAcpCancelSession.mockResolvedValue(true);
    mockAcpLoadSession.mockResolvedValue(undefined);
    mockAcpPrepareSession.mockResolvedValue(undefined);
  });

  it("dispatches to its addressed session without changing route-active selection", async () => {
    seedChatSession();
    useChatStore.setState({ activeSessionId: "route-session" });
    useChatSessionStore.setState({ activeSessionId: "route-session" });
    const { result } = renderHook(() => useChat("session-1"));

    await act(async () => {
      await result.current.sendMessage("Canvas prompt");
    });

    expect(mockAcpSendMessage).toHaveBeenCalledWith(
      "session-1",
      "Canvas prompt",
      expect.any(Object),
    );
    expect(useChatStore.getState().activeSessionId).toBe("route-session");
    expect(useChatSessionStore.getState().activeSessionId).toBe(
      "route-session",
    );
  });

  it("marks the streaming message stopped only after cancellation succeeds", async () => {
    const cancelDeferred = createDeferredPromise<boolean>();
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setChatState("session-1", "streaming");
    });

    act(() => {
      result.current.stopGeneration();
    });

    let message = useChatStore.getState().messagesBySession["session-1"][0];
    const runtime = useChatStore.getState().getSessionRuntime("session-1");

    expect(message.metadata?.completionStatus).toBe("inProgress");
    expect(runtime.chatState).toBe("idle");
    expect(runtime.streamingMessageId).toBeNull();

    await act(async () => {
      cancelDeferred.resolve(true);
      await cancelDeferred.promise;
    });

    message = useChatStore.getState().messagesBySession["session-1"][0];
    expect(message.metadata?.completionStatus).toBe("stopped");
  });

  it("coalesces repeated stops while cancellation is pending", async () => {
    const cancelDeferred = createDeferredPromise<boolean>();
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setChatState("session-1", "streaming");
      first = result.current.stopGeneration();
      second = result.current.stopGeneration();
    });

    expect(second).toBe(first);
    expect(mockAcpCancelSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      cancelDeferred.resolve(true);
      await first;
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.metadata
        ?.completionStatus,
    ).toBe("stopped");
  });

  it("marks the message stopped when run settlement precedes cancellation response", async () => {
    const cancelDeferred = createDeferredPromise<boolean>();
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));
    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setActiveRunId("session-1", "run-1");
      useChatStore.getState().setChatState("session-1", "streaming");
      result.current.stopGeneration();
      useChatStore.getState().settleActiveRun("session-1");
    });

    await act(async () => {
      cancelDeferred.resolve(true);
      await cancelDeferred.promise;
    });

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.metadata
        ?.completionStatus,
    ).toBe("stopped");
  });

  it("keeps the active run id after the cancel request returns", async () => {
    const cancelDeferred = createDeferredPromise<boolean>();
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    act(() => {
      useChatStore.getState().setActiveRunId("session-1", "run-1");
      useChatStore.getState().setChatState("session-1", "streaming");
    });

    let cancellation!: Promise<boolean>;
    act(() => {
      cancellation = result.current.stopGeneration();
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1").chatState,
    ).toBe("idle");
    expect(
      useChatStore.getState().getSessionRuntime("session-1").activeRunId,
    ).toBe("run-1");
    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(true);

    await act(async () => {
      cancelDeferred.resolve(true);
      await cancellation;
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1").activeRunId,
    ).toBe("run-1");
    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(true);
  });

  it("ignores a stale cancellation after a newer stop begins", async () => {
    const firstCancellation = createDeferredPromise<boolean>();
    const secondCancellation = createDeferredPromise<boolean>();
    mockAcpCancelSession
      .mockReturnValueOnce(firstCancellation.promise)
      .mockReturnValueOnce(secondCancellation.promise);

    const { result } = renderHook(() => useChat("session-1"));
    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setChatState("session-1", "streaming");
      result.current.stopGeneration();
      useChatStore.getState().settleActiveRun("session-1");
      addStreamingAssistantMessage(
        "session-1",
        "assistant-2",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setChatState("session-1", "streaming");
      result.current.stopGeneration();
      useChatStore.getState().setStreamingMessageId("session-1", "assistant-2");
    });

    await act(async () => {
      firstCancellation.resolve(true);
      await firstCancellation.promise;
    });

    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.isRunCancellationPending).toBe(true);
    expect(runtime.streamingMessageId).toBe("assistant-2");
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0]?.metadata
        ?.completionStatus,
    ).toBe("inProgress");

    await act(async () => {
      secondCancellation.resolve(false);
      await secondCancellation.promise;
    });
  });

  it("lets a pending stop win when the prompt settles first", async () => {
    const promptDeferred = createDeferredPromise<void>();
    const cancelDeferred = createDeferredPromise<boolean>();
    mockAcpSendMessage.mockReturnValue(promptDeferred.promise);
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = result.current.sendMessage("stop this");
      await Promise.resolve();
    });
    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      result.current.stopGeneration();
    });

    await act(async () => {
      promptDeferred.resolve();
      await sendPromise;
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[1]?.metadata
        ?.completionStatus,
    ).toBe("inProgress");

    await act(async () => {
      cancelDeferred.resolve(true);
      await cancelDeferred.promise;
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[1]?.metadata
        ?.completionStatus,
    ).toBe("stopped");
  });

  it("completes the stopped assistant when cancellation finds no active run before prompt settlement", async () => {
    const firstPromptDeferred = createDeferredPromise<void>();
    const secondPromptDeferred = createDeferredPromise<void>();
    const cancelDeferred = createDeferredPromise<boolean>();
    mockAcpSendMessage
      .mockReturnValueOnce(firstPromptDeferred.promise)
      .mockReturnValueOnce(secondPromptDeferred.promise);
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let firstSendPromise!: Promise<boolean>;
    await act(async () => {
      firstSendPromise = result.current.sendMessage("too late to stop");
      await Promise.resolve();
    });
    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      result.current.stopGeneration();
    });

    await act(async () => {
      cancelDeferred.resolve(false);
      await cancelDeferred.promise;
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[1]?.metadata
        ?.completionStatus,
    ).toBe("inProgress");

    act(() => {
      useChatStore.getState().setActiveRunId("session-1", null);
      useChatStore.getState().setRunCancellationPending("session-1", false);
      claimSessionPrompt("session-1");
    });
    let secondSendPromise!: Promise<boolean>;
    await act(async () => {
      secondSendPromise = result.current.sendMessage("follow up");
      await Promise.resolve();
    });
    act(() => {
      claimSessionPrompt("session-1");
      addStreamingAssistantMessage(
        "session-1",
        "assistant-2",
        "persona-a",
        "Persona A",
      );
    });
    await act(async () => {
      firstPromptDeferred.resolve();
      await firstSendPromise;
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[1]?.metadata
        ?.completionStatus,
    ).toBe("completed");
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[3]?.metadata
        ?.completionStatus,
    ).toBe("inProgress");

    await act(async () => {
      secondPromptDeferred.resolve();
      await secondSendPromise;
    });
  });

  it("completes the settled assistant when cancellation finds no active run", async () => {
    const promptDeferred = createDeferredPromise<void>();
    const cancelDeferred = createDeferredPromise<boolean>();
    mockAcpSendMessage.mockReturnValue(promptDeferred.promise);
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = result.current.sendMessage("too late to stop");
      await Promise.resolve();
    });
    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      result.current.stopGeneration();
    });

    await act(async () => {
      promptDeferred.resolve();
      await sendPromise;
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[1]?.metadata
        ?.completionStatus,
    ).toBe("inProgress");

    await act(async () => {
      cancelDeferred.resolve(false);
      await cancelDeferred.promise;
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[1]?.metadata
        ?.completionStatus,
    ).toBe("completed");
  });

  it("completes the settled assistant when cancellation rejects", async () => {
    const promptDeferred = createDeferredPromise<void>();
    const cancelDeferred = createDeferredPromise<void>();
    mockAcpSendMessage.mockReturnValue(promptDeferred.promise);
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = result.current.sendMessage("too late to stop");
      await Promise.resolve();
    });
    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      result.current.stopGeneration();
    });

    await act(async () => {
      promptDeferred.resolve();
      await sendPromise;
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[1]?.metadata
        ?.completionStatus,
    ).toBe("inProgress");

    await act(async () => {
      cancelDeferred.reject(new Error("cancel failed"));
      try {
        await cancelDeferred.promise;
      } catch {
        // stopGeneration handles cancellation rejection internally.
      }
      await Promise.resolve();
    });
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[1]?.metadata
        ?.completionStatus,
    ).toBe("completed");
  });

  it("marks the streaming assistant completed when the prompt settles", async () => {
    const promptDeferred = createDeferredPromise<void>();
    mockAcpSendMessage.mockReturnValue(promptDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = result.current.sendMessage("finish this");
      await Promise.resolve();
    });
    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
    });

    await act(async () => {
      promptDeferred.resolve();
      await sendPromise;
    });

    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[1]?.metadata
        ?.completionStatus,
    ).toBe("completed");
  });

  it("preserves a newer assistant when the final flush changes prompt ownership", async () => {
    const promptDeferred = createDeferredPromise<void>();
    mockAcpSendMessage.mockReturnValue(promptDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = result.current.sendMessage("first prompt");
      await Promise.resolve();
    });
    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      enqueueStreamingTextUpdate("session-1", "assistant-1", "final text");
      const unsubscribe = useChatStore.subscribe(
        (state) => state.messagesBySession["session-1"],
        () => {
          unsubscribe();
          claimSessionPrompt("session-1");
          addStreamingAssistantMessage(
            "session-1",
            "assistant-2",
            "persona-a",
            "Persona A",
          );
        },
        { fireImmediately: false },
      );
    });

    await act(async () => {
      promptDeferred.resolve();
      await sendPromise;
    });

    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(
      messages.find((message) => message.id === "assistant-1"),
    ).toMatchObject({
      content: [{ type: "text", text: "final text" }],
      metadata: { completionStatus: "completed" },
    });
    expect(
      messages.find((message) => message.id === "assistant-2")?.metadata
        ?.completionStatus,
    ).toBe("inProgress");
    expect(
      useChatStore.getState().getSessionRuntime("session-1").streamingMessageId,
    ).toBe("assistant-2");
  });

  it("clears stopped-run metadata when the foreground ACP prompt settles", async () => {
    const promptDeferred = createDeferredPromise<void>();
    mockAcpSendMessage.mockReturnValue(promptDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = result.current.sendMessage("keep working");
      await Promise.resolve();
    });

    act(() => {
      useChatStore.getState().setActiveRunId("session-1", "run-1");
      result.current.stopGeneration();
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(true);

    await act(async () => {
      promptDeferred.resolve();
      await sendPromise;
    });

    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.activeRunId).toBeNull();
    expect(runtime.isRunCancellationPending).toBe(false);
  });

  it("does not mark a newer follow-up idle when the stopped prompt settles", async () => {
    const firstPromptDeferred = createDeferredPromise<void>();
    const secondPromptDeferred = createDeferredPromise<void>();
    mockAcpSendMessage
      .mockReturnValueOnce(firstPromptDeferred.promise)
      .mockReturnValueOnce(secondPromptDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let firstSendPromise!: Promise<boolean>;
    await act(async () => {
      firstSendPromise = result.current.sendMessage("first prompt");
      await Promise.resolve();
    });

    act(() => {
      useChatStore.getState().setActiveRunId("session-1", "run-1");
      result.current.stopGeneration();
      useChatStore.getState().setActiveRunId("session-1", null);
      useChatStore.getState().setRunCancellationPending("session-1", false);
    });

    let secondSendPromise!: Promise<boolean>;
    await act(async () => {
      secondSendPromise = result.current.sendMessage("second prompt");
      await Promise.resolve();
    });

    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-2",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setActiveRunId("session-1", "run-2");
    });

    await act(async () => {
      firstPromptDeferred.resolve();
      await firstSendPromise;
    });

    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.chatState).toBe("streaming");
    expect(runtime.streamingMessageId).toBe("assistant-2");
    expect(runtime.activeRunId).toBe("run-2");

    await act(async () => {
      secondPromptDeferred.resolve();
      await secondSendPromise;
    });
  });

  it("drops buffered chunks owned by a superseded stopped prompt", async () => {
    const scheduledFrames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        scheduledFrames.push(callback);
        return scheduledFrames.length;
      });
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    const firstPromptDeferred = createDeferredPromise<void>();
    const secondPromptDeferred = createDeferredPromise<void>();
    mockAcpSendMessage
      .mockReturnValueOnce(firstPromptDeferred.promise)
      .mockReturnValueOnce(secondPromptDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let firstSendPromise!: Promise<boolean>;
    await act(async () => {
      firstSendPromise = result.current.sendMessage("first prompt");
      await Promise.resolve();
    });

    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      enqueueStreamingTextUpdate(
        "session-1",
        "assistant-1",
        "text before stop",
      );
      result.current.stopGeneration();
      useChatStore.getState().setActiveRunId("session-1", null);
      useChatStore.getState().setRunCancellationPending("session-1", false);
    });

    let secondSendPromise!: Promise<boolean>;
    await act(async () => {
      secondSendPromise = result.current.sendMessage("second prompt");
      await Promise.resolve();
    });
    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-2",
        "persona-a",
        "Persona A",
      );
      enqueueStreamingTextUpdate(
        "session-1",
        "assistant-1",
        "late stale buffered text",
      );
    });

    await act(async () => {
      firstPromptDeferred.resolve();
      await firstSendPromise;
      flushAllBufferedStreamingUpdates();
    });

    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.streamingMessageId).toBe("assistant-2");
    expect(
      useChatStore
        .getState()
        .messagesBySession["session-1"].find(
          (message) => message.id === "assistant-1",
        )?.content,
    ).toEqual([{ type: "text", text: "text before stop" }]);

    await act(async () => {
      secondPromptDeferred.resolve();
      await secondSendPromise;
    });
    requestAnimationFrame.mockRestore();
    cancelAnimationFrame.mockRestore();
  });

  it("preserves follow-up state across a ChatView remount", async () => {
    const firstPromptDeferred = createDeferredPromise<void>();
    const secondPromptDeferred = createDeferredPromise<void>();
    mockAcpSendMessage
      .mockReturnValueOnce(firstPromptDeferred.promise)
      .mockReturnValueOnce(secondPromptDeferred.promise);

    const firstHook = renderHook(() => useChat("session-1"));

    let firstSendPromise!: Promise<boolean>;
    await act(async () => {
      firstSendPromise = firstHook.result.current.sendMessage("first prompt");
      await Promise.resolve();
    });

    act(() => {
      useChatStore.getState().setActiveRunId("session-1", "run-1");
      firstHook.result.current.stopGeneration();
      useChatStore.getState().setActiveRunId("session-1", null);
      useChatStore.getState().setRunCancellationPending("session-1", false);
    });
    firstHook.unmount();

    const secondHook = renderHook(() => useChat("session-1"));
    let secondSendPromise!: Promise<boolean>;
    await act(async () => {
      secondSendPromise =
        secondHook.result.current.sendMessage("second prompt");
      await Promise.resolve();
    });

    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-2",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setActiveRunId("session-1", "run-2");
    });

    await act(async () => {
      firstPromptDeferred.resolve();
      await firstSendPromise;
    });

    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.chatState).toBe("streaming");
    expect(runtime.streamingMessageId).toBe("assistant-2");
    expect(runtime.activeRunId).toBe("run-2");

    await act(async () => {
      secondPromptDeferred.resolve();
      await secondSendPromise;
    });
  });

  it("does not clear cancellation state owned by a newer prompt", async () => {
    const firstPromptDeferred = createDeferredPromise<void>();
    const secondPromptDeferred = createDeferredPromise<void>();
    mockAcpSendMessage
      .mockReturnValueOnce(firstPromptDeferred.promise)
      .mockReturnValueOnce(secondPromptDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let firstSendPromise!: Promise<boolean>;
    await act(async () => {
      firstSendPromise = result.current.sendMessage("first prompt");
      await Promise.resolve();
    });

    act(() => {
      useChatStore.getState().setActiveRunId("session-1", "run-1");
      result.current.stopGeneration();
      useChatStore.getState().setActiveRunId("session-1", null);
      useChatStore.getState().setRunCancellationPending("session-1", false);
    });

    let secondSendPromise!: Promise<boolean>;
    await act(async () => {
      secondSendPromise = result.current.sendMessage("second prompt");
      await Promise.resolve();
    });

    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-2",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setActiveRunId("session-1", "run-2");
      result.current.stopGeneration();
    });

    await act(async () => {
      firstPromptDeferred.resolve();
      await firstSendPromise;
    });

    let runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.chatState).toBe("idle");
    expect(runtime.streamingMessageId).toBeNull();
    expect(runtime.activeRunId).toBe("run-2");
    expect(runtime.isRunCancellationPending).toBe(true);

    await act(async () => {
      secondPromptDeferred.resolve();
      await secondSendPromise;
    });

    runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.activeRunId).toBeNull();
    expect(runtime.isRunCancellationPending).toBe(false);
  });

  it("keeps cancellation pending after stopping a streaming run without active run metadata", async () => {
    const cancelDeferred = createDeferredPromise<boolean>();
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    act(() => {
      useChatStore.getState().setChatState("session-1", "streaming");
    });

    let cancellation!: Promise<boolean>;
    act(() => {
      cancellation = result.current.stopGeneration();
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(true);

    await act(async () => {
      cancelDeferred.resolve(true);
      await cancellation;
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(true);
  });

  it("clears cancellation pending after stopping before the ACP prompt starts", async () => {
    const prepareDeferred = createDeferredPromise<boolean | undefined>();
    const cancelDeferred = createDeferredPromise<boolean>();
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() =>
      useChat("session-1", undefined, undefined, undefined, {
        ensurePrepared: () => prepareDeferred.promise,
      }),
    );

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = result.current.sendMessage("wait for it");
      await Promise.resolve();
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1").chatState,
    ).toBe("idle");

    let cancellation!: Promise<boolean>;
    act(() => {
      cancellation = result.current.stopGeneration();
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(true);

    await act(async () => {
      cancelDeferred.resolve(true);
      await cancellation;
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(true);

    await act(async () => {
      prepareDeferred.resolve(undefined);
      await sendPromise;
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(false);

    expect(mockAcpSendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().getSessionRuntime("session-1").chatState,
    ).toBe("idle");
  });

  it("does not mark a steering message as steered before delivery", async () => {
    mockAcpSteerMessage.mockResolvedValue({
      runId: "run-1",
      messageId: "steer-message",
    });
    useChatStore.getState().setActiveRunId("session-1", "run-1");
    const { result } = renderHook(() => useChat("session-1"));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.steerMessage("lean into examples");
    });

    expect(accepted).toBe(true);
    expect(mockAcpSteerMessage).toHaveBeenCalledWith(
      "session-1",
      "run-1",
      "lean into examples",
      { images: undefined },
    );
    expect(
      useChatStore.getState().getSessionRuntime("session-1").chatState,
    ).toBe("idle");
    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toMatchObject([
      {
        id: "steer-message",
        role: "user",
        metadata: {
          userVisible: true,
        },
      },
    ]);
    expect(
      useChatStore.getState().messagesBySession["session-1"][0].metadata
        ?.delivery,
    ).toBe("steering");
  });

  it("registers the intervention boundary before the backend acknowledges the steer", async () => {
    const steerDeferred = createDeferredPromise<{
      runId: string;
      messageId: string;
    }>();
    mockAcpSteerMessage.mockReturnValue(steerDeferred.promise);
    useChatStore.getState().setActiveRunId("session-1", "run-1");
    addStreamingAssistantMessage(
      "session-1",
      "assistant-before-steer",
      "persona-a",
      "Persona A",
    );
    useChatStore.getState().updateStreamingText("session-1", "Initial answer");
    useChatStore.getState().setChatState("session-1", "streaming");

    const { result } = renderHook(() => useChat("session-1"));

    let steerPromise!: Promise<boolean>;
    await act(async () => {
      steerPromise = result.current.steerMessage("make it shorter");
      await Promise.resolve();
    });

    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages).toMatchObject([
      { id: "assistant-before-steer", role: "assistant" },
      { role: "user", metadata: { delivery: "steering" } },
    ]);
    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .pendingInterventionBoundary,
    ).toMatchObject({
      interventionMessageId: messages[1].id,
    });

    act(() => {
      useChatStore
        .getState()
        .startAssistantStreamAfterIntervention("session-1");
      useChatStore
        .getState()
        .updateStreamingText("session-1", "Revised before ack");
    });

    const updatedMessages =
      useChatStore.getState().messagesBySession["session-1"];
    expect(updatedMessages[0].content).toEqual([
      { type: "text", text: "Initial answer" },
    ]);
    expect(updatedMessages[2].content).toEqual([
      { type: "text", text: "Revised before ack" },
    ]);

    await act(async () => {
      steerDeferred.resolve({ runId: "run-1", messageId: "steer-message" });
      await steerPromise;
    });
  });

  it("keeps a delivered steer when the acknowledgement is lost", async () => {
    const steerDeferred = createDeferredPromise<{
      runId: string;
      messageId: string;
    }>();
    mockAcpSteerMessage.mockReturnValue(steerDeferred.promise);
    useChatStore.getState().setActiveRunId("session-1", "run-1");
    useChatStore.getState().setChatState("session-1", "streaming");
    const { result } = renderHook(() => useChat("session-1"));

    let steerPromise!: Promise<boolean>;
    await act(async () => {
      steerPromise = result.current.steerMessage("make it shorter");
      await Promise.resolve();
    });

    await act(async () => {
      await handleSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "backend-steer-message",
          content: { type: "text", text: "make it shorter" },
          _meta: { goose: { steer: true } },
        },
      } as never);
    });

    let accepted: boolean | undefined;
    await act(async () => {
      steerDeferred.reject(new Error("connection closed"));
      accepted = await steerPromise;
    });

    expect(accepted).toBe(true);
    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages[0]).toMatchObject({
      id: "backend-steer-message",
      role: "user",
      metadata: { delivery: "steer" },
    });
    expect(
      messages.filter((message) => message.role === "system"),
    ).toHaveLength(0);
  });

  it("preserves the active run across overlapping steer acknowledgements", async () => {
    const firstSteerDeferred = createDeferredPromise<{
      runId: string;
      messageId: string;
    }>();
    const secondSteerDeferred = createDeferredPromise<{
      runId: string;
      messageId: string;
    }>();
    mockAcpSteerMessage
      .mockReturnValueOnce(firstSteerDeferred.promise)
      .mockReturnValueOnce(secondSteerDeferred.promise);
    useChatStore.getState().setActiveRunId("session-1", "run-1");
    useChatStore.getState().setChatState("session-1", "streaming");

    const { result } = renderHook(() => useChat("session-1"));

    let firstSteerPromise!: Promise<boolean>;
    let secondSteerPromise!: Promise<boolean>;
    await act(async () => {
      firstSteerPromise = result.current.steerMessage("first steer");
      secondSteerPromise = result.current.steerMessage("second steer");
      await Promise.resolve();
    });

    expect(mockAcpSteerMessage).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "run-1",
      "first steer",
      { images: undefined },
    );
    expect(mockAcpSteerMessage).toHaveBeenNthCalledWith(
      2,
      "session-1",
      "run-1",
      "second steer",
      { images: undefined },
    );

    await act(async () => {
      firstSteerDeferred.resolve({ runId: "run-1", messageId: "steer-1" });
      secondSteerDeferred.resolve({ runId: "run-1", messageId: "steer-2" });
      await Promise.all([firstSteerPromise, secondSteerPromise]);
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1").activeRunId,
    ).toBe("run-1");
  });

  it("accepts an overlapping steer acknowledgement for the live backend run", async () => {
    const firstSteerDeferred = createDeferredPromise<{
      runId: string;
      messageId: string;
    }>();
    const secondSteerDeferred = createDeferredPromise<{
      runId: string;
      messageId: string;
    }>();
    mockAcpSteerMessage
      .mockReturnValueOnce(firstSteerDeferred.promise)
      .mockReturnValueOnce(secondSteerDeferred.promise);
    useChatStore.getState().setActiveRunId("session-1", "run-1");
    useChatStore.getState().setChatState("session-1", "streaming");

    const { result } = renderHook(() => useChat("session-1"));

    let firstSteerPromise!: Promise<boolean>;
    let secondSteerPromise!: Promise<boolean>;
    await act(async () => {
      firstSteerPromise = result.current.steerMessage("first steer");
      secondSteerPromise = result.current.steerMessage("second steer");
      await Promise.resolve();
    });

    await act(async () => {
      firstSteerDeferred.resolve({ runId: "run-2", messageId: "steer-1" });
      await firstSteerPromise;
    });
    expect(
      useChatStore.getState().getSessionRuntime("session-1").activeRunId,
    ).toBe("run-2");

    await act(async () => {
      secondSteerDeferred.resolve({ runId: "run-2", messageId: "steer-2" });
      await secondSteerPromise;
    });
    expect(
      useChatStore.getState().getSessionRuntime("session-1").activeRunId,
    ).toBe("run-2");
  });

  it("recovers a steer run when active run metadata arrives late", async () => {
    const sendDeferred = createDeferredPromise<void>();
    mockAcpSendMessage.mockReturnValue(sendDeferred.promise);
    mockAcpSteerMessage.mockResolvedValue({
      runId: "recovered-run",
      messageId: "steer-message",
    });

    const { result } = renderHook(() => useChat("session-1"));

    let sendPromise!: Promise<boolean>;
    await act(async () => {
      sendPromise = result.current.sendMessage("first prompt");
      await Promise.resolve();
      await result.current.steerMessage("make it shorter");
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1").activeRunId,
    ).toBe("recovered-run");

    await act(async () => {
      sendDeferred.resolve();
      await sendPromise;
    });
  });

  it("does not recover a null-id steer after a newer prompt takes ownership", async () => {
    const firstSendDeferred = createDeferredPromise<void>();
    const secondSendDeferred = createDeferredPromise<void>();
    const steerDeferred = createDeferredPromise<{
      runId: string;
      messageId: string;
    }>();
    mockAcpSendMessage
      .mockReturnValueOnce(firstSendDeferred.promise)
      .mockReturnValueOnce(secondSendDeferred.promise);
    mockAcpSteerMessage.mockReturnValue(steerDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let firstSendPromise!: Promise<boolean>;
    let steerPromise!: Promise<boolean>;
    await act(async () => {
      firstSendPromise = result.current.sendMessage("first prompt");
      await Promise.resolve();
      steerPromise = result.current.steerMessage("make it shorter");
      await Promise.resolve();
    });

    act(() => {
      result.current.stopGeneration();
      useChatStore.getState().setRunCancellationPending("session-1", false);
    });

    let secondSendPromise!: Promise<boolean>;
    await act(async () => {
      secondSendPromise = result.current.sendMessage("second prompt");
      await Promise.resolve();
      steerDeferred.resolve({ runId: "stale-run", messageId: "steer-message" });
      await steerPromise;
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1").activeRunId,
    ).toBeNull();

    await act(async () => {
      firstSendDeferred.resolve();
      secondSendDeferred.resolve();
      await Promise.all([firstSendPromise, secondSendPromise]);
    });
  });

  it("does not restore a stale active run when stop wins a race with steer acknowledgement", async () => {
    const steerDeferred = createDeferredPromise<{
      runId: string;
      messageId: string;
    }>();
    mockAcpSteerMessage.mockReturnValue(steerDeferred.promise);
    useChatStore.getState().setActiveRunId("session-1", "run-1");
    useChatStore.getState().setChatState("session-1", "streaming");

    const { result } = renderHook(() => useChat("session-1"));

    let steerPromise!: Promise<boolean>;
    await act(async () => {
      steerPromise = result.current.steerMessage("make it shorter");
      await Promise.resolve();
    });

    let cancellation!: Promise<boolean>;
    act(() => {
      cancellation = result.current.stopGeneration();
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(true);

    act(() => {
      // Mirror the backend's active-run-cleared notification after it accepts
      // cancellation, but before the steer request returns to the caller.
      useChatStore.getState().setActiveRunId("session-1", null);
      useChatStore.getState().setRunCancellationPending("session-1", false);
    });

    await act(async () => {
      steerDeferred.resolve({ runId: "run-1", messageId: "steer-message" });
      await Promise.all([steerPromise, cancellation]);
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1").chatState,
    ).toBe("idle");
    expect(
      useChatStore.getState().getSessionRuntime("session-1").activeRunId,
    ).toBeNull();
    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .isRunCancellationPending,
    ).toBe(false);
  });

  it("starts a new visible assistant stream when the structured intervention boundary arrives", async () => {
    useChatStore.getState().setActiveRunId("session-1", "run-1");
    addStreamingAssistantMessage(
      "session-1",
      "assistant-before-steer",
      "persona-a",
      "Persona A",
    );
    useChatStore.getState().updateStreamingText("session-1", "Initial answer");
    useChatStore.getState().setChatState("session-1", "streaming");

    const { result } = renderHook(() => useChat("session-1"));

    await act(async () => {
      await result.current.steerMessage("make it shorter");
    });

    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages).toMatchObject([
      {
        id: "assistant-before-steer",
        role: "assistant",
        content: [{ type: "text", text: "Initial answer" }],
      },
      {
        role: "user",
        metadata: { delivery: "steering" },
      },
    ]);
    expect(
      useChatStore.getState().getSessionRuntime("session-1").streamingMessageId,
    ).toBe("assistant-before-steer");
    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .pendingInterventionBoundary,
    ).toMatchObject({
      interventionMessageId: messages[1].id,
    });

    act(() => {
      useChatStore
        .getState()
        .updateStreamingText("session-1", " still belongs above");
    });

    expect(
      useChatStore.getState().messagesBySession["session-1"][0].content,
    ).toEqual([{ type: "text", text: "Initial answer still belongs above" }]);
    expect(useChatStore.getState().messagesBySession["session-1"]).toHaveLength(
      2,
    );

    act(() => {
      useChatStore
        .getState()
        .updateStreamingText("session-1", " make it shorter naturally");
    });

    expect(
      useChatStore.getState().messagesBySession["session-1"][0].content,
    ).toEqual([
      {
        type: "text",
        text: "Initial answer still belongs above make it shorter naturally",
      },
    ]);
    expect(useChatStore.getState().messagesBySession["session-1"]).toHaveLength(
      2,
    );

    act(() => {
      useChatStore
        .getState()
        .startAssistantStreamAfterIntervention("session-1");
      useChatStore
        .getState()
        .updateStreamingText("session-1", "Revised answer below");
    });

    const updatedMessages =
      useChatStore.getState().messagesBySession["session-1"];
    const continuationAssistant = updatedMessages[2];
    expect(
      useChatStore.getState().messagesBySession["session-1"][2].content,
    ).toEqual([{ type: "text", text: "Revised answer below" }]);
    expect(
      useChatStore.getState().messagesBySession["session-1"][0].content,
    ).toEqual([
      {
        type: "text",
        text: "Initial answer still belongs above make it shorter naturally",
      },
    ]);
    expect(
      useChatStore.getState().getSessionRuntime("session-1").streamingMessageId,
    ).toBe(continuationAssistant.id);
    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .pendingInterventionBoundary,
    ).toBeNull();
    expect(continuationAssistant).toMatchObject({
      role: "assistant",
      metadata: {
        completionStatus: "inProgress",
        personaId: "persona-a",
        personaName: "Persona A",
      },
    });
  });

  it("explains when steering is missing from the running backend", async () => {
    mockAcpSteerMessage.mockRejectedValue(new Error("Method not found"));
    const { result } = renderHook(() => useChat("session-1"));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.steerMessage("now about land");
    });

    expect(accepted).toBe(false);
    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toMatchObject([
      {
        role: "system",
        content: [
          {
            type: "systemNotification",
            text: "Steering is not available in this Goose backend. Restart with the steering backend branch and try again.",
          },
        ],
      },
    ]);
  });

  it("does not overwrite a completed message when stop loses the race", async () => {
    const cancelDeferred = createDeferredPromise<boolean>();
    mockAcpCancelSession.mockReturnValue(cancelDeferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setChatState("session-1", "streaming");
    });

    act(() => {
      result.current.stopGeneration();
      useChatStore
        .getState()
        .updateMessage("session-1", "assistant-1", (message) => ({
          ...message,
          metadata: {
            ...message.metadata,
            completionStatus: "completed",
          },
        }));
    });

    await act(async () => {
      cancelDeferred.resolve(true);
      await cancelDeferred.promise;
    });

    const message = useChatStore.getState().messagesBySession["session-1"][0];
    expect(message.metadata?.completionStatus).toBe("completed");
  });

  it("keeps the message active when cancellation reports no active session before prompt settlement", async () => {
    mockAcpCancelSession.mockResolvedValue(false);

    const { result } = renderHook(() => useChat("session-1"));

    act(() => {
      addStreamingAssistantMessage(
        "session-1",
        "assistant-1",
        "persona-a",
        "Persona A",
      );
      useChatStore.getState().setChatState("session-1", "streaming");
    });

    let cancellation!: Promise<boolean>;
    act(() => {
      cancellation = result.current.stopGeneration();
      useChatStore.getState().setStreamingMessageId("session-1", "assistant-1");
    });
    await act(async () => {
      await cancellation;
    });

    const message = useChatStore.getState().messagesBySession["session-1"][0];
    expect(message.metadata?.completionStatus).toBe("inProgress");
    expect(
      useChatStore.getState().getSessionRuntime("session-1"),
    ).toMatchObject({
      chatState: "idle",
      activeRunId: null,
      isRunCancellationPending: false,
      streamingMessageId: null,
    });
  });

  it("allows another session to send while a different session is streaming", async () => {
    const deferred = createDeferredPromise();
    mockAcpSendMessage
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValueOnce(undefined);

    const firstSession = renderHook(() => useChat("session-1"));
    const secondSession = renderHook(() => useChat("session-2"));

    let firstPromise!: Promise<boolean>;
    await act(async () => {
      firstPromise = firstSession.result.current.sendMessage("First");
      await Promise.resolve();
    });

    await act(async () => {
      await secondSession.result.current.sendMessage("Second");
    });

    expect(mockAcpSendMessage).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "First",
      expect.objectContaining({
        systemPrompt: undefined,
        personaId: undefined,
        personaName: undefined,
        images: undefined,
      }),
    );
    expect(mockAcpSendMessage).toHaveBeenNthCalledWith(
      2,
      "session-2",
      "Second",
      expect.objectContaining({
        systemPrompt: undefined,
        personaId: undefined,
        personaName: undefined,
        images: undefined,
      }),
    );

    deferred.resolve();
    await act(async () => {
      await firstPromise;
    });
  });

  it("sends messages without an extra session preparation step", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "New Chat",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4.1",
            modelName: "GPT-4.1",
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 0,
        },
      ],
    });

    const { result } = renderHook(() => useChat("session-1", "openai"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    expect(mockAcpSendMessage).toHaveBeenCalledWith(
      "session-1",
      "Hello",
      expect.objectContaining({
        systemPrompt: undefined,
        personaId: undefined,
        personaName: undefined,
        images: undefined,
      }),
    );
  });

  it("fires onMessageAccepted only after the message enters the session", async () => {
    const onMessageAccepted = vi.fn();
    const deferred = createDeferredPromise();
    mockAcpSendMessage.mockReturnValue(deferred.promise);

    const { result } = renderHook(() =>
      useChat("session-1", undefined, undefined, undefined, {
        onMessageAccepted,
      }),
    );

    await act(async () => {
      const sendPromise = result.current.sendMessage("Hello");
      await vi.waitFor(() => {
        expect(onMessageAccepted).toHaveBeenCalledTimes(1);
      });
      expect(
        useChatStore.getState().messagesBySession["session-1"],
      ).toHaveLength(1);

      deferred.resolve();
      await sendPromise;
    });
  });

  it("reports acceptance at user-turn commitment before the agent run settles", async () => {
    const deferred = createDeferredPromise();
    mockAcpSendMessage.mockReturnValue(deferred.promise);

    const { result } = renderHook(() => useChat("session-1"));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.sendMessage("queued turn");
    });

    expect(accepted).toBe(true);
    expect(useChatStore.getState().messagesBySession["session-1"]).toHaveLength(
      1,
    );
    expect(
      useChatStore.getState().getSessionRuntime("session-1").chatState,
    ).toBe("streaming");

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });
  });

  it("reports acceptance only after preparation and ACP dispatch start", async () => {
    const preparation = createDeferredPromise<boolean | undefined>();
    const run = createDeferredPromise();
    mockAcpSendMessage.mockReturnValue(run.promise);

    const { result } = renderHook(() =>
      useChat("session-1", undefined, undefined, undefined, {
        ensurePrepared: () => preparation.promise,
      }),
    );

    let acceptance!: Promise<boolean>;
    let settled = false;
    await act(async () => {
      acceptance = result.current.sendMessage("queued turn");
      void acceptance.then(() => {
        settled = true;
      });
      await Promise.resolve();
    });

    expect(settled).toBe(false);
    expect(mockAcpSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      preparation.resolve(undefined);
      await preparation.promise;
      await acceptance;
    });

    expect(mockAcpSendMessage).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);

    await act(async () => {
      run.resolve();
      await run.promise;
    });
  });

  it("rejects queue acceptance when preparation fails before dispatch", async () => {
    const { result } = renderHook(() =>
      useChat("session-1", undefined, undefined, undefined, {
        ensurePrepared: vi.fn().mockResolvedValue(false),
      }),
    );

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.sendMessage("queued turn");
    });

    expect(accepted).toBe(false);
    expect(mockAcpSendMessage).not.toHaveBeenCalled();
  });

  it("does not commit a user turn when ACP setup fails before transport", async () => {
    mockAcpDispatches = false;
    mockAcpSendMessage.mockRejectedValueOnce(
      new Error("ACP client unavailable"),
    );
    const { result } = renderHook(() => useChat("session-1"));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.sendMessage("queued turn");
    });

    expect(accepted).toBe(false);
    expect(
      useChatStore.getState().messagesBySession["session-1"] ?? [],
    ).toEqual([]);
  });

  it("keeps a committed user turn accepted when ACP throws before dispatch acknowledgement", async () => {
    mockAcpDispatches = false;
    mockAcpSendMessage.mockImplementationOnce(
      (
        _sessionId: string,
        _prompt: string,
        options?: {
          onPromptDispatching?: () => void;
        },
      ) => {
        options?.onPromptDispatching?.();
        return Promise.reject(new Error("transport failed after commit"));
      },
    );
    const { result } = renderHook(() => useChat("session-1"));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.sendMessage("queued turn");
    });

    expect(accepted).toBe(true);
    expect(
      useChatStore
        .getState()
        .messagesBySession["session-1"]?.filter(
          (message) => message.role === "user",
        ),
    ).toHaveLength(1);
  });

  it("does not revoke acceptance when the dispatched agent run fails", async () => {
    mockAcpSendMessage.mockRejectedValue(new Error("run failed"));
    const { result } = renderHook(() => useChat("session-1"));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.sendMessage("queued turn");
      await Promise.resolve();
    });

    expect(accepted).toBe(true);
    expect(
      useChatStore.getState().messagesBySession["session-1"]?.[0],
    ).toMatchObject({ role: "user" });
  });

  it("uses a queued execution prompt instead of current render state", async () => {
    const { result } = renderHook(() =>
      useChat("session-1", undefined, "current persona prompt"),
    );

    await act(async () => {
      await result.current.sendMessage("queued turn", undefined, undefined, {
        executionSystemPrompt: "queued persona prompt",
      });
    });

    expect(mockAcpSendMessage).toHaveBeenCalledWith(
      "session-1",
      "queued turn",
      expect.objectContaining({ systemPrompt: "queued persona prompt" }),
    );
  });

  it("awaits ensurePrepared before prompting", async () => {
    const ensurePrepared = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useChat("session-1", undefined, undefined, undefined, {
        ensurePrepared,
      }),
    );

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    expect(ensurePrepared).toHaveBeenCalledTimes(1);
    expect(ensurePrepared.mock.invocationCallOrder[0]).toBeLessThan(
      mockAcpSendMessage.mock.invocationCallOrder[0],
    );
  });

  it("marks the active workspace used before prompting", async () => {
    const defaultWorkspaceId = workspaceAttachmentIdForPath("/tmp/default");
    const activeWorkspaceId = workspaceAttachmentIdForPath("/tmp/worktree");
    seedChatSession({
      workingDir: "/tmp/default",
      workspaceAttachments: [
        {
          id: defaultWorkspaceId,
          path: "/tmp/default",
          kind: "directory",
          source: "inferred",
          branch: null,
          usedByAgent: false,
        },
      ],
      activeWorkspaceId: defaultWorkspaceId,
    });
    useChatSessionStore.setState({
      activeWorkspaceBySession: {
        "session-1": { path: "/tmp/worktree", branch: "feature/worktree" },
      },
    });

    const { result } = renderHook(() => useChat("session-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    const session = useChatSessionStore.getState().getSession("session-1");
    expect(session?.workspaceAttachments).toEqual([
      expect.objectContaining({
        id: defaultWorkspaceId,
        path: "/tmp/default",
        source: "inferred",
        usedByAgent: false,
      }),
      expect.objectContaining({
        id: activeWorkspaceId,
        path: "/tmp/worktree",
        source: "selected",
        usedByAgent: true,
      }),
    ]);
    expect(session?.activeWorkspaceId).toBe(activeWorkspaceId);
    expect(mockAcpSendMessage).toHaveBeenCalledWith(
      "session-1",
      "Hello",
      expect.objectContaining({
        systemPrompt: undefined,
        personaId: undefined,
        personaName: undefined,
        images: undefined,
      }),
    );
  });

  it("does not prompt when preparation is superseded", async () => {
    seedChatSession({ workingDir: "/tmp/project" });
    const ensurePrepared = vi.fn().mockResolvedValue(false);

    const { result } = renderHook(() =>
      useChat("session-1", undefined, undefined, undefined, {
        ensurePrepared,
      }),
    );

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    expect(ensurePrepared).toHaveBeenCalledTimes(1);
    expect(mockAcpSendMessage).not.toHaveBeenCalled();

    const messages = useChatStore.getState().messagesBySession["session-1"];
    const runtime = useChatStore.getState().getSessionRuntime("session-1");

    expect(messages).toBeUndefined();
    expect(runtime.error).toBe(
      "Session configuration changed while preparing. Try sending again.",
    );
    expect(runtime.chatState).toBe("idle");
    expect(runtime.streamingMessageId).toBeNull();
    expect(
      useChatSessionStore.getState().getSession("session-1")
        ?.workspaceAttachments,
    ).toBeUndefined();
  });

  it("appends an error message and removes the empty assistant placeholder when send fails", async () => {
    mockAcpSendMessage.mockRejectedValue(
      new Error("Working directory missing"),
    );

    const { result } = renderHook(() => useChat("session-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    const messages = useChatStore.getState().messagesBySession["session-1"];
    const runtime = useChatStore.getState().getSessionRuntime("session-1");

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("system");
    expect(messages[1].content).toEqual([
      {
        type: "systemNotification",
        notificationType: "error",
        text: "Working directory missing",
      },
    ]);
    expect(runtime.error).toBe("Working directory missing");
    expect(runtime.streamingMessageId).toBeNull();
    expect(runtime.chatState).toBe("idle");
  });

  it("shows string-shaped invoke errors instead of falling back to unknown error", async () => {
    mockAcpSendMessage.mockRejectedValue("Working directory missing");

    const { result } = renderHook(() => useChat("session-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages[1].content).toEqual([
      {
        type: "systemNotification",
        notificationType: "error",
        text: "Working directory missing",
      },
    ]);
  });

  it("surfaces ACP error data when send fails with a generic JSON-RPC message", async () => {
    const error = new Error("Internal error") as Error & { data: string };
    error.name = "RequestError";
    error.data =
      "Error getting agent reply: Failed to fetch completion from provider";
    mockAcpSendMessage.mockRejectedValue(error);

    const { result } = renderHook(() => useChat("session-1"));

    await act(async () => {
      await result.current.sendMessage("Hello");
    });

    const messages = useChatStore.getState().messagesBySession["session-1"];
    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    const detail =
      "Error getting agent reply: Failed to fetch completion from provider";

    expect(messages[1].content).toEqual([
      {
        type: "systemNotification",
        notificationType: "error",
        text: detail,
      },
    ]);
    expect(runtime.error).toBe(detail);
  });
});
