import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { useChatStore } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { applyLatestSessionConfig } from "../../lib/sessionConfigRequests";
import type { ChatSendOptions } from "../../types";

const mockAcpPrepareSession = vi.fn();
const mockAcpSetModel = vi.fn();
const mockAcpSetSessionConfigOption = vi.fn();
const mockSetSelectedProvider = vi.fn();
const mockResolveSessionCwd = vi.fn();
const mockGooseDefaultsRead = vi.fn();
const mockGoosePreferencesRead = vi.fn();
const mockGoosePreferencesSave = vi.fn();
const mockToastError = vi.fn();
const mockUseChatSendMessage = vi.fn();
const mockUseChatSteerMessage = vi.fn();
const mockUseMessageQueue = vi.fn();
const mockPreSeedDraftAgent = vi.fn();
const mockDeletePersonaSource = vi.fn();
const mockUseChatRuntime = {
  chatState: "idle",
  activeRunId: null as string | null,
};
const mockPickerState = {
  pickerAgents: [{ id: "goose", label: "Goose" }],
  availableModels: [] as Array<{
    id: string;
    name: string;
    displayName?: string;
    providerId?: string;
    recommended?: boolean;
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
  acpSetSessionConfigOption: (...args: unknown[]) =>
    mockAcpSetSessionConfigOption(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseUnstableDefaultsRead: (...args: unknown[]) =>
        mockGooseDefaultsRead(...args),
      GooseUnstablePreferencesRead: (...args: unknown[]) =>
        mockGoosePreferencesRead(...args),
      GooseUnstablePreferencesSave: (...args: unknown[]) =>
        mockGoosePreferencesSave(...args),
    },
  }),
}));

vi.mock("../useChat", () => ({
  useChat: (
    _sessionId: string,
    _providerOverride?: string,
    _systemPromptOverride?: string,
    _personaInfo?: { id: string; name: string },
    options?: {
      ensurePrepared?: (personaId?: string) => Promise<boolean | undefined>;
      onMessageAccepted?: (sessionId: string) => void;
    },
  ) => {
    const optionsWithSessionId = { ...options, __sessionId: _sessionId };
    return {
      messages: [],
      chatState: mockUseChatRuntime.chatState,
      tokenState: null,
      sendMessage: (...args: unknown[]) =>
        mockUseChatSendMessage(optionsWithSessionId, ...args),
      steerMessage: (...args: unknown[]) => mockUseChatSteerMessage(...args),
      compactConversation: vi.fn(),
      stopStreaming: vi.fn(),
      streamingMessageId: null,
      activeRunId: mockUseChatRuntime.activeRunId,
    };
  },
}));

vi.mock("../useMessageQueue", () => ({
  useMessageQueue: (...args: unknown[]) => mockUseMessageQueue(...args),
}));

vi.mock("@/features/agents/lib/agentBuilderSession", () => ({
  preSeedDraftAgent: (...args: unknown[]) => mockPreSeedDraftAgent(...args),
}));

