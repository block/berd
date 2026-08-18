import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import type { ChatState } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";
import { useChatStore } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";

const mockSendMessage = vi.fn();
const mockCompactConversation = vi.fn();
const mockSetSelectedProvider = vi.fn();
const mockResolveSessionCwd = vi.fn();
const mockHandleProviderChange = vi.fn();
const mockHandleModelChange = vi.fn();
let mockSelectedAgentId = "goose";
let mockMessages: Message[] = [];
let mockChatState: ChatState = "idle";
let mockActiveRunId: string | null = null;
let mockRunCancellationPending = false;
const INITIAL_TOKEN_STATE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  accumulatedInput: 0,
  accumulatedOutput: 0,
  accumulatedTotal: 0,
  contextLimit: 0,
  accumulatedCost: null,
};
let mockTokenState = { ...INITIAL_TOKEN_STATE };
let capturedQueuedSend:
  | ((
      text: string,
      overridePersona?: { id: string | null; name?: string },
      attachments?: unknown[],
      sendOptions?: unknown,
    ) => boolean | Promise<boolean>)
  | null = null;

vi.mock("../useChat", () => ({
  useChat: () => ({
    messages: mockMessages,
    chatState: mockChatState,
    tokenState: mockTokenState,
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    steerMessage: vi.fn(),
    compactConversation: (...args: unknown[]) =>
      mockCompactConversation(...args),
    stopStreaming: vi.fn(),
    streamingMessageId: null,
    activeRunId: mockActiveRunId,
    isRunCancellationPending: mockRunCancellationPending,
  }),
}));

vi.mock("../useMessageQueue", () => ({
  useMessageQueue: (...args: unknown[]) => {
    capturedQueuedSend = args[2] as typeof capturedQueuedSend;
    return {
      queuedMessage: null,
      enqueue: (
        text: string,
        personaId?: string,
        attachments?: unknown[],
        sendOptions?: unknown,
      ) =>
        capturedQueuedSend?.(
          text,
          personaId ? { id: personaId } : undefined,
          attachments,
          sendOptions,
        ) ?? false,
      dismiss: vi.fn(),
    };
  },
}));

vi.mock("../useAutoCompactPreferences", () => ({
  useAutoCompactPreferences: () => ({
    autoCompactThreshold: 0.8,
    isHydrated: true,
    setAutoCompactThreshold: vi.fn(),
  }),
}));

vi.mock("../useResolvedAgentModelPicker", () => ({
  useResolvedAgentModelPicker: () => ({
    selectedAgentId: mockSelectedAgentId,
    pickerAgents: [{ id: "goose", label: "Goose" }],
    availableModels: [],
    getModelsForAgent: () => [],
    modelsLoading: false,
    modelStatusMessage: null,
    handleProviderChange: (providerId: string) =>
      mockHandleProviderChange(providerId),
    handleModelChange: (modelId: string) => mockHandleModelChange(modelId),
    effectiveModelSelection: {
      id: "gpt-4o",
      name: "GPT-4o",
      modelProviderId: "openai",
      source: "explicit" as const,
    },
  }),
}));

vi.mock("@/features/agents/hooks/useProviderSelection", () => ({
  useProviderSelection: () => ({
    providers: [
      { id: "goose", label: "Goose" },
      { id: "openai", label: "OpenAI" },
      { id: "anthropic", label: "Anthropic" },
    ],
    providersLoading: false,
    selectedProvider: useAgentStore.getState().selectedProvider ?? "openai",
    setSelectedProvider: (...args: unknown[]) =>
      mockSetSelectedProvider(...args),
  }),
}));

vi.mock("@/features/projects/lib/sessionCwdSelection", () => ({
  resolveSessionCwd: (...args: unknown[]) => mockResolveSessionCwd(...args),
}));

import { useChatSessionController } from "../useChatSessionController";

