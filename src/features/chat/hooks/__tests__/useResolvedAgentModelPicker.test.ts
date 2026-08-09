import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  acquireSessionDispatchTarget,
  getSessionTargetSelection,
  resetSessionTargetCoordinatorsForTests,
  transitionSessionTarget,
} from "@/features/chat/lib/sessionTargetCoordinator";
import { useResolvedAgentModelPicker } from "../useResolvedAgentModelPicker";

const mockUseAgentModelPickerState = vi.fn();
const mockGetClient = vi.fn();
const mockToastError = vi.fn();
const mockPrepareSession = vi.fn();

function makeSession(
  executionTarget: ChatSession["executionTarget"],
  overrides: Partial<Omit<ChatSession, "executionTarget">> = {},
): ChatSession {
  return {
    id: "session-1",
    title: "Chat",
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
    messageCount: 0,
    ...overrides,
    ...(executionTarget ? { executionTarget } : {}),
  };
}

type ModelPickerOptions = Parameters<typeof useResolvedAgentModelPicker>[0];

function renderModelPicker(overrides: Partial<ModelPickerOptions> = {}) {
  const options: ModelPickerOptions = {
    providers: [{ id: "goose", label: "Goose" }],
    selectedProvider: "goose",
    sessionId: "session-1",
    sessionHasStarted: false,
    session: makeSession({ harnessId: "goose" }),
    pendingModelSelection: undefined,
    setPendingExecutionTarget: vi.fn(),
    setPendingModelSelection: vi.fn(),
    setGlobalSelectedProvider: vi.fn(),
    prepareSelectedProvider: vi.fn().mockResolvedValue(true),
    applySessionModelSelection: vi.fn().mockResolvedValue(true),
    ...overrides,
  };

  return renderHook(() => useResolvedAgentModelPicker(options));
}

vi.mock("../useAgentModelPickerState", () => ({
  useAgentModelPickerState: (args: unknown) => ({
    getModelsForAgent: () => [],
    isModelInventoryAuthoritative: () => false,
    ...mockUseAgentModelPickerState(args),
  }),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: (...args: unknown[]) => mockGetClient(...args),
}));

