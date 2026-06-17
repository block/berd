import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useChatStore } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import type { Message } from "@/shared/types/messages";
import { clearReplayBuffer } from "../replayBuffer";

const mockAcpSendMessage = vi.fn();
const mockAcpSteerMessage = vi.fn();
const mockAcpCancelSession = vi.fn();
const mockAcpLoadSession = vi.fn();
const mockAcpPrepareSession = vi.fn();
const mockAcpSetModel = vi.fn();

vi.mock("@/shared/api/acp", () => ({
  acpSendMessage: (...args: unknown[]) => mockAcpSendMessage(...args),
  acpSteerMessage: (...args: unknown[]) => mockAcpSteerMessage(...args),
  acpCancelSession: (...args: unknown[]) => mockAcpCancelSession(...args),
  acpLoadSession: (...args: unknown[]) => mockAcpLoadSession(...args),
  acpPrepareSession: (...args: unknown[]) => mockAcpPrepareSession(...args),
  acpSetModel: (...args: unknown[]) => mockAcpSetModel(...args),
}));

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
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useChat", () => {
  beforeEach(() => {
    mockAcpSendMessage.mockReset();
    mockAcpSteerMessage.mockReset();
    mockAcpCancelSession.mockReset();
    mockAcpLoadSession.mockReset();
    mockAcpPrepareSession.mockReset();
    mockAcpSetModel.mockReset();
    clearReplayBuffer("session-1");
    clearReplayBuffer("session-2");
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
      isContextPanelOpen: false,
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
    mockAcpSteerMessage.mockResolvedValue("run-1");
    mockAcpCancelSession.mockResolvedValue(true);
    mockAcpLoadSession.mockResolvedValue(undefined);
    mockAcpPrepareSession.mockResolvedValue(undefined);
    mockAcpSetModel.mockResolvedValue(undefined);
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

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = result.current.sendMessage("wait for it");
      await Promise.resolve();
    });

    expect(
      useChatStore.getState().getSessionRuntime("session-1").chatState,
    ).toBe("thinking");

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
    ).toBe(false);

    await act(async () => {
      prepareDeferred.resolve(undefined);
      await sendPromise;
    });

    expect(mockAcpSendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().getSessionRuntime("session-1").chatState,
    ).toBe("idle");
  });

  it("steers the active run without changing chat state", async () => {
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
        role: "user",
        metadata: {
          delivery: "steer",
          userVisible: true,
        },
      },
    ]);
  });

  it("registers the intervention boundary before the backend acknowledges the steer", async () => {
    const steerDeferred = createDeferredPromise<string>();
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
      { role: "user", metadata: { delivery: "steer" } },
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
      steerDeferred.resolve("run-2");
      await steerPromise;
    });
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
        metadata: { delivery: "steer" },
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

  it("does not mark the message stopped when cancellation reports no active session", async () => {
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

    await act(async () => {
      result.current.stopGeneration();
      await Promise.resolve();
    });

    const message = useChatStore.getState().messagesBySession["session-1"][0];
    expect(message.metadata?.completionStatus).toBe("inProgress");
  });

  it("allows another session to send while a different session is streaming", async () => {
    const deferred = createDeferredPromise();
    mockAcpSendMessage
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValueOnce(undefined);

    const firstSession = renderHook(() => useChat("session-1"));
    const secondSession = renderHook(() => useChat("session-2"));

    let firstPromise!: Promise<void>;
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
      {
        systemPrompt: undefined,
        personaId: undefined,
        personaName: undefined,
        images: undefined,
      },
    );
    expect(mockAcpSendMessage).toHaveBeenNthCalledWith(
      2,
      "session-2",
      "Second",
      {
        systemPrompt: undefined,
        personaId: undefined,
        personaName: undefined,
        images: undefined,
      },
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
          providerId: "openai",
          modelId: "gpt-4.1",
          modelName: "GPT-4.1",
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

    expect(mockAcpSendMessage).toHaveBeenCalledWith("session-1", "Hello", {
      systemPrompt: undefined,
      personaId: undefined,
      personaName: undefined,
      images: undefined,
    });
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
      await Promise.resolve();

      expect(onMessageAccepted).toHaveBeenCalledTimes(1);
      expect(
        useChatStore.getState().messagesBySession["session-1"],
      ).toHaveLength(1);

      deferred.resolve();
      await sendPromise;
    });
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

  it("does not prompt when preparation is superseded", async () => {
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

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].content).toEqual([
      {
        type: "systemNotification",
        notificationType: "error",
        text: "Session configuration changed while preparing. Try sending again.",
      },
    ]);
    expect(runtime.error).toBe(
      "Session configuration changed while preparing. Try sending again.",
    );
    expect(runtime.chatState).toBe("idle");
    expect(runtime.streamingMessageId).toBeNull();
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