describe("useChatSessionController compaction behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompactConversation.mockResolvedValue("completed");
    mockResolveSessionCwd.mockResolvedValue("/tmp/project");
    mockTokenState = { ...INITIAL_TOKEN_STATE };
    capturedQueuedSend = null;
    mockSelectedAgentId = "goose";
    mockMessages = [];
    mockChatState = "idle";
    mockActiveRunId = null;
    mockRunCancellationPending = false;

    useAgentStore.setState({
      personas: [],
      personasLoading: false,
      agents: [],
      agentsLoading: false,
      providers: [],
      providersLoading: false,
      selectedProvider: "openai",
      activeAgentId: null,
      isLoading: false,
    });

    useProjectStore.setState({
      projects: [],
      loading: false,
      activeProjectId: null,
    });

    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      draftsBySession: {},
      queuedMessageBySession: {},
      scrollTargetMessageBySession: {},
      activeSessionId: null,
      isConnected: true,
    });

    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Chat",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
  });

  it("hides context usage until a fresh usage snapshot exists after switching models", async () => {
    const store = useChatStore.getState();
    store.replaceTokenState(
      "session-1",
      {
        ...INITIAL_TOKEN_STATE,
        contextLimit: 400_000,
      },
      false,
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.hasUsageSnapshot).toBe(false);
    expect(runtime.tokenState).toEqual(INITIAL_TOKEN_STATE);
  });

  it("hides context usage after switching models even when a snapshot existed", async () => {
    const store = useChatStore.getState();
    store.replaceTokenState(
      "session-1",
      {
        ...INITIAL_TOKEN_STATE,
        accumulatedTotal: 12_000,
        contextLimit: 400_000,
      },
      true,
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    const runtime = useChatStore.getState().getSessionRuntime("session-1");
    expect(runtime.hasUsageSnapshot).toBe(false);
    expect(runtime.tokenState).toEqual(INITIAL_TOKEN_STATE);
  });

  it("hides pending home context usage after switching models", async () => {
    const store = useChatStore.getState();
    store.replaceTokenState(
      "__home_pending__",
      {
        ...INITIAL_TOKEN_STATE,
        accumulatedTotal: 12_000,
        contextLimit: 400_000,
      },
      true,
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: null }),
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    const runtime = useChatStore
      .getState()
      .getSessionRuntime("__home_pending__");
    expect(runtime.hasUsageSnapshot).toBe(false);
    expect(runtime.tokenState).toEqual(INITIAL_TOKEN_STATE);
  });

  it("enables manual compaction when idle and no backend run is blocking sends", async () => {
    mockMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        created: 0,
        content: [{ type: "text", text: "hello" }],
        metadata: { userVisible: true, agentVisible: true },
      },
    ];

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.canCompactContext).toBe(true);
  });

  it("disables manual compaction while a backend run is still active", async () => {
    mockMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        created: 0,
        content: [{ type: "text", text: "hello" }],
        metadata: { userVisible: true, agentVisible: true },
      },
    ];
    mockActiveRunId = "run-1";

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.canCompactContext).toBe(false);
  });

  it("disables manual compaction while stop cancellation is pending", async () => {
    mockMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        created: 0,
        content: [{ type: "text", text: "hello" }],
        metadata: { userVisible: true, agentVisible: true },
      },
    ];
    mockRunCancellationPending = true;

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.canCompactContext).toBe(false);
  });

  it("auto-compacts goose sessions before sending when the threshold is exceeded", async () => {
    mockTokenState = {
      ...INITIAL_TOKEN_STATE,
      accumulatedTotal: 8_500,
      contextLimit: 10_000,
    };
    useChatStore
      .getState()
      .replaceTokenState("session-1", mockTokenState, true);
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("session-1", { harnessId: "goose" });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await result.current.handleSend("hello");
    });

    expect(mockCompactConversation).toHaveBeenCalledOnce();
    expect(mockSendMessage).toHaveBeenCalledWith(
      "hello",
      undefined,
      undefined,
      // The chat send telemetry commit hook rides on every foreground send.
      expect.objectContaining({ onUserMessageCommitted: expect.any(Function) }),
    );
    expect(mockCompactConversation.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendMessage.mock.invocationCallOrder[0],
    );
  });

  it("continues the queued send when compaction commits but transcript refresh is incomplete", async () => {
    mockTokenState = {
      ...INITIAL_TOKEN_STATE,
      accumulatedTotal: 8_500,
      contextLimit: 10_000,
    };
    useChatStore
      .getState()
      .replaceTokenState("session-1", mockTokenState, true);
    mockCompactConversation.mockResolvedValue("completed-with-refresh-warning");

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    expect(capturedQueuedSend).not.toBeNull();
    await act(async () => {
      await capturedQueuedSend?.("hello");
    });

    expect(mockCompactConversation).toHaveBeenCalledOnce();
    expect(mockSendMessage).toHaveBeenCalledWith(
      "hello",
      undefined,
      undefined,
      // The chat send telemetry commit hook rides on every foreground send.
      expect.objectContaining({ onUserMessageCommitted: expect.any(Function) }),
    );
  });

  it("keeps compaction enabled for goose agent sessions backed by model providers", async () => {
    mockTokenState = {
      ...INITIAL_TOKEN_STATE,
      accumulatedTotal: 8_500,
      contextLimit: 10_000,
    };
    useChatStore
      .getState()
      .replaceTokenState("session-1", mockTokenState, true);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    expect(result.current.selectedProvider).toBe("goose");
    expect(result.current.supportsAutoCompactContext).toBe(true);
    expect(result.current.supportsCompactionControls).toBe(true);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await result.current.handleSend("hello");
    });

    expect(mockCompactConversation).toHaveBeenCalledOnce();
    expect(mockSendMessage).toHaveBeenCalledWith(
      "hello",
      undefined,
      undefined,
      // The chat send telemetry commit hook rides on every foreground send.
      expect.objectContaining({ onUserMessageCommitted: expect.any(Function) }),
    );
  });

  it("compacts the queued persona session before sending", async () => {
    mockTokenState = {
      ...INITIAL_TOKEN_STATE,
      accumulatedTotal: 8_500,
      contextLimit: 10_000,
    };
    useChatStore
      .getState()
      .replaceTokenState("session-1", mockTokenState, true);
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("session-1", { harnessId: "goose" });
    useChatSessionStore.getState().patchSession("session-1", {
      personaId: "persona-b",
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    expect(capturedQueuedSend).not.toBeNull();

    await act(async () => {
      await capturedQueuedSend?.("hello", { id: "persona-a" });
    });

    expect(mockCompactConversation).toHaveBeenCalledWith(
      { id: "persona-a" },
      undefined,
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      "hello",
      { id: "persona-a" },
      undefined,
      expect.objectContaining({ onUserMessageCommitted: expect.any(Function) }),
    );
  });

  it("preserves explicit no-persona intent through queued auto-compaction", async () => {
    mockSelectedAgentId = "claude-acp";
    mockTokenState = {
      ...INITIAL_TOKEN_STATE,
      accumulatedTotal: 8_500,
      contextLimit: 10_000,
    };
    useChatStore
      .getState()
      .replaceTokenState("session-1", mockTokenState, true);
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("session-1", { harnessId: "goose" });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await act(async () => {
      await capturedQueuedSend?.("hello", { id: null });
    });

    expect(mockCompactConversation).toHaveBeenCalledWith(
      { id: null },
      undefined,
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      "hello",
      { id: null },
      undefined,
      expect.objectContaining({ onUserMessageCommitted: expect.any(Function) }),
    );
  });

  it("auto-compacts queued messages for goose personas even after switching away", async () => {
    mockSelectedAgentId = "claude-acp";
    mockTokenState = {
      ...INITIAL_TOKEN_STATE,
      accumulatedTotal: 8_500,
      contextLimit: 10_000,
    };
    useChatStore
      .getState()
      .replaceTokenState("session-1", mockTokenState, true);
    useAgentStore.setState({
      personas: [
        {
          id: "persona-a",
          displayName: "Persona A",
          systemPrompt: "",
          provider: "goose",
          modelProviderId: "openai",
          model: "gpt-4o",
          isBuiltin: false,
          writable: true,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await act(async () => {
      await capturedQueuedSend?.("hello", { id: "persona-a" });
    });

    expect(mockCompactConversation).toHaveBeenCalledWith(
      { id: "persona-a" },
      undefined,
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      "hello",
      { id: "persona-a" },
      undefined,
      expect.objectContaining({ onUserMessageCommitted: expect.any(Function) }),
    );
  });

  it("skips auto-compaction for queued messages targeting unsupported personas", async () => {
    mockSelectedAgentId = "goose";
    mockTokenState = {
      ...INITIAL_TOKEN_STATE,
      accumulatedTotal: 8_500,
      contextLimit: 10_000,
    };
    useChatStore
      .getState()
      .replaceTokenState("session-1", mockTokenState, true);
    useAgentStore.setState({
      personas: [
        {
          id: "persona-a",
          displayName: "Persona A",
          systemPrompt: "",
          provider: "claude-acp",
          isBuiltin: false,
          writable: true,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await act(async () => {
      await capturedQueuedSend?.("hello", { id: "persona-a" });
    });

    expect(mockCompactConversation).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      "hello",
      { id: "persona-a" },
      undefined,
      expect.objectContaining({ onUserMessageCommitted: expect.any(Function) }),
    );
  });
});