vi.mock("@/shared/api/acp", () => ({
  acpPrepareSession: (...args: unknown[]) => mockPrepareSession(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

describe("useResolvedAgentModelPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepareSession.mockResolvedValue(undefined);
    resetSessionTargetCoordinatorsForTests();
    window.localStorage.clear();
    useProviderCatalogStore.getState().reset();
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
    useChatStore.setState({ messagesBySession: {} });
    useProviderCatalogStore.getState().setEntries([
      {
        id: "codex-acp",
        displayName: "Codex CLI",
        category: "agent",
        description: "Codex CLI",
        setupMethod: "cli_auth",
        group: "default",
        aliases: ["codex-acp", "codex_cli", "codex"],
      },
      {
        id: "claude-acp",
        displayName: "Claude Code",
        category: "agent",
        description: "Claude Code",
        setupMethod: "cli_auth",
        group: "default",
        aliases: ["claude-acp", "claude_code", "claude"],
      },
      {
        id: "openai",
        displayName: "OpenAI",
        category: "model",
        description: "OpenAI",
        setupMethod: "single_api_key",
        group: "default",
      },
    ]);

    mockGetClient.mockResolvedValue({
      goose: {
        GooseUnstableDefaultsRead: vi.fn().mockResolvedValue({
          providerId: null,
          modelId: null,
        }),
      },
    });
    mockUseAgentModelPickerState.mockImplementation(
      ({
        onProviderSelected,
      }: {
        onProviderSelected: (providerId: string) => void;
      }) => ({
        pickerAgents: [
          { id: "goose", label: "Goose" },
          { id: "codex-acp", label: "Codex" },
        ],
        availableModels: [],
        modelsLoading: false,
        modelStatusMessage: null,
        handleProviderChange: (providerId: string) =>
          onProviderSelected(providerId),
        handleModelChange: vi.fn(),
      }),
    );
  });

  it("runs the real model picker apply behind dispatch and publishes B after preparation", async () => {
    const executionTarget = {
      harnessId: "goose" as const,
      modelProviderId: "openai",
      modelId: "current",
      modelName: "Current",
    };
    const nextTarget = {
      harnessId: "goose" as const,
      modelProviderId: "openai",
      modelId: "next",
      modelName: "Next",
    };
    const session = makeSession(executionTarget);
    useChatSessionStore.setState({ sessions: [session] });
    const lease = acquireSessionDispatchTarget("session-1");
    const applySessionModelSelection = vi.fn(
      async (_providerId: string, _selection: unknown, requestId: string) =>
        (
          await transitionSessionTarget({
            sessionId: "session-1",
            target: nextTarget,
            workingDir: "/w",
            requestId,
          })
        ).applied,
    );
    mockUseAgentModelPickerState.mockImplementation(({ onModelSelected }) => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [{ id: "next", name: "Next", providerId: "openai" }],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: () =>
        onModelSelected?.({ id: "next", name: "Next", providerId: "openai" }),
    }));

    const { result } = renderModelPicker({
      selectedProvider: "openai",
      session,
      applySessionModelSelection,
    });
    act(() => result.current.handleModelChange("next"));
    await waitFor(() =>
      expect(applySessionModelSelection).toHaveBeenCalledOnce(),
    );
    expect(mockPrepareSession).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.executionTarget,
    ).toEqual(executionTarget);

    lease.release?.();
    await waitFor(() =>
      expect(
        useChatSessionStore.getState().getSession("session-1")?.executionTarget,
      ).toEqual(nextTarget),
    );
    expect(mockPrepareSession).toHaveBeenCalledOnce();
    expect(mockPrepareSession).toHaveBeenCalledWith(
      "session-1",
      "openai",
      "/w",
      expect.objectContaining({ modelId: "next" }),
    );
  });

  it("keeps a model picker request current while dispatch delays its backend apply", async () => {
    const executionTarget = {
      harnessId: "goose" as const,
      modelProviderId: "openai",
      modelId: "current",
      modelName: "Current",
    };
    const session = makeSession(executionTarget);
    useChatSessionStore.setState({ sessions: [session] });
    const lease = acquireSessionDispatchTarget("session-1");
    let finishApply!: (value: boolean) => void;
    const applySessionModelSelection = vi.fn(
      (
        _providerId: string,
        _selection: unknown,
        _requestId: string,
      ): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          finishApply = resolve;
        }),
    );
    mockUseAgentModelPickerState.mockImplementation(({ onModelSelected }) => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [{ id: "next", name: "Next", providerId: "openai" }],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: () =>
        onModelSelected?.({ id: "next", name: "Next", providerId: "openai" }),
    }));

    const { result } = renderModelPicker({
      selectedProvider: "openai",
      session,
      applySessionModelSelection,
    });
    act(() => result.current.handleModelChange("next"));

    await waitFor(() =>
      expect(applySessionModelSelection).toHaveBeenCalledOnce(),
    );
    const requestId = applySessionModelSelection.mock.calls[0]?.[2];
    expect(requestId).toBeTruthy();
    expect(getSessionTargetSelection("session-1")?.operationId).toBe(requestId);
    expect(
      useChatSessionStore.getState().getSession("session-1")?.executionTarget,
    ).toEqual(executionTarget);

    lease.release?.();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.executionTarget,
    ).toEqual(executionTarget);
    finishApply(true);
    await waitFor(() =>
      expect(getSessionTargetSelection("session-1")).toBeUndefined(),
    );
  });

  it("keeps a provider picker request current while dispatch delays its backend apply", async () => {
    const executionTarget = {
      harnessId: "goose" as const,
      modelProviderId: "openai",
      modelId: "current",
      modelName: "Current",
    };
    const session = makeSession(executionTarget);
    useChatSessionStore.setState({ sessions: [session] });
    const lease = acquireSessionDispatchTarget("session-1");
    let finishPrepare!: (value: boolean) => void;
    const prepareSelectedProvider = vi.fn(
      (
        _providerId: string,
        _options?: { requestId?: string },
      ): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          finishPrepare = resolve;
        }),
    );

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      session,
      prepareSelectedProvider,
    });
    act(() => result.current.handleProviderChange("claude-acp"));

    await waitFor(() => expect(prepareSelectedProvider).toHaveBeenCalledOnce());
    const requestId = prepareSelectedProvider.mock.calls[0]?.[1]?.requestId;
    expect(requestId).toBeTruthy();
    expect(getSessionTargetSelection("session-1")?.operationId).toBe(requestId);
    expect(
      useChatSessionStore.getState().getSession("session-1")?.executionTarget,
    ).toEqual(executionTarget);

    lease.release?.();
    finishPrepare(true);
    await waitFor(() =>
      expect(getSessionTargetSelection("session-1")).toBeUndefined(),
    );
  });

  it("selects the saved model when switching back to an agent", () => {
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        "codex-acp": {
          modelId: "gpt-5.4-mini",
          modelName: "GPT-5.4 mini",
          providerId: "codex-acp",
        },
      }),
    );

    const setPendingExecutionTarget = vi.fn();
    const setPendingModelSelection = vi.fn();
    const setGlobalSelectedProvider = vi.fn();

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "codex-acp", label: "Codex" },
      ],
      sessionId: null,
      session: undefined,
      setPendingExecutionTarget,
      setPendingModelSelection,
      setGlobalSelectedProvider,
    });

    act(() => {
      result.current.handleProviderChange("codex-acp");
    });

    expect(setGlobalSelectedProvider).toHaveBeenCalledWith("codex-acp");
    expect(setPendingExecutionTarget).toHaveBeenCalledWith({
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "gpt-5.4-mini",
      modelName: "GPT-5.4 mini",
    });
    expect(setPendingModelSelection).toHaveBeenCalledWith({
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      modelProviderId: "codex-acp",
      source: "explicit",
    });
  });

  it("keeps a pending draft harness change local until ACP creates the session", () => {
    const prepareSelectedProvider = vi.fn();
    useChatSessionStore.getState().createDraftSession({
      workingDir: "/tmp/project",
      executionTarget: { harnessId: "goose" },
    });
    const session = useChatSessionStore.getState().sessions[0];

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "codex-acp", label: "Codex" },
      ],
      sessionId: session.id,
      session,
      prepareSelectedProvider,
    });

    act(() => result.current.handleProviderChange("codex-acp"));

    expect(prepareSelectedProvider).not.toHaveBeenCalled();
    expect(useChatSessionStore.getState().getSession(session.id)).toMatchObject(
      {
        creationState: "pending",
        executionTarget: { harnessId: "codex-acp" },
      },
    );
  });

  it("routes explicit concrete model providers through the Goose harness", () => {
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

    const setPendingExecutionTarget = vi.fn();
    const setPendingModelSelection = vi.fn();
    const setGlobalSelectedProvider = vi.fn();

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "openai", label: "OpenAI" },
      ],
      selectedProvider: "anthropic",
      sessionId: null,
      session: undefined,
      setPendingExecutionTarget,
      setPendingModelSelection,
      setGlobalSelectedProvider,
    });

    act(() => {
      result.current.handleProviderChange("openai");
    });

    expect(setGlobalSelectedProvider).toHaveBeenCalledWith("goose");
    expect(setPendingExecutionTarget).toHaveBeenCalledWith({
      harnessId: "goose",
      modelProviderId: "openai",
    });
    expect(setPendingModelSelection).toHaveBeenCalledWith(undefined);
  });

  it("uses a compatible available model when Goose fallback models do not match a concrete provider", () => {
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

    mockUseAgentModelPickerState.mockImplementation(
      ({
        onProviderSelected,
      }: {
        onProviderSelected: (providerId: string) => void;
      }) => ({
        pickerAgents: [
          { id: "goose", label: "Goose" },
          { id: "openai", label: "OpenAI" },
        ],
        availableModels: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            providerId: "openai",
          },
          {
            id: "claude-sonnet-4",
            name: "Claude Sonnet 4",
            providerId: "anthropic",
          },
        ],
        modelsLoading: false,
        modelStatusMessage: null,
        handleProviderChange: (providerId: string) =>
          onProviderSelected(providerId),
        handleModelChange: vi.fn(),
      }),
    );

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "openai", label: "OpenAI" },
      ],
      selectedProvider: "openai",
      sessionId: null,
      session: undefined,
    });

    expect(result.current.effectiveModelSelection).toEqual({
      id: "gpt-5.4",
      name: "GPT-5.4",
      modelProviderId: "openai",
      source: "explicit",
    });
  });

  it("does not synthesize a model for an existing provider-only session", () => {
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "stored-model",
          modelName: "Stored model",
          providerId: "openai",
        },
      }),
    );
    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [
        {
          id: "recommended-model",
          name: "Recommended model",
          providerId: "openai",
          recommended: true,
        },
      ],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "openai", label: "OpenAI" },
      ],
      selectedProvider: "openai",
      session: makeSession({
        harnessId: "goose",
        modelProviderId: "openai",
      }),
    });

    expect(result.current.effectiveModelSelection).toBeNull();
  });

  it("uses the recommended agent harness model when no saved model exists", () => {
    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [
        { id: "goose", label: "Goose" },
        { id: "codex-acp", label: "Codex" },
      ],
      availableModels: [
        {
          id: "gpt-5.4-mini",
          name: "GPT Mini 5.4",
          providerId: "codex-acp",
        },
        {
          id: "gpt-5.5",
          name: "GPT 5.5",
          providerId: "codex-acp",
          recommended: true,
        },
      ],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "codex-acp", label: "Codex" },
      ],
      selectedProvider: "codex-acp",
      sessionId: null,
      session: undefined,
    });

    expect(result.current.effectiveModelSelection).toEqual({
      id: "gpt-5.5",
      name: "GPT 5.5",
      modelProviderId: "codex-acp",
      source: "default",
    });
  });

  it("does not show a fallback model for an unresolved existing ACP session", () => {
    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [
        {
          id: "gpt-5.5",
          name: "GPT 5.5",
          providerId: "openai",
          recommended: true,
        },
      ],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const session: ChatSession = {
      id: "session-1",
      title: "Existing chat",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
      messageCount: 1,
    };
    const { result } = renderModelPicker({
      sessionId: session.id,
      sessionHasStarted: true,
      session,
    });

    expect(result.current.effectiveModelSelection).toBeNull();
  });

  it("resolves a Goose session model to its concrete provider row", () => {
    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [
        {
          id: "goose-gpt-5-6-sol",
          name: "GPT-5.6 Sol",
          providerId: "databricks_v2",
          recommended: true,
        },
      ],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const { result } = renderModelPicker({
      session: makeSession({
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-6-sol",
        modelName: "GPT-5.6 Sol",
      }),
    });

    expect(result.current.effectiveModelSelection).toEqual({
      id: "goose-gpt-5-6-sol",
      name: "GPT-5.6 Sol",
      modelProviderId: "databricks_v2",
      source: "explicit",
    });
  });

  it("does not use the latest preference to rewrite a provider-qualified Goose session", () => {
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "llama3.2",
          modelName: "llama3.2",
          providerId: "custom_ollama",
        },
      }),
    );
    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [
        {
          id: "llama3.2",
          name: "llama3.2",
          providerId: "ollama",
        },
        {
          id: "llama3.2",
          name: "llama3.2",
          providerId: "custom_ollama",
        },
      ],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const { result } = renderModelPicker({
      session: makeSession({
        harnessId: "goose",
        modelProviderId: "ollama",
        modelId: "llama3.2",
        modelName: "llama3.2",
      }),
    });

    expect(result.current.effectiveModelSelection).toEqual({
      id: "llama3.2",
      name: "llama3.2",
      modelProviderId: "ollama",
      source: "explicit",
    });
  });

  it("does not rewrite a session from another provider's model row", () => {
    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [
        {
          id: "shared-model",
          name: "Other provider model",
          providerId: "anthropic",
        },
      ],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const { result } = renderModelPicker({
      sessionHasStarted: true,
      session: makeSession({
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "shared-model",
        modelName: "Selected model",
      }),
    });

    expect(result.current.effectiveModelSelection).toEqual({
      id: "shared-model",
      name: "Selected model",
      modelProviderId: "openai",
      source: "explicit",
    });
  });

  it("enforces concrete provider compatibility before catalog loads", () => {
    useProviderCatalogStore.getState().reset();
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

    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [],
      modelsLoading: true,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "openai", label: "OpenAI" },
      ],
      selectedProvider: "openai",
      session: makeSession({
        harnessId: "goose",
        modelProviderId: "openai",
      }),
    });

    expect(result.current.effectiveModelSelection).toBeNull();
  });

  it("preserves unresolved agent provider identity before catalog loads", async () => {
    useProviderCatalogStore.getState().reset();

    mockUseAgentModelPickerState.mockImplementation(
      ({
        onProviderSelected,
        onModelSelected,
      }: {
        onProviderSelected: (providerId: string) => void;
        onModelSelected?: (model: {
          id: string;
          name: string;
          displayName?: string;
          providerId?: string;
        }) => void;
      }) => ({
        pickerAgents: [
          { id: "goose", label: "Goose" },
          { id: "codex-acp", label: "Codex" },
        ],
        availableModels: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "codex-acp",
          },
        ],
        modelsLoading: false,
        modelStatusMessage: null,
        handleProviderChange: (providerId: string) =>
          onProviderSelected(providerId),
        handleModelChange: (modelId: string) =>
          onModelSelected?.({
            id: modelId,
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "codex-acp",
          }),
      }),
    );

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "codex-acp", label: "Codex" },
      ],
      selectedProvider: "codex-acp",
      session: makeSession({
        harnessId: "codex-acp",
        modelProviderId: "codex-acp",
        modelId: "current",
        modelName: "current",
      }),
    });

    act(() => {
      result.current.handleModelChange("gpt-5.4");
    });

    await waitFor(() => {
      expect(
        JSON.parse(
          localStorage.getItem("goose:preferredModelsByAgent") ?? "{}",
        ),
      ).toEqual({
        "codex-acp": {
          modelId: "gpt-5.4",
          modelName: "GPT-5.4",
          providerId: "codex-acp",
        },
      });
    });
  });

  it("routes unresolved model provider identity through Goose before catalog loads", async () => {
    useProviderCatalogStore.getState().reset();

    mockUseAgentModelPickerState.mockImplementation(
      ({
        onModelSelected,
      }: {
        onModelSelected?: (model: {
          id: string;
          name: string;
          displayName?: string;
          providerId?: string;
        }) => void;
      }) => ({
        pickerAgents: [{ id: "goose", label: "Goose" }],
        availableModels: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "openai",
          },
        ],
        modelsLoading: false,
        modelStatusMessage: null,
        handleProviderChange: vi.fn(),
        handleModelChange: (modelId: string) =>
          onModelSelected?.({
            id: modelId,
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "openai",
          }),
      }),
    );

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "openai", label: "OpenAI" },
      ],
      selectedProvider: "openai",
      session: makeSession({
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "current",
        modelName: "current",
      }),
    });

    expect(result.current.selectedAgentId).toBe("goose");

    act(() => {
      result.current.handleModelChange("gpt-5.4");
    });

    await waitFor(() => {
      expect(
        JSON.parse(
          localStorage.getItem("goose:preferredModelsByAgent") ?? "{}",
        ),
      ).toEqual({
        goose: {
          modelId: "gpt-5.4",
          modelName: "GPT-5.4",
          providerId: "openai",
        },
      });
    });
  });

  it("keeps a model change in a started chat session-local", async () => {
    mockUseAgentModelPickerState.mockImplementation(({ onModelSelected }) => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          displayName: "GPT-5.4",
          providerId: "anthropic",
        },
      ],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: (modelId: string) =>
        onModelSelected?.({
          id: modelId,
          name: "GPT-5.4",
          displayName: "GPT-5.4",
          providerId: "anthropic",
        }),
    }));

    const applySessionModelSelection = vi.fn().mockResolvedValue(true);
    const setGlobalSelectedProvider = vi.fn();
    const { result } = renderModelPicker({
      selectedProvider: "openai",
      sessionHasStarted: true,
      session: makeSession(
        {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "current",
          modelName: "current",
        },
        { title: "Started chat", messageCount: 1 },
      ),
      setGlobalSelectedProvider,
      applySessionModelSelection,
    });

    act(() => result.current.handleModelChange("gpt-5.4"));

    await waitFor(() => {
      expect(applySessionModelSelection).toHaveBeenCalled();
    });
    expect(setGlobalSelectedProvider).not.toHaveBeenCalled();
    expect(localStorage.getItem("goose:preferredModelsByAgent")).toBeNull();
  });

  it("preserves the future-chat preference when a started-chat switch fails", async () => {
    const futurePreference = {
      modelId: "future-model",
      modelName: "Future model",
      providerId: "openai",
    };
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({ goose: futurePreference }),
    );
    const applySessionModelSelection = vi
      .fn()
      .mockRejectedValue(new Error("network down"));
    mockUseAgentModelPickerState.mockImplementation(({ onModelSelected }) => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [
        { id: "session-model", name: "Session model", providerId: "openai" },
      ],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: () =>
        onModelSelected?.({
          id: "session-model",
          name: "Session model",
          providerId: "openai",
        }),
    }));

    const { result } = renderModelPicker({
      selectedProvider: "openai",
      sessionHasStarted: true,
      session: makeSession(
        {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "current",
          modelName: "current",
        },
        { title: "Started chat", messageCount: 1 },
      ),
      applySessionModelSelection,
    });

    act(() => result.current.handleModelChange("session-model"));
    await waitFor(() => expect(applySessionModelSelection).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        JSON.parse(
          localStorage.getItem("goose:preferredModelsByAgent") ?? "{}",
        ),
      ).toEqual({ goose: futurePreference }),
    );
  });

  it("does not persist a superseded explicit model selection", async () => {
    const prepareSelectedProvider = vi.fn().mockResolvedValue(false);
    const applySessionModelSelection = vi.fn().mockResolvedValue(false);

    mockUseAgentModelPickerState.mockImplementation(
      ({
        onModelSelected,
      }: {
        onModelSelected?: (model: {
          id: string;
          name: string;
          displayName?: string;
          providerId?: string;
        }) => void;
      }) => ({
        pickerAgents: [{ id: "goose", label: "Goose" }],
        availableModels: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "openai",
          },
        ],
        modelsLoading: false,
        modelStatusMessage: null,
        handleProviderChange: vi.fn(),
        handleModelChange: (modelId: string) =>
          onModelSelected?.({
            id: modelId,
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "openai",
          }),
      }),
    );

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "openai", label: "OpenAI" },
      ],
      selectedProvider: "openai",
      session: makeSession({
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "current",
        modelName: "current",
      }),
      prepareSelectedProvider,
      applySessionModelSelection,
    });

    act(() => {
      result.current.handleModelChange("gpt-5.4");
    });

    await waitFor(() => {
      expect(applySessionModelSelection).toHaveBeenCalledWith(
        "openai",
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          modelProviderId: "openai",
          source: "explicit",
        },
        expect.any(String),
      );
    });
    expect(localStorage.getItem("goose:preferredModelsByAgent")).toBeNull();
  });

  it("preserves persisted Claude Code / Opus during empty models and catalog", () => {
    useProviderCatalogStore.getState().reset();

    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        "claude-acp": {
          modelId: "opus",
          modelName: "Claude Opus",
          providerId: "claude-acp",
        },
      }),
    );

    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [],
      modelsLoading: true,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const { result } = renderModelPicker({
      providers: [],
      selectedProvider: "claude-acp",
      sessionId: null,
      session: undefined,
    });

    expect(result.current.selectedAgentId).toBe("claude-acp");
    expect(result.current.effectiveModelSelection).toEqual({
      id: "opus",
      name: "Claude Opus",
      modelProviderId: "claude-acp",
      source: "explicit",
    });
  });

  it("preserves a stored model while the populated inventory is provisional", () => {
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "goose-claude-fable",
          modelName: "Claude Fable",
          providerId: "openai",
        },
      }),
    );
    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [
        {
          id: "goose-gpt-5-5",
          name: "GPT-5.5",
          providerId: "openai",
          recommended: true,
        },
      ],
      isModelInventoryAuthoritative: () => false,
      modelsLoading: true,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const { result } = renderModelPicker({
      selectedProvider: "openai",
      sessionId: null,
      session: undefined,
    });

    expect(result.current.effectiveModelSelection).toEqual({
      id: "goose-claude-fable",
      name: "Claude Fable",
      modelProviderId: "openai",
      source: "explicit",
    });
  });

  it("ignores a stored Goose model with an unknown provider identity", () => {
    useProviderCatalogStore.getState().mergeEntries([
      {
        id: "goose",
        displayName: "Goose",
        category: "agent",
        description: "Goose",
        setupMethod: "none",
        group: "default",
      },
    ]);
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "stale-model",
          modelName: "Stale model",
          providerId: "removed-provider",
        },
      }),
    );
    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [
        {
          id: "gpt-5.6",
          name: "GPT-5.6",
          providerId: "openai",
          recommended: true,
        },
      ],
      isModelInventoryAuthoritative: (providerId: string) =>
        providerId === "openai",
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const { result } = renderModelPicker({
      sessionId: null,
      session: undefined,
    });

    expect(result.current.effectiveModelSelection).toMatchObject({
      id: "gpt-5.6",
      modelProviderId: "openai",
    });
  });

  it("ignores a stored model missing from an authoritative populated inventory", () => {
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "retired-model",
          modelName: "Retired model",
          providerId: "openai",
        },
      }),
    );
    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [
        {
          id: "gpt-5.6",
          name: "GPT-5.6",
          providerId: "openai",
          recommended: true,
        },
      ],
      isModelInventoryAuthoritative: () => true,
      modelsLoading: true,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const { result } = renderModelPicker({
      selectedProvider: "openai",
      sessionId: null,
      session: undefined,
    });

    expect(result.current.effectiveModelSelection?.id).not.toBe(
      "retired-model",
    );
  });

  it("retains selection after the catalog validates the agent", () => {
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        "claude-acp": {
          modelId: "opus",
          modelName: "Claude Opus",
          providerId: "claude-acp",
        },
      }),
    );

    mockUseAgentModelPickerState.mockImplementation(() => ({
      pickerAgents: [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      availableModels: [
        { id: "opus", name: "Claude Opus", providerId: "claude-acp" },
        { id: "sonnet", name: "Claude Sonnet", providerId: "claude-acp" },
      ],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: vi.fn(),
    }));

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      selectedProvider: "claude-acp",
      sessionId: null,
      session: undefined,
    });

    expect(result.current.selectedAgentId).toBe("claude-acp");
    expect(result.current.effectiveModelSelection).toEqual({
      id: "opus",
      name: "Claude Opus",
      modelProviderId: "claude-acp",
      source: "explicit",
    });
  });

  it("recreates the session on the target provider when the current provider is unset", async () => {
    const recreateSessionForProvider = vi.fn().mockResolvedValue(undefined);
    const prepareSelectedProvider = vi
      .fn()
      .mockRejectedValue(new Error("Failed to get provider: Provider not set"));

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      prepareSelectedProvider,
      recreateSessionForProvider,
    });

    act(() => {
      result.current.handleProviderChange("claude-acp");
    });

    await waitFor(() => {
      expect(recreateSessionForProvider).toHaveBeenCalledWith(
        "claude-acp",
        null,
        expect.any(Function),
      );
    });
  });

  it("persists the explicit model choice after recovering from a stranded provider", async () => {
    // The in-place switch fails with "Provider not set" and the recovery
    // recreate wins (resolves true), so the recovered choice must stick — the
    // normal success-path setStoredModelPreference is skipped by the recovery
    // early-return, and without persisting here the next new session would fall
    // back to the old (dead) preference and re-enter the trap.
    const recreateSessionForProvider = vi.fn().mockResolvedValue(true);
    const applySessionModelSelection = vi
      .fn()
      .mockRejectedValue(new Error("Failed to get provider: Provider not set"));

    mockUseAgentModelPickerState.mockImplementation(
      ({
        onModelSelected,
      }: {
        onModelSelected?: (model: {
          id: string;
          name: string;
          displayName?: string;
          providerId?: string;
        }) => void;
      }) => ({
        pickerAgents: [{ id: "goose", label: "Goose" }],
        availableModels: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "openai",
          },
        ],
        modelsLoading: false,
        modelStatusMessage: null,
        handleProviderChange: vi.fn(),
        handleModelChange: (modelId: string) =>
          onModelSelected?.({
            id: modelId,
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "openai",
          }),
      }),
    );

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "openai", label: "OpenAI" },
      ],
      selectedProvider: "openai",
      session: makeSession({
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "current",
        modelName: "current",
      }),
      applySessionModelSelection,
      recreateSessionForProvider,
    });

    act(() => {
      result.current.handleModelChange("gpt-5.4");
    });

    await waitFor(() => {
      expect(recreateSessionForProvider).toHaveBeenCalledWith(
        "openai",
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          modelProviderId: "openai",
          source: "explicit",
        },
        expect.any(Function),
      );
    });

    await waitFor(() => {
      expect(
        JSON.parse(
          localStorage.getItem("goose:preferredModelsByAgent") ?? "{}",
        ),
      ).toEqual({
        goose: {
          modelId: "gpt-5.4",
          modelName: "GPT-5.4",
          providerId: "openai",
        },
      });
    });
  });

  it("keeps recovered model changes in a started chat session-local", async () => {
    const recreateSessionForProvider = vi.fn().mockResolvedValue(true);
    const applySessionModelSelection = vi
      .fn()
      .mockRejectedValue(new Error("Failed to get provider: Provider not set"));
    const previousPreference = {
      modelId: "new-chat-model",
      modelName: "New chat model",
      providerId: "openai",
    };
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({ goose: previousPreference }),
    );
    mockUseAgentModelPickerState.mockImplementation(({ onModelSelected }) => ({
      pickerAgents: [{ id: "goose", label: "Goose" }],
      availableModels: [
        { id: "gpt-5.4", name: "GPT-5.4", providerId: "openai" },
      ],
      modelsLoading: false,
      modelStatusMessage: null,
      handleProviderChange: vi.fn(),
      handleModelChange: () =>
        onModelSelected?.({
          id: "gpt-5.4",
          name: "GPT-5.4",
          providerId: "openai",
        }),
    }));

    const { result } = renderModelPicker({
      selectedProvider: "openai",
      sessionHasStarted: true,
      session: makeSession(
        {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "current",
          modelName: "current",
        },
        { title: "Started chat", messageCount: 1 },
      ),
      applySessionModelSelection,
      recreateSessionForProvider,
    });

    act(() => result.current.handleModelChange("gpt-5.4"));
    await waitFor(() => expect(recreateSessionForProvider).toHaveBeenCalled());
    expect(
      JSON.parse(localStorage.getItem("goose:preferredModelsByAgent") ?? "{}"),
    ).toEqual({ goose: previousPreference });
  });

  it("rolls back the optimistic model patch when stranded-provider recovery fails", async () => {
    const recreateSessionForProvider = vi
      .fn()
      .mockRejectedValue(new Error("create failed"));
    const applySessionModelSelection = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Failed to get provider: Provider not set"),
      )
      .mockResolvedValueOnce(true);
    const previousPreference = {
      modelId: "current",
      modelName: "current",
      providerId: "openai",
    };

    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({ goose: previousPreference }),
    );
    useChatSessionStore.setState({
      sessions: [
        makeSession({
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "current",
          modelName: "current",
        }),
      ],
      activeSessionId: "session-1",
    });

    mockUseAgentModelPickerState.mockImplementation(
      ({
        onModelSelected,
      }: {
        onModelSelected?: (model: {
          id: string;
          name: string;
          displayName?: string;
          providerId?: string;
        }) => void;
      }) => ({
        pickerAgents: [{ id: "goose", label: "Goose" }],
        availableModels: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "openai",
          },
        ],
        modelsLoading: false,
        modelStatusMessage: null,
        handleProviderChange: vi.fn(),
        handleModelChange: (modelId: string) =>
          onModelSelected?.({
            id: modelId,
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "openai",
          }),
      }),
    );

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "openai", label: "OpenAI" },
      ],
      selectedProvider: "openai",
      session: makeSession({
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "current",
        modelName: "current",
      }),
      applySessionModelSelection,
      recreateSessionForProvider,
    });

    act(() => {
      result.current.handleModelChange("gpt-5.4");
    });

    await waitFor(() => {
      expect(recreateSessionForProvider).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(applySessionModelSelection).toHaveBeenCalledTimes(2);
    });
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "current",
        modelName: "current",
      },
    });
    expect(
      JSON.parse(localStorage.getItem("goose:preferredModelsByAgent") ?? "{}"),
    ).toEqual({ goose: previousPreference });
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it("does not persist the recovered model choice when the recreate is superseded", async () => {
    // A superseded recreate resolves false: a newer pick owns navigation and
    // its own preference, so persisting the stale choice here would clobber it.
    const recreateSessionForProvider = vi.fn().mockResolvedValue(false);
    const applySessionModelSelection = vi
      .fn()
      .mockRejectedValue(new Error("Failed to get provider: Provider not set"));

    mockUseAgentModelPickerState.mockImplementation(
      ({
        onModelSelected,
      }: {
        onModelSelected?: (model: {
          id: string;
          name: string;
          displayName?: string;
          providerId?: string;
        }) => void;
      }) => ({
        pickerAgents: [{ id: "goose", label: "Goose" }],
        availableModels: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "openai",
          },
        ],
        modelsLoading: false,
        modelStatusMessage: null,
        handleProviderChange: vi.fn(),
        handleModelChange: (modelId: string) =>
          onModelSelected?.({
            id: modelId,
            name: "GPT-5.4",
            displayName: "GPT-5.4",
            providerId: "openai",
          }),
      }),
    );

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "openai", label: "OpenAI" },
      ],
      selectedProvider: "openai",
      session: makeSession({
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "current",
        modelName: "current",
      }),
      applySessionModelSelection,
      recreateSessionForProvider,
    });

    act(() => {
      result.current.handleModelChange("gpt-5.4");
    });

    await waitFor(() => {
      expect(recreateSessionForProvider).toHaveBeenCalledTimes(1);
    });
    // Let the recreate's false resolution settle before asserting nothing stuck.
    await Promise.resolve();
    expect(localStorage.getItem("goose:preferredModelsByAgent")).toBeNull();
  });

  it("passes a supersession predicate that goes stale when a newer provider is picked mid-recreate", async () => {
    // Hold the recreate open so a second provider pick can land while the
    // first recovery's createSession is still in flight.
    let releaseRecreate: () => void = () => {};
    const recreatePending = new Promise<void>((resolve) => {
      releaseRecreate = resolve;
    });
    const capturedPredicates: Array<() => boolean> = [];
    const recreateSessionForProvider = vi
      .fn()
      .mockImplementation(
        async (
          _providerId: string,
          _modelSelection: unknown,
          isSelectionCurrent?: () => boolean,
        ) => {
          if (isSelectionCurrent) {
            capturedPredicates.push(isSelectionCurrent);
          }
          await recreatePending;
        },
      );
    const prepareSelectedProvider = vi
      .fn()
      .mockRejectedValue(new Error("Failed to get provider: Provider not set"));

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
        { id: "codex-acp", label: "Codex" },
      ],
      prepareSelectedProvider,
      recreateSessionForProvider,
    });

    // First pick strands, kicking off a recreate that stays pending.
    act(() => {
      result.current.handleProviderChange("claude-acp");
    });

    await waitFor(() => {
      expect(capturedPredicates).toHaveLength(1);
    });
    // While that recreate is in flight the predicate still reports current.
    expect(capturedPredicates[0]()).toBe(true);

    // A second pick bumps the shared version counter, superseding the first.
    act(() => {
      result.current.handleProviderChange("codex-acp");
    });

    await waitFor(() => {
      expect(prepareSelectedProvider).toHaveBeenCalledTimes(2);
    });

    // The first recreate's predicate now reports stale, so the controller will
    // skip its activateSession; only the newer pick's recreate navigates.
    await waitFor(() => {
      expect(capturedPredicates[0]()).toBe(false);
    });

    releaseRecreate();
  });

  it("does not recreate the session for unrelated switch failures", async () => {
    const recreateSessionForProvider = vi.fn().mockResolvedValue(undefined);
    const prepareSelectedProvider = vi
      .fn()
      .mockRejectedValue(new Error("network down"));

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      prepareSelectedProvider,
      recreateSessionForProvider,
    });

    act(() => {
      result.current.handleProviderChange("claude-acp");
    });

    await waitFor(() => {
      expect(prepareSelectedProvider).toHaveBeenCalled();
    });
    expect(recreateSessionForProvider).not.toHaveBeenCalled();
  });

  it("recreates a session whose only local history is a failed user prompt", async () => {
    const recreateSessionForProvider = vi.fn().mockResolvedValue(true);
    const prepareSelectedProvider = vi
      .fn()
      .mockRejectedValue(new Error("Failed to get provider: Provider not set"));

    // The backend never committed a turn (messageCount stays 0); the user's
    // optimistically-added prompt and the send-failure bubble live only in
    // the local message store. This is the exact state the stranded-provider
    // trap produces — chat-first on the dead default provider — so recovery
    // must still recreate (the typed text is carried into the new composer)
    // rather than permanently stranding the session.
    useChatStore.setState({
      messagesBySession: {
        "session-1": [
          {
            id: "user-1",
            role: "user",
            created: 0,
            content: [{ type: "text", text: "hello" }],
          },
          {
            id: "system-1",
            role: "system",
            created: 1,
            content: [
              {
                type: "systemNotification",
                notificationType: "error",
                text: "Failed to get provider: Provider not set",
              },
            ],
          },
        ],
      },
    });

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      prepareSelectedProvider,
      recreateSessionForProvider,
    });

    act(() => {
      result.current.handleProviderChange("claude-acp");
    });

    await waitFor(() => {
      expect(recreateSessionForProvider).toHaveBeenCalledWith(
        "claude-acp",
        null,
        expect.any(Function),
      );
    });
  });

  it("does not recreate a session that has assistant history", async () => {
    const recreateSessionForProvider = vi.fn().mockResolvedValue(undefined);
    const prepareSelectedProvider = vi
      .fn()
      .mockRejectedValue(new Error("Failed to get provider: Provider not set"));

    // An assistant message means a provider was alive at some point and real
    // conversation happened. Never discard that — surface the switch failure
    // normally instead of recreating.
    useChatStore.setState({
      messagesBySession: {
        "session-1": [
          {
            id: "user-1",
            role: "user",
            created: 0,
            content: [{ type: "text", text: "hello" }],
          },
          {
            id: "assistant-1",
            role: "assistant",
            created: 1,
            content: [{ type: "text", text: "hi there" }],
          },
        ],
      },
    });

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      prepareSelectedProvider,
      recreateSessionForProvider,
    });

    act(() => {
      result.current.handleProviderChange("claude-acp");
    });

    await waitFor(() => {
      expect(prepareSelectedProvider).toHaveBeenCalled();
    });
    expect(recreateSessionForProvider).not.toHaveBeenCalled();
  });

  it("does not recreate a session with committed backend turns", async () => {
    const recreateSessionForProvider = vi.fn().mockResolvedValue(undefined);
    const prepareSelectedProvider = vi
      .fn()
      .mockRejectedValue(new Error("Failed to get provider: Provider not set"));

    // The recoverability guard reads the session store, not the hook prop.
    useChatSessionStore.setState({
      sessions: [makeSession({ harnessId: "goose" }, { messageCount: 4 })],
      activeSessionId: "session-1",
    });

    const { result } = renderModelPicker({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      session: makeSession({ harnessId: "goose" }, { messageCount: 4 }),
      prepareSelectedProvider,
      recreateSessionForProvider,
    });

    act(() => {
      result.current.handleProviderChange("claude-acp");
    });

    await waitFor(() => {
      expect(prepareSelectedProvider).toHaveBeenCalled();
    });
    expect(recreateSessionForProvider).not.toHaveBeenCalled();
  });
});
