import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useChatStore } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { applyLatestSessionConfig } from "../../lib/sessionConfigRequests";

const mockAcpPrepareSession = vi.fn();
const mockAcpSetModel = vi.fn();
const mockSetSelectedProvider = vi.fn();
const mockResolveSessionCwd = vi.fn();
const mockGooseDefaultsRead = vi.fn();
const mockGoosePreferencesRead = vi.fn();
const mockGoosePreferencesSave = vi.fn();
const mockUseProviderInventory = vi.fn();
const mockToastError = vi.fn();
const mockUseChatSendMessage = vi.fn();
const mockUseMessageQueue = vi.fn();
const mockPickerState = {
  pickerAgents: [{ id: "goose", label: "Goose" }],
  availableModels: [] as Array<{
    id: string;
    name: string;
    displayName?: string;
    providerId?: string;
  }>,
  modelsLoading: false,
  modelStatusMessage: null as string | null,
};
const modelFixtures: Record<
  string,
  { name: string; displayName: string; providerId: string }
> = {
  "claude-sonnet-4": {
    name: "claude-sonnet-4",
    displayName: "Claude Sonnet 4",
    providerId: "anthropic",
  },
  "gpt-5.4": {
    name: "gpt-5.4",
    displayName: "GPT-5.4",
    providerId: "openai",
  },
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

vi.mock("@/shared/api/acp", () => ({
  acpPrepareSession: (...args: unknown[]) => mockAcpPrepareSession(...args),
  acpSetModel: (...args: unknown[]) => mockAcpSetModel(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseDefaultsRead: (...args: unknown[]) => mockGooseDefaultsRead(...args),
      GoosePreferencesRead: (...args: unknown[]) =>
        mockGoosePreferencesRead(...args),
      GoosePreferencesSave: (...args: unknown[]) =>
        mockGoosePreferencesSave(...args),
    },
  }),
}));

vi.mock("@/features/providers/hooks/useProviderInventory", () => ({
  useProviderInventory: () => mockUseProviderInventory(),
}));

vi.mock("../useChat", () => ({
  useChat: (
    _sessionId: string,
    _providerOverride?: string,
    _systemPromptOverride?: string,
    _personaInfo?: { id: string; name: string },
    options?: { ensurePrepared?: () => Promise<boolean | undefined> },
  ) => ({
    messages: [],
    chatState: "idle",
    tokenState: null,
    sendMessage: (...args: unknown[]) =>
      mockUseChatSendMessage(options, ...args),
    compactConversation: vi.fn(),
    stopStreaming: vi.fn(),
    streamingMessageId: null,
  }),
}));