vi.mock("@/shared/api/agents", () => ({
  deletePersonaSource: (...args: unknown[]) => mockDeletePersonaSource(...args),
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

function patchReasoningEffort(sessionId: string, currentValue = "off") {
  useChatSessionStore.getState().patchSession(sessionId, {
    reasoningEffort: {
      configId: "thinking_effort",
      currentValue,
      options: [
        { id: "off", name: "Off" },
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
      ],
    },
  });
}

describe("useChatSessionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockUseChatSendMessage.mockImplementation(
      async (options?: {
        ensurePrepared?: (personaId?: string) => Promise<boolean | undefined>;
        onMessageAccepted?: (sessionId: string) => void;
        __sessionId?: string;
      }) => {
        await options?.ensurePrepared?.();
      },
    );
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: null,
      enqueue: vi.fn(),
      dismiss: vi.fn(),
    }));
    mockDeletePersonaSource.mockResolvedValue(undefined);
    useProviderCatalogStore.getState().reset();
    useProviderCatalogStore.getState().setEntries([
      {
        id: "goose",
        displayName: "Goose",
        category: "agent",
        description: "Goose",
        setupMethod: "none",
        group: "default",
      },
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
    mockAcpSetSessionConfigOption.mockResolvedValue(undefined);
    mockResolveSessionCwd.mockResolvedValue("/tmp/project");
    mockGooseDefaultsRead.mockResolvedValue({
      providerId: null,
      modelId: null,
    });
    mockGoosePreferencesRead.mockResolvedValue({ values: [] });
    mockGoosePreferencesSave.mockResolvedValue(undefined);
    mockPreSeedDraftAgent.mockResolvedValue({
      path: "/Users/x/.agents/agents/draft-from-chat.md",
      slug: "draft-from-chat",
    });
    mockPickerState.pickerAgents = [{ id: "goose", label: "Goose" }];
    mockPickerState.availableModels = [];
    mockPickerState.modelsLoading = false;
    mockPickerState.modelStatusMessage = null;
    mockUseChatRuntime.chatState = "idle";
    mockUseChatRuntime.activeRunId = null;

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

  it("keeps a queued message when steer is not accepted", async () => {
    const dismiss = vi.fn();
    mockUseChatSteerMessage.mockResolvedValue(false);
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: {
        text: "make an agent",
        sendOptions: {
          chips: [{ label: "agent-builder", type: "skill" }],
        },
      },
      enqueue: vi.fn(),
      dismiss,
    }));

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "missing-session" }),
    );

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.steerQueuedMessage();
    });

    expect(accepted).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("steers a draft message while the agent is responding", async () => {
    mockUseChatRuntime.chatState = "streaming";
    mockUseChatSteerMessage.mockResolvedValue(true);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.steerDraftMessage(
        "make it shorter",
        undefined,
        undefined,
        { displayText: "make it shorter" },
      );
    });

    expect(accepted).toBe(true);
    expect(mockUseChatSteerMessage).toHaveBeenCalledWith(
      "make it shorter",
      undefined,
      { displayText: "make it shorter" },
    );
  });

  it("offers steering for queued messages while the agent is responding without active run metadata", () => {
    mockUseChatRuntime.chatState = "streaming";
    mockUseChatRuntime.activeRunId = null;
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: { text: "a little shorter" },
      enqueue: vi.fn(),
      dismiss: vi.fn(),
    }));

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    expect(result.current.canSteerQueuedMessage).toBe(true);
  });

  it("handleCreatePersona calls the AppShell-provided callback", () => {
    const onCreatePersonaRequested = vi.fn();
    const { result } = renderHook(() =>
      useChatSessionController({
        sessionId: "session-1",
        onCreatePersonaRequested,
      }),
    );

    act(() => {
      result.current.handleCreatePersona();
    });

    expect(onCreatePersonaRequested).toHaveBeenCalled();
  });

  it("does not fall back to the persona editor without an AppShell callback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleCreatePersona();
    });

    expect(warn).toHaveBeenCalledWith(
      "Create-persona requested without an AppShell handler",
    );
    warn.mockRestore();
  });

  it("saves a changed reasoning effort as the default after a message is accepted", async () => {
    patchReasoningEffort("session-1");
    mockUseChatSendMessage.mockImplementationOnce(
      async (options?: {
        ensurePrepared?: () => Promise<boolean | undefined>;
        onMessageAccepted?: (sessionId: string) => void;
        __sessionId?: string;
      }) => {
        options?.onMessageAccepted?.(options.__sessionId ?? "session-1");
        await options?.ensurePrepared?.();
      },
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleReasoningEffortChange("high");
    });
    act(() => {
      result.current.handleSend("hello");
    });

    await waitFor(() => {
      expect(mockGoosePreferencesSave).toHaveBeenCalledWith({
        values: [{ key: "gooseThinkingEffort", value: "high" }],
      });
    });
    expect(mockAcpSetSessionConfigOption).toHaveBeenCalledWith(
      "session-1",
      "thinking_effort",
      "high",
    );
  });

  it("does not save a changed reasoning effort before the user sends", () => {
    patchReasoningEffort("session-1");

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleReasoningEffortChange("high");
    });

    expect(mockGoosePreferencesSave).not.toHaveBeenCalled();
  });

  it("keeps pending reasoning-effort defaults scoped to each chat", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Chat A",
          providerId: "openai",
          modelId: "gpt-5.4",
          modelName: "GPT-5.4",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
        {
          id: "session-2",
          title: "Chat B",
          providerId: "openai",
          modelId: "gpt-5.4",
          modelName: "GPT-5.4",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });
    patchReasoningEffort("session-1");
    patchReasoningEffort("session-2");
    mockUseChatSendMessage.mockImplementation(
      async (options?: {
        ensurePrepared?: () => Promise<boolean | undefined>;
        onMessageAccepted?: (sessionId: string) => void;
        __sessionId?: string;
      }) => {
        options?.onMessageAccepted?.(options.__sessionId ?? "session-1");
        await options?.ensurePrepared?.();
      },
    );

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useChatSessionController({ sessionId }),
      {
        initialProps: { sessionId: "session-1" },
      },
    );

    act(() => {
      result.current.handleReasoningEffortChange("high");
    });
    rerender({ sessionId: "session-2" });
    act(() => {
      result.current.handleReasoningEffortChange("low");
    });
    act(() => {
      result.current.handleSend("send from chat b");
    });

    await waitFor(() => {
      expect(mockGoosePreferencesSave).toHaveBeenCalledWith({
        values: [{ key: "gooseThinkingEffort", value: "low" }],
      });
    });

    rerender({ sessionId: "session-1" });
    act(() => {
      result.current.handleSend("send from chat a");
    });

    await waitFor(() => {
      expect(mockGoosePreferencesSave).toHaveBeenLastCalledWith({
        values: [{ key: "gooseThinkingEffort", value: "high" }],
      });
    });
  });

  it("handleSend in a builder session merges the builder assistant prompt", async () => {
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
          intent: "build-agent",
          targetAgentPath: "/Users/x/.agents/agents/draft-1.md",
          targetAgentSlug: "draft-1",
        },
      ],
    });
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleSend("hello", undefined, undefined, {
        assistantPrompt: "from another skill",
      });
    });

    await waitFor(() => {
      expect(mockUseChatSendMessage).toHaveBeenCalled();
    });
    const sendOptions = mockUseChatSendMessage.mock.calls.at(-1)?.[4] as
      | { assistantPrompt?: string }
      | undefined;
    expect(sendOptions?.assistantPrompt).toContain("agent-builder");
    expect(sendOptions?.assistantPrompt).toContain("draft-1.md");
    expect(sendOptions?.assistantPrompt).toMatch(/\n\nfrom another skill$/);
  });

  it("keeps the agent-builder skill visible in builder sessions", () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Chat",
          providerId: "openai",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
          intent: "build-agent",
          targetAgentPath: "/Users/x/.agents/agents/draft-1.md",
          targetAgentSlug: "draft-1",
        },
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    expect(result.current.selectedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "agent-builder" }),
      ]),
    );

    act(() => {
      result.current.handleSkillsChange([]);
    });

    expect(useChatStore.getState().skillDraftsBySession["session-1"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "agent-builder" }),
      ]),
    );
  });

  it("turns a normal chat into a builder session when agent-builder is invoked", async () => {
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.handleSend(
        "make an agent",
        undefined,
        undefined,
        {
          chips: [{ label: "agent-builder", type: "skill" }],
          assistantPrompt: "Use these skills for this request: agent-builder.",
        },
      );
    });

    expect(accepted).toBe(true);
    expect(mockPreSeedDraftAgent).toHaveBeenCalledWith("session-1");
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      intent: "build-agent",
      targetAgentPath: "/Users/x/.agents/agents/draft-from-chat.md",
      targetAgentSlug: "draft-from-chat",
    });
    const sendOptions = mockUseChatSendMessage.mock.calls.at(-1)?.[4] as
      | { assistantPrompt?: string }
      | undefined;
    expect(sendOptions?.assistantPrompt).toContain("agent-builder");
    expect(sendOptions?.assistantPrompt).toContain("draft-from-chat.md");
  });

  it("activates builder mode for a deferred persona send with the agent-builder chip", async () => {
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Planner",
          systemPrompt: "Plan clearly.",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    let accepted: boolean | undefined;
    await act(async () => {
      const sendResult = result.current.handleSend(
        "make an agent",
        "persona-1",
        undefined,
        {
          chips: [{ label: "agent-builder", type: "skill" }],
          assistantPrompt: "Use these skills for this request: agent-builder.",
        },
      );
      accepted = sendResult instanceof Promise ? await sendResult : sendResult;
    });

    expect(accepted).toBe(true);
    expect(mockPreSeedDraftAgent).toHaveBeenCalledWith("session-1");
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      personaId: "persona-1",
      intent: "build-agent",
      targetAgentPath: "/Users/x/.agents/agents/draft-from-chat.md",
    });
    const sendOptions = mockUseChatSendMessage.mock.calls.at(-1)?.[4] as
      | { assistantPrompt?: string }
      | undefined;
    expect(sendOptions?.assistantPrompt).toContain("draft-from-chat.md");
  });

  it("blocks deferred persona sends while read-only", async () => {
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Planner",
          systemPrompt: "Plan clearly.",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const { result, rerender } = renderHook(
      ({ readOnly }: { readOnly: boolean }) =>
        useChatSessionController({ sessionId: "session-1", readOnly }),
      {
        initialProps: { readOnly: false },
      },
    );

    let accepted: boolean | undefined;
    let sendResult!: boolean | Promise<boolean>;
    act(() => {
      sendResult = result.current.handleSend("plan", "persona-1");
      rerender({ readOnly: true });
    });

    await act(async () => {
      accepted = sendResult instanceof Promise ? await sendResult : sendResult;
    });

    expect(accepted).toBe(false);
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().draftsBySession["session-1"]).toBe("plan");
  });

  it("opens builder mode as soon as the agent-builder skill is selected", async () => {
    useChatStore.getState().setSkillDrafts("session-1", [
      {
        id: "global:/skills/agent-builder",
        name: "agent-builder",
      },
    ]);

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      expect(mockPreSeedDraftAgent).toHaveBeenCalledWith("session-1");
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        intent: "build-agent",
        targetAgentPath: "/Users/x/.agents/agents/draft-from-chat.md",
        targetAgentSlug: "draft-from-chat",
      });
    });
  });

  it("clears the bare agent-builder mention after opening builder mode", async () => {
    useChatStore.getState().setDraft("session-1", "@agent-builder");
    useChatStore.getState().setSkillDrafts("session-1", [
      {
        id: "global:/skills/agent-builder",
        name: "agent-builder",
      },
    ]);

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        intent: "build-agent",
      });
      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        undefined,
      );
    });
  });

  it("keeps agent-builder mention text when it includes instructions", async () => {
    useChatStore
      .getState()
      .setDraft("session-1", "@agent-builder make a reviewer");
    useChatStore.getState().setSkillDrafts("session-1", [
      {
        id: "global:/skills/agent-builder",
        name: "agent-builder",
      },
    ]);

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        intent: "build-agent",
      });
    });
    expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
      "@agent-builder make a reviewer",
    );
  });

  it("does not pre-seed repeatedly while typing with agent-builder selected", async () => {
    const pendingDraft = deferred<{ path: string; slug: string }>();
    mockPreSeedDraftAgent.mockReturnValueOnce(pendingDraft.promise);
    useChatStore.getState().setSkillDrafts("session-1", [
      {
        id: "global:/skills/agent-builder",
        name: "agent-builder",
      },
    ]);

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    act(() => {
      useChatStore.getState().setDraft("session-1", "a");
      useChatStore.getState().setDraft("session-1", "ab");
    });

    expect(mockPreSeedDraftAgent).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingDraft.resolve({
        path: "/Users/x/.agents/agents/draft-from-chat.md",
        slug: "draft-from-chat",
      });
      await pendingDraft.promise;
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        intent: "build-agent",
        targetAgentPath: "/Users/x/.agents/agents/draft-from-chat.md",
      });
    });
  });

  it("cancels a pending builder activation when the skill draft is cleared", async () => {
    const pendingDraft = deferred<{ path: string; slug: string }>();
    mockPreSeedDraftAgent.mockReturnValueOnce(pendingDraft.promise);
    useChatStore.getState().setSkillDrafts("session-1", [
      {
        id: "global:/skills/agent-builder",
        name: "agent-builder",
      },
    ]);

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    act(() => {
      useChatStore.getState().clearSkillDrafts("session-1");
    });

    await act(async () => {
      pendingDraft.resolve({
        path: "/Users/x/.agents/agents/draft-from-chat.md",
        slug: "draft-from-chat",
      });
      await pendingDraft.promise;
    });

    await waitFor(() => {
      expect(mockDeletePersonaSource).toHaveBeenCalledWith(
        "/Users/x/.agents/agents/draft-from-chat.md",
      );
    });
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).not.toMatchObject({
      intent: "build-agent",
    });
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

  it("preserves reasoning effort rehydrated during a model switch", async () => {
    patchReasoningEffort("session-1", "low");
    mockAcpSetModel.mockImplementationOnce(async () => {
      patchReasoningEffort("session-1", "high");
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    await waitFor(() => {
      expect(mockAcpSetModel).toHaveBeenCalledWith(
        "session-1",
        "claude-sonnet-4",
      );
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getModelSelectionIntent("session-1"),
      ).toBeUndefined();
    });
    expect(
      useChatSessionStore.getState().getSession("session-1")?.reasoningEffort,
    ).toMatchObject({
      configId: "thinking_effort",
      currentValue: "high",
    });
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

  it("applies a selected persona's resolved provider and model to an existing chat", async () => {
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Research Scout",
          systemPrompt: "Gather context.",
          provider: "goose",
          model: "goose-claude-opus-4-8",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    mockPickerState.availableModels = [
      {
        id: "goose-claude-opus-4-8",
        name: "goose-claude-opus-4-8",
        providerId: "goose",
      },
    ];

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePersonaChange("persona-1");
    });

    await waitFor(() => {
      expect(result.current.currentModelId).toBe("goose-claude-opus-4-8");
    });
    expect(result.current.currentModelProviderId).toBe("goose");
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      personaId: "persona-1",
      providerId: "goose",
      modelId: "goose-claude-opus-4-8",
      modelName: "goose-claude-opus-4-8",
    });
    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "session-1",
        "goose",
        "/tmp/project",
      );
      expect(mockAcpSetModel).toHaveBeenCalledWith(
        "session-1",
        "goose-claude-opus-4-8",
      );
    });
  });

  it("falls back when a selected persona's saved model is no longer available", async () => {
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Research Scout",
          systemPrompt: "Gather context.",
          provider: "goose",
          model: "goose-claude-fable-5",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    mockPickerState.availableModels = [
      {
        id: "goose-claude-opus-4-8",
        name: "goose-claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        providerId: "goose",
        recommended: true,
      },
    ];

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePersonaChange("persona-1");
    });

    await waitFor(() => {
      expect(result.current.currentModelId).toBe("goose-claude-opus-4-8");
    });
    expect(result.current.currentModelName).toBe("Claude Opus 4.8");
    await waitFor(() => {
      expect(mockAcpSetModel).toHaveBeenCalledWith(
        "session-1",
        "goose-claude-opus-4-8",
      );
    });
  });

  it("replaces a user-selected model highlight when selecting a persona with a configured model", async () => {
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Research Scout",
          systemPrompt: "Gather context.",
          provider: "goose",
          model: "goose-claude-opus-4-8",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    mockPickerState.availableModels = [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        providerId: "openai",
      },
      {
        id: "goose-claude-opus-4-8",
        name: "goose-claude-opus-4-8",
        providerId: "goose",
      },
    ];

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("gpt-5.4");
    });

    await waitFor(() => {
      expect(result.current.currentModelId).toBe("gpt-5.4");
    });

    act(() => {
      result.current.handlePersonaChange("persona-1");
    });

    await waitFor(() => {
      expect(result.current.currentModelId).toBe("goose-claude-opus-4-8");
    });
    expect(result.current.currentModelProviderId).toBe("goose");
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      personaId: "persona-1",
      providerId: "goose",
      modelId: "goose-claude-opus-4-8",
    });
  });

  it("does not apply a persona model when the persona provider cannot resolve", () => {
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Research Scout",
          systemPrompt: "Gather context.",
          provider: "missing-provider",
          model: "goose-claude-opus-4-8",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePersonaChange("persona-1");
    });

    expect(result.current.currentModelId).toBe("gpt-4o");
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      personaId: "persona-1",
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
    });
    expect(mockAcpSetModel).not.toHaveBeenCalled();
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

  it("queues Home attachments and migrates them when a real session becomes active", async () => {
    mockUseMessageQueue.mockImplementation((sessionId: string) => ({
      queuedMessage:
        useChatStore.getState().queuedMessageBySession[sessionId] ?? null,
      enqueue: (
        text: string,
        personaId?: string,
        attachments?: ChatAttachmentDraft[],
        sendOptions?: ChatSendOptions,
      ) =>
        useChatStore.getState().enqueueMessage(sessionId, {
          text,
          ...(personaId ? { personaId } : {}),
          ...(attachments ? { attachments } : {}),
          ...(sendOptions ? { sendOptions } : {}),
        }),
      dismiss: () => useChatStore.getState().dismissQueuedMessage(sessionId),
    }));
    const imageDraft = {
      id: "home-image",
      kind: "image" as const,
      name: "home.png",
      mimeType: "image/png",
      base64: "home-base64",
      previewUrl: "blob:home",
    };

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useChatSessionController({ sessionId, isHomeSession: true }),
      {
        initialProps: { sessionId: null as string | null },
      },
    );

    act(() => {
      result.current.handleSend("", undefined, [imageDraft]);
    });

    expect(
      useChatStore.getState().queuedMessageBySession.__home_pending__,
    ).toEqual({
      text: "",
      attachments: [imageDraft],
    });

    useChatSessionStore.setState((state) => ({
      sessions: [
        {
          id: "session-home-attachments",
          title: "Chat",
          providerId: "openai",
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
          messageCount: 0,
        },
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "session-home-attachments" });

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession[
          "session-home-attachments"
        ],
      ).toEqual({
        text: "",
        attachments: [imageDraft],
      });
    });
    expect(
      useChatStore.getState().queuedMessageBySession.__home_pending__,
    ).toBeUndefined();
  });

  it("moves pending Home queued messages when preparation is superseded", async () => {
    const firstPrepare = deferred();
    mockAcpPrepareSession.mockReturnValueOnce(firstPrepare.promise);
    const queuedImageAttachment = {
      id: "queued-image",
      kind: "image" as const,
      name: "queued.png",
      path: "/tmp/queued.png",
      mimeType: "image/png",
      base64: "queued-base64",
      previewUrl: "asset:///tmp/queued.png",
    };

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useChatSessionController({ sessionId, isHomeSession: true }),
      {
        initialProps: { sessionId: null as string | null },
      },
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
      useChatStore.getState().enqueueMessage("__home_pending__", {
        text: "queued from Home",
        attachments: [queuedImageAttachment],
      });
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
      ).toEqual({
        text: "queued from Home",
        attachments: [queuedImageAttachment],
      });
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