vi.mock("../useMessageQueue", () => ({
  useMessageQueue: (...args: unknown[]) => mockUseMessageQueue(...args),
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

vi.mock("../useAgentModelPickerState", () => ({
  useAgentModelPickerState: ({
    onProviderSelected,
    onModelSelected,
  }: {
    onProviderSelected?: (providerId: string) => void;
    onModelSelected?: (model: {
      id: string;
      name: string;
      displayName?: string;
      providerId?: string;
    }) => void;
  }) => ({
    selectedAgentId: "goose",
    pickerAgents: mockPickerState.pickerAgents,
    availableModels: mockPickerState.availableModels,
    modelsLoading: mockPickerState.modelsLoading,
    modelStatusMessage: mockPickerState.modelStatusMessage,
    handleProviderChange: (providerId: string) =>
      onProviderSelected?.(providerId),
    handleModelChange: (modelId: string) => {
      const model = modelFixtures[modelId];
      if (model) {
        onModelSelected?.({
          id: modelId,
          name: model.name,
          displayName: model.displayName,
          providerId: model.providerId,
        });
      }
    },
  }),
}));

import { useChatSessionController } from "../useChatSessionController";

function latestMessageQueueArgs() {
  const call = mockUseMessageQueue.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call as [string, string, unknown];
}

describe("useChatSessionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockUseChatSendMessage.mockImplementation(
      async (options?: {
        ensurePrepared?: () => Promise<boolean | undefined>;
      }) => {
        await options?.ensurePrepared?.();
      },
    );
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: null,
      enqueue: vi.fn(),
      dismiss: vi.fn(),
    }));
    useProviderCatalogStore.getState().reset();
    useProviderCatalogStore.getState().setEntries([
      {
        id: "openai",
        displayName: "OpenAI",
        category: "model",
        description: "OpenAI",
        setupMethod: "single_api_key",
        group: "default",
      },
      {
        id: "anthropic",
        displayName: "Anthropic",
        category: "model",
        description: "Anthropic",
        setupMethod: "single_api_key",
        group: "default",
      },
    ]);
    mockAcpPrepareSession.mockResolvedValue(undefined);
    mockAcpSetModel.mockResolvedValue(undefined);
    mockResolveSessionCwd.mockResolvedValue("/tmp/project");
    mockGooseDefaultsRead.mockResolvedValue({
      providerId: null,
      modelId: null,
    });
    mockGoosePreferencesRead.mockResolvedValue({ values: [] });
    mockGoosePreferencesSave.mockResolvedValue(undefined);
    mockUseProviderInventory.mockReturnValue({
      getEntry: () => undefined,
    });
    mockPickerState.pickerAgents = [{ id: "goose", label: "Goose" }];
    mockPickerState.availableModels = [];
    mockPickerState.modelsLoading = false;
    mockPickerState.modelStatusMessage = null;

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
      personaEditorOpen: false,
      editingPersona: null,
      personaEditorMode: "create",
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
          providerId: "openai",
          modelId: "gpt-4o",
          modelName: "GPT-4o",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      isContextPanelOpen: false,
      activeWorkspaceBySession: {},
      modelSelectionIntentBySession: {},
    });
  });

  it("keeps queued messages from draining while a project draft session is pending", () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-session",
          title: "Chat",
          providerId: "openai",
          projectId: "project-1",
          creationState: "pending",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });
    useChatStore
      .getState()
      .enqueueMessage("draft-session", { text: "queued from pill" });

    renderHook(() => useChatSessionController({ sessionId: "draft-session" }));

    const [queueSessionId, queueChatState] = latestMessageQueueArgs();
    expect(queueSessionId).toBe("draft-session");
    expect(queueChatState).toBe("thinking");
    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"],
    ).toEqual({ text: "queued from pill" });
  });

  it("allows a queued draft message to drain after promotion to the backend session id", () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-session",
          title: "Chat",
          providerId: "openai",
          projectId: "project-1",
          creationState: "pending",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });
    useChatStore
      .getState()
      .enqueueMessage("draft-session", { text: "queued from pill" });

    const { rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useChatSessionController({ sessionId }),
      {
        initialProps: { sessionId: "draft-session" },
      },
    );

    expect(latestMessageQueueArgs()[1]).toBe("thinking");

    act(() => {
      useChatStore.getState().promoteSessionId("draft-session", "backend-1");
      useChatSessionStore.setState({
        sessions: [
          {
            id: "backend-1",
            title: "Chat",
            providerId: "openai",
            projectId: "project-1",
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
            messageCount: 0,
          },
        ],
      });
    });
    rerender({ sessionId: "backend-1" });

    const [queueSessionId, queueChatState] = latestMessageQueueArgs();
    expect(queueSessionId).toBe("backend-1");
    expect(queueChatState).toBe("idle");
    expect(useChatStore.getState().queuedMessageBySession["backend-1"]).toEqual(
      { text: "queued from pill" },
    );
    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"],
    ).toBeUndefined();
  });

  it("keeps failed project draft sessions from draining queued messages", () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-session",
          title: "Chat",
          providerId: "openai",
          projectId: "project-1",
          creationState: "failed",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });
    useChatStore
      .getState()
      .enqueueMessage("draft-session", { text: "queued from pill" });

    const { rerender } = renderHook(() =>
      useChatSessionController({ sessionId: "draft-session" }),
    );
    rerender();

    const [queueSessionId, queueChatState] = latestMessageQueueArgs();
    expect(queueSessionId).toBe("draft-session");
    expect(queueChatState).toBe("thinking");
    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"],
    ).toEqual({ text: "queued from pill" });
  });

  it("keeps existing non-draft sessions idle so no-project queued sends still drain", () => {
    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    const [queueSessionId, queueChatState] = latestMessageQueueArgs();
    expect(queueSessionId).toBe("session-1");
    expect(queueChatState).toBe("idle");
  });

  it("prepares the selected model provider before setting a goose model", async () => {
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "session-1",
        "anthropic",
        "/tmp/project",
      );
    });

    await waitFor(() => {
      expect(mockAcpSetModel).toHaveBeenCalledWith(
        "session-1",
        "claude-sonnet-4",
      );
    });

    expect(mockAcpPrepareSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockAcpSetModel.mock.invocationCallOrder[0],
    );
    expect(mockSetSelectedProvider).toHaveBeenCalledWith("anthropic");
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
    await waitFor(() => {
      expect(
        JSON.parse(
          window.localStorage.getItem("goose:preferredModelsByAgent") ?? "{}",
        ),
      ).toEqual({
        goose: {
          modelId: "claude-sonnet-4",
          modelName: "Claude Sonnet 4",
          providerId: "anthropic",
        },
      });
    });
    expect(
      useChatSessionStore.getState().getModelSelectionIntent("session-1"),
    ).toBeUndefined();
  });

  it("keeps the selected model when send-time preparation supersedes the model switch", async () => {
    const firstPrepare = deferred();
    mockAcpPrepareSession.mockReset();
    mockAcpPrepareSession
      .mockReturnValueOnce(firstPrepare.promise)
      .mockResolvedValue(undefined);
    mockAcpSetModel.mockReset();
    mockAcpSetModel.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    await waitFor(() => {
      expect(result.current.currentModelId).toBe("claude-sonnet-4");
    });
    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "session-1",
        "anthropic",
        "/tmp/project",
      );
    });

    act(() => {
      result.current.handleSend("use the selected model");
    });

    await waitFor(() => {
      expect(mockUseChatSendMessage).toHaveBeenCalled();
    });

    firstPrepare.resolve();

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(mockAcpSetModel).toHaveBeenCalledTimes(2);
    });
    expect(mockAcpSetModel).toHaveBeenNthCalledWith(
      2,
      "session-1",
      "claude-sonnet-4",
    );
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
  });

  it("does not let send-time preparation restore a stale model after a newer selection", async () => {
    const firstCwd = deferred<string>();
    mockResolveSessionCwd.mockReset();
    mockResolveSessionCwd
      .mockReturnValueOnce(firstCwd.promise)
      .mockResolvedValue("/tmp/project");

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleSend("use the current model");
    });

    await waitFor(() => {
      expect(mockResolveSessionCwd).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    await waitFor(() => {
      expect(mockAcpSetModel).toHaveBeenCalledWith(
        "session-1",
        "claude-sonnet-4",
      );
    });
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });

    await act(async () => {
      firstCwd.resolve("/tmp/project");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockAcpSetModel).toHaveBeenCalledTimes(1);
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
  });

  it("restores the previous stored model preference when setting a model fails", async () => {
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "gpt-4o",
          modelName: "GPT-4o",
          providerId: "openai",
        },
      }),
    );
    mockAcpSetModel.mockRejectedValueOnce(new Error("set model failed"));

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        providerId: "openai",
        modelId: "gpt-4o",
        modelName: "GPT-4o",
      });
    });

    expect(
      JSON.parse(
        window.localStorage.getItem("goose:preferredModelsByAgent") ?? "{}",
      ),
    ).toEqual({
      goose: {
        modelId: "gpt-4o",
        modelName: "GPT-4o",
        providerId: "openai",
      },
    });
    expect(mockToastError).toHaveBeenCalledWith(
      "Could not switch to Claude Sonnet 4. This chat is still using GPT-4o.",
    );
    expect(
      useChatSessionStore.getState().getModelSelectionIntent("session-1"),
    ).toBeUndefined();
    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "session-1",
        "openai",
        "/tmp/project",
      );
      expect(mockAcpSetModel).toHaveBeenCalledWith("session-1", "gpt-4o");
    });
  });

  it("keeps a newer model selection when a superseded model switch fails", async () => {
    const firstPrepare = deferred();
    mockAcpPrepareSession.mockReset();
    mockAcpPrepareSession
      .mockReturnValueOnce(firstPrepare.promise)
      .mockResolvedValue(undefined);
    mockAcpSetModel.mockReset();
    mockAcpSetModel
      .mockRejectedValueOnce(new Error("first set model failed"))
      .mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        providerId: "anthropic",
        modelId: "claude-sonnet-4",
        modelName: "Claude Sonnet 4",
      });
    });

    act(() => {
      result.current.handleModelChange("gpt-5.4");
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        providerId: "openai",
        modelId: "gpt-5.4",
        modelName: "GPT-5.4",
      });
    });

    firstPrepare.resolve();

    await waitFor(() => {
      expect(mockAcpSetModel).toHaveBeenCalledWith("session-1", "gpt-5.4");
    });
    await waitFor(() => {
      expect(
        JSON.parse(
          window.localStorage.getItem("goose:preferredModelsByAgent") ?? "{}",
        ),
      ).toEqual({
        goose: {
          modelId: "gpt-5.4",
          modelName: "GPT-5.4",
          providerId: "openai",
        },
      });
    });
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "GPT-5.4",
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("shows the stored explicit model for new chats", async () => {
    useAgentStore.setState({ selectedProvider: "goose" });
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "claude-sonnet-4",
          modelName: "Claude Sonnet 4",
          providerId: "anthropic",
        },
      }),
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: null }),
    );

    await waitFor(() => {
      expect(result.current.currentModelId).toBe("claude-sonnet-4");
    });
    expect(result.current.currentModelName).toBe("Claude Sonnet 4");
  });

  it("falls back to the configured goose default model when no explicit model is stored", async () => {
    useAgentStore.setState({ selectedProvider: "goose" });
    mockGooseDefaultsRead.mockResolvedValue({
      providerId: "databricks",
      modelId: "goose-claude-4-6-opus",
    });
    mockPickerState.availableModels = [
      {
        id: "goose-claude-4-6-opus",
        name: "Claude 4.6 Opus",
        providerId: "databricks",
      },
    ];

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: null }),
    );

    await waitFor(() => {
      expect(result.current.currentModelId).toBe("goose-claude-4-6-opus");
    });
    expect(result.current.currentModelName).toBe("Claude 4.6 Opus");
  });

  it("applies the pending Home model to ACP when a real session becomes active", async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useChatSessionController({ sessionId, isHomeSession: true }),
      {
        initialProps: { sessionId: null as string | null },
      },
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    useChatSessionStore.setState((state) => ({
      sessions: [
        {
          id: "session-2",
          title: "Chat",
          providerId: "openai",
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
          messageCount: 0,
        },
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "session-2" });

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "session-2",
        "anthropic",
        "/tmp/project",
      );
    });

    await waitFor(() => {
      expect(mockAcpSetModel).toHaveBeenCalledWith(
        "session-2",
        "claude-sonnet-4",
      );
    });

    expect(
      useChatSessionStore.getState().getSession("session-2"),
    ).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
  });

  it("moves pending Home queued messages when preparation is superseded", async () => {
    const firstPrepare = deferred();
    mockAcpPrepareSession.mockReturnValueOnce(firstPrepare.promise);

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useChatSessionController({ sessionId, isHomeSession: true }),
      {
        initialProps: { sessionId: null as string | null },
      },
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
      useChatStore
        .getState()
        .enqueueMessage("__home_pending__", { text: "queued from Home" });
    });

    useChatSessionStore.setState((state) => ({
      sessions: [
        {
          id: "session-superseded-home",
          title: "Chat",
          providerId: "openai",
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
          messageCount: 0,
        },
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "session-superseded-home" });

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "session-superseded-home",
        "anthropic",
        "/tmp/project",
      );
    });

    const latestConfig = applyLatestSessionConfig({
      sessionId: "session-superseded-home",
      providerId: "anthropic",
      workingDir: "/tmp/other-project",
      modelId: "claude-sonnet-4",
    });

    firstPrepare.resolve();

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "session-superseded-home",
        "anthropic",
        "/tmp/other-project",
      );
    });
    await expect(latestConfig).resolves.toEqual({ applied: true });

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession[
          "session-superseded-home"
        ],
      ).toEqual({ text: "queued from Home" });
    });
    expect(
      useChatStore.getState().queuedMessageBySession.__home_pending__,
    ).toBeUndefined();
    expect(
      window.localStorage.getItem("goose:preferredModelsByAgent"),
    ).toBeNull();
  });

  it("rolls back and shows an error when ACP rejects a pending Home model", async () => {
    mockAcpSetModel.mockRejectedValueOnce(new Error("set model failed"));

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useChatSessionController({ sessionId, isHomeSession: true }),
      {
        initialProps: { sessionId: null as string | null },
      },
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    expect(
      window.localStorage.getItem("goose:preferredModelsByAgent"),
    ).toBeNull();

    useChatSessionStore.setState((state) => ({
      sessions: [
        {
          id: "session-3",
          title: "Chat",
          providerId: "openai",
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
          messageCount: 0,
        },
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "session-3" });

    await waitFor(() => {
      expect(mockAcpSetModel).toHaveBeenCalledWith(
        "session-3",
        "claude-sonnet-4",
      );
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-3"),
      ).toMatchObject({
        providerId: "openai",
      });
    });

    expect(
      useChatSessionStore.getState().getSession("session-3"),
    ).not.toMatchObject({
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
    expect(
      window.localStorage.getItem("goose:preferredModelsByAgent"),
    ).toBeNull();
    expect(mockToastError).toHaveBeenCalledWith(
      "Could not switch to Claude Sonnet 4.",
    );
    expect(
      useChatSessionStore.getState().getModelSelectionIntent("session-3"),
    ).toBeUndefined();
  });

  it("catches provider-only Home sync failures after consuming pending state", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("prepare failed"));

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useChatSessionController({ sessionId, isHomeSession: true }),
      {
        initialProps: { sessionId: null as string | null },
      },
    );

    act(() => {
      result.current.handleProviderChange("anthropic");
    });

    useChatSessionStore.setState((state) => ({
      sessions: [
        {
          id: "session-4",
          title: "Chat",
          providerId: "openai",
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
          messageCount: 0,
        },
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "session-4" });

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "session-4",
        "anthropic",
        "/tmp/project",
      );
    });
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to sync pending Home state:",
        expect.any(Error),
      );
    });
    expect(
      useChatSessionStore.getState().getSession("session-4"),
    ).toMatchObject({
      providerId: "openai",
    });
    expect(
      useChatSessionStore.getState().getModelSelectionIntent("session-4"),
    ).toBeUndefined();

    consoleError.mockRestore();
  });
});
