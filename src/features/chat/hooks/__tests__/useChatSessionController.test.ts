import { getModelSelectionIntent } from "@/features/chat/model-selection/modelSelectionIntent";
import { REMOTE_SSH_SESSIONS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { setExperimentEnabled } from "@/features/experiments/experimentPreferences";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { emitSkillsChanged } from "@/features/skills/lib/skillsEvents";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { resetManagedModelSelectionRepairCacheForTests } from "@/features/providers/lib/managedModelSelectionRepair";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";
import type { Persona } from "@/shared/types/agents";
import {
  type ChatAttachmentDraft,
  createUserMessage,
} from "@/shared/types/messages";
import { useChatStore } from "../../stores/chatStore";
import {
  type ChatSession,
  useChatSessionStore,
} from "../../stores/chatSessionStore";
import {
  resetSessionTargetCoordinatorsForTests,
  transitionSessionTarget,
} from "../../lib/sessionTargetCoordinator";
import { workspaceAttachmentIdForPath } from "../../lib/workspaceAttachments";
import type { ChatSendOptions, ModelOption } from "../../types";

const mockAcpPrepareSession = vi.fn();
const mockAcpSetSessionConfigOption = vi.fn();
const mockSetSelectedProvider = vi.fn();
const mockResolveSessionCwd = vi.fn();
const mockGooseDefaultsRead = vi.fn();
const mockGoosePreferencesRead = vi.fn();
const mockGoosePreferencesSave = vi.fn();
const mockSupportedModelsList = vi.fn();
const mockToastError = vi.fn();
const mockUseChatSendMessage = vi.fn();
const mockUseChatSteerMessage = vi.fn();
const mockTrackChatMessageSent = vi.fn();
const mockTrackChatSessionStarted = vi.fn();
const mockUseChatHook = vi.fn();
const mockUseMessageQueue = vi.fn();
const mockPickerOpen = vi.fn();
const mockPreSeedDraftAgent = vi.fn();
const mockClearBuilderSessionState = vi.fn();
const mockMarkAgentBuilderSessionPreparationFailed = vi.fn();
const mockDeletePersonaSource = vi.fn();
const mockAcpCreateSession = vi.fn();
const mockAcpSessionArchive = vi.fn();
const mockEnsureRemoteHostConnected = vi.fn();
const mockUseChatRuntime = {
  chatState: "idle",
  activeRunId: null as string | null,
  isRunCancellationPending: false,
};
const mockListSkills = vi.fn();
const mockListBerdAppSkills = vi.fn();
const mockListGooseSourceSkills = vi.fn();
const mockLoadWorkspaceInstructionFiles = vi.fn();
const mockPickerState = {
  selectedAgentId: "goose",
  pickerAgents: [{ id: "goose", label: "Goose" }],
  availableModels: [] as ModelOption[],
  modelsByAgent: new Map<string, ModelOption[]>(),
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

class ImmediatelyResolved<T> implements PromiseLike<T> {
  constructor(private readonly value: T) {}

  // biome-ignore lint/suspicious/noThenProperty: this test helper intentionally models immediate PromiseLike resolution.
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): PromiseLike<TResult1 | TResult2> {
    if (!onfulfilled) {
      return Promise.resolve(this.value as unknown as TResult1);
    }
    return Promise.resolve(onfulfilled(this.value));
  }
}

function immediatelyResolved<T>(value: T): Promise<T> {
  return new ImmediatelyResolved(value) as unknown as Promise<T>;
}

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
  acpSetSessionConfigOption: (...args: unknown[]) =>
    mockAcpSetSessionConfigOption(...args),
  acpCreateSession: (...args: unknown[]) => mockAcpCreateSession(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

vi.mock("@/shared/api/acpConnection", () => {
  const getClient = async () => ({
    goose: {
      GooseUnstableDefaultsRead: (...args: unknown[]) =>
        mockGooseDefaultsRead(...args),
      GooseUnstablePreferencesRead: (...args: unknown[]) =>
        mockGoosePreferencesRead(...args),
      GooseUnstablePreferencesSave: (...args: unknown[]) =>
        mockGoosePreferencesSave(...args),
      GooseUnstableProvidersSupportedModelsList: (...args: unknown[]) =>
        mockSupportedModelsList(...args),
      GooseUnstableSessionArchive: (...args: unknown[]) =>
        mockAcpSessionArchive(...args),
    },
  });
  return { getClient, getBackendClient: getClient };
});

vi.mock("../useChat", () => ({
  useChat: (
    sessionId: string,
    providerOverride?: string,
    systemPromptOverride?: string,
    personaInfo?: { id: string; name: string },
    options?: {
      ensurePrepared?: (personaId?: string) => Promise<boolean | undefined>;
      onMessageAccepted?: (
        sessionId: string,
        text: string,
      ) => boolean | undefined;
    },
  ) => {
    mockUseChatHook(
      sessionId,
      providerOverride,
      systemPromptOverride,
      personaInfo,
    );
    const optionsWithSessionId = { ...options, __sessionId: sessionId };
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
      isRunCancellationPending: mockUseChatRuntime.isRunCancellationPending,
    };
  },
}));

vi.mock("../useMessageQueue", () => ({
  useMessageQueue: (...args: unknown[]) => mockUseMessageQueue(...args),
}));

vi.mock("../useAutoCompactPreferences", () => ({
  useAutoCompactPreferences: () => ({
    autoCompactEnabled: false,
    autoCompactThresholdPercent: 80,
    preferencesLoading: false,
    setAutoCompactEnabled: vi.fn(),
    setAutoCompactThresholdPercent: vi.fn(),
  }),
}));

vi.mock("@/features/agents/lib/agentBuilderSession", () => ({
  preSeedDraftAgent: (...args: unknown[]) => mockPreSeedDraftAgent(...args),
  clearBuilderSessionState: (...args: unknown[]) =>
    mockClearBuilderSessionState(...args),
  markAgentBuilderSessionPreparationFailed: (...args: unknown[]) =>
    mockMarkAgentBuilderSessionPreparationFailed(...args),
}));

vi.mock("@/shared/api/agents", () => ({
  deletePersonaSource: (...args: unknown[]) => mockDeletePersonaSource(...args),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listBerdAppSkills: (...args: unknown[]) => mockListBerdAppSkills(...args),
  listGooseSourceSkills: (...args: unknown[]) =>
    mockListGooseSourceSkills(...args),
  listSkills: (...args: unknown[]) => mockListSkills(...args),
}));

vi.mock("@/features/chat/api/workspaceContext", () => ({
  loadWorkspaceInstructionFiles: (...args: unknown[]) =>
    mockLoadWorkspaceInstructionFiles(...args),
}));

vi.mock("@/features/agents/hooks/useProviderSelection", () => ({
  useProviderSelection: () => ({
    providers: [
      { id: "goose", label: "Goose" },
      { id: "codex-acp", label: "Codex" },
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

vi.mock("../../lib/remoteSession", () => ({
  isRemoteSession: (
    session: { remoteHost?: string | null } | null | undefined,
  ) => Boolean(session?.remoteHost?.trim()),
  ensureRemoteHostConnected: (...args: unknown[]) =>
    mockEnsureRemoteHostConnected(...args),
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
    selectedAgentId: mockPickerState.selectedAgentId,
    pickerAgents: mockPickerState.pickerAgents,
    availableModels: mockPickerState.availableModels,
    getModelsForAgent: (agentId: string) =>
      mockPickerState.modelsByAgent.get(agentId) ??
      mockPickerState.availableModels,
    isModelInventoryAuthoritative: () => false,
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
    handlePickerOpen: () => mockPickerOpen(),
  }),
}));

// Wrappers are mocked so the tests can pin the fire points; CHAT_SOURCE_SURFACE
// and the rest of the module stay real.
vi.mock("@/features/chat/lib/chatTelemetry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/chat/lib/chatTelemetry")
  >()),
  trackChatMessageSent: (...args: unknown[]) =>
    mockTrackChatMessageSent(...args),
  trackChatSessionStarted: (...args: unknown[]) =>
    mockTrackChatSessionStarted(...args),
}));

import { CHAT_SOURCE_SURFACE } from "../../lib/chatTelemetry";
import { useChatSessionController } from "../useChatSessionController";

function latestMessageQueueArgs() {
  const call = mockUseMessageQueue.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call as [
    string,
    string,
    unknown,
    boolean | undefined,
    boolean | undefined,
  ];
}

function expectSessionPreparation({
  sessionId,
  modelProviderId,
  workingDir = "/tmp/project",
  modelId,
  forceConfigRefresh,
}: {
  sessionId: string;
  modelProviderId: string;
  workingDir?: string;
  modelId?: string;
  forceConfigRefresh?: boolean;
}) {
  expect(mockAcpPrepareSession).toHaveBeenCalledWith(
    sessionId,
    modelProviderId,
    workingDir,
    expect.objectContaining({
      ...(modelId ? { modelId } : {}),
      ...(forceConfigRefresh ? { forceConfigRefresh: true } : {}),
    }),
  );
}

function catalogSkill(name: string) {
  return {
    id: `project:/tmp/project/.agents/skills/${name}`,
    name,
    description: `${name} description`,
    instructions: "Full instructions are not part of the catalog.",
    path: `/tmp/project/.agents/skills/${name}`,
    fileLocation: `/tmp/project/.agents/skills/${name}/SKILL.md`,
    sourceKind: "project",
    sourceLabel: "project",
    projectLinks: [],
    readonly: false,
    color: null,
  };
}

function sessionFixture(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "Chat",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    messageCount: 0,
    ...overrides,
  };
}

function personaFixture(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "persona-1",
    displayName: "Research Scout",
    systemPrompt: "Gather context.",
    isBuiltin: false,
    writable: true,
    ...overrides,
  };
}

function singleWorkspaceSession(): ChatSession {
  return sessionFixture({
    executionTarget: {
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
    },
    workingDir: "/tmp/project",
    workspaceAttachments: [
      {
        id: workspaceAttachmentIdForPath("/tmp/project"),
        path: "/tmp/project",
        kind: "git-main-worktree",
        source: "inferred",
        branch: "main",
        usedByAgent: false,
      },
    ],
  });
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
  afterEach(cleanup);

  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    vi.clearAllMocks();
    delete modelFixtures["legacy-v1-model"];
    resetManagedModelSelectionRepairCacheForTests();
    useRuntimeConfigStore.setState({
      loaded: true,
      result: {
        status: "ready",
        source: "appDefault",
        config: DEFAULT_RUNTIME_CONFIG,
      },
      config: DEFAULT_RUNTIME_CONFIG,
    });
    window.localStorage.clear();
    setMultiWorkspaceEnabled(true);
    mockUseChatSendMessage.mockImplementation(
      async (options?: {
        ensurePrepared?: (personaId?: string) => Promise<boolean | undefined>;
        onMessageAccepted?: (
          sessionId: string,
          text: string,
        ) => boolean | undefined;
        __sessionId?: string;
      }) => {
        await options?.ensurePrepared?.();
        return true;
      },
    );
    mockUseMessageQueue.mockImplementation(
      (
        _sessionId: string,
        _chatState: string,
        sendMessage: (
          text: string,
          persona?: { id: string },
          attachments?: unknown[],
          sendOptions?: unknown,
        ) => boolean | Promise<boolean>,
      ) => ({
        queuedMessage: null,
        enqueue: (
          text: string,
          personaId?: string,
          attachments?: unknown[],
          sendOptions?: unknown,
          personaName?: string,
        ) => {
          const persona = personaId
            ? useAgentStore
                .getState()
                .personas.find((candidate) => candidate.id === personaId)
            : undefined;
          void sendMessage(
            text,
            personaId
              ? {
                  id: personaId,
                  ...((personaName ?? persona?.displayName) && {
                    name: personaName ?? persona?.displayName,
                  }),
                }
              : undefined,
            attachments,
            sendOptions,
          );
          return true;
        },
        dismiss: vi.fn(),
      }),
    );
    mockDeletePersonaSource.mockResolvedValue(undefined);
    mockListSkills
      .mockReset()
      .mockImplementation(() => immediatelyResolved([]));
    mockListBerdAppSkills
      .mockReset()
      .mockImplementation(() => immediatelyResolved([]));
    mockListGooseSourceSkills.mockReset().mockResolvedValue([]);
    mockLoadWorkspaceInstructionFiles.mockImplementation(() =>
      immediatelyResolved([]),
    );
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
      {
        id: "codex-acp",
        displayName: "Codex",
        category: "agent",
        description: "OpenAI's coding agent",
        setupMethod: "cli_auth",
        binaryName: "codex-acp",
        group: "default",
        aliases: ["codex-acp", "codex_cli", "codex-cli", "codex"],
      },
    ]);
    mockAcpPrepareSession.mockResolvedValue(undefined);
    mockAcpSetSessionConfigOption.mockResolvedValue(undefined);
    mockAcpCreateSession.mockResolvedValue({
      sessionId: "session-recovered",
      configOptionsSnapshot: undefined,
    });
    mockAcpSessionArchive.mockResolvedValue(undefined);
    mockResolveSessionCwd.mockResolvedValue("/tmp/project");
    mockGooseDefaultsRead.mockResolvedValue({
      providerId: null,
      modelId: null,
    });
    mockGoosePreferencesRead.mockResolvedValue({ values: [] });
    mockGoosePreferencesSave.mockResolvedValue(undefined);
    mockSupportedModelsList.mockResolvedValue({ models: [] });
    mockPreSeedDraftAgent.mockResolvedValue({
      path: "/Users/x/.agents/agents/draft-from-chat.md",
      slug: "draft-from-chat",
    });
    mockPickerState.selectedAgentId = "goose";
    mockPickerState.pickerAgents = [{ id: "goose", label: "Goose" }];
    mockPickerState.availableModels = [];
    mockPickerState.modelsByAgent.clear();
    mockPickerState.modelsLoading = false;
    mockPickerState.modelStatusMessage = null;
    mockUseChatRuntime.chatState = "idle";
    mockUseChatRuntime.activeRunId = null;
    mockUseChatRuntime.isRunCancellationPending = false;

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
      nonEmptyDraftSessionIds: new Set(),
      skillDraftsBySession: {},
      draftAttachmentsBySession: {},
      queuedMessageBySession: {},
      scrollTargetMessageBySession: {},
      loadingSessionIds: new Set(),
      activeSessionId: null,
      isConnected: true,
    });

    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
        }),
      ],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
  });

  it("offers worktree setup before the first message is sent", () => {
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          path: "/tmp/project.md",
          name: "Project",
          description: "",
          prompt: "",
          icon: "",
          color: "#22c55e",
          projectWorkspaces: [
            {
              id: "workspace-1",
              path: "/repo/project",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: false,
              repositoryPath: "/repo/project",
              startupMode: "worktree",
            },
          ],
          workingDirs: ["/repo/project"],
          useWorktrees: true,
          order: 0,
          archivedAt: null,
          artifact: null,
        },
      ],
      loading: false,
      activeProjectId: "project-1",
    });
    useChatSessionStore.getState().patchSession("session-1", {
      projectId: "project-1",
      workingDir: "/repo/project",
      workspaceAttachments: [],
    });
    useChatStore.setState({
      messagesBySession: {
        "session-1": [
          {
            id: "startup-system-message",
            role: "system",
            created: 0,
            content: [{ type: "text", text: "Session initialized" }],
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    expect(result.current.defaultWorkspaceSetup).toMatchObject({
      status: "choice",
      desired: [{ id: "workspace-1", startupMode: "worktree" }],
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
  });

  it("debounces draft store writes while composer text changes", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleDraftChange("h");
        result.current.handleDraftChange("hello");
      });

      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        undefined,
      );

      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        undefined,
      );

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        "hello",
      );

      act(() => {
        result.current.handleDraftChange("");
      });
      expect(useChatStore.getState().draftsBySession["session-1"]).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a pending draft store write on unmount", () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleDraftChange("unsaved draft");
      });
      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        undefined,
      );

      act(() => {
        unmount();
      });
      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        "unsaved draft",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore a debounced draft after an accepted send clears it", async () => {
    vi.useFakeTimers();
    try {
      mockUseChatSendMessage.mockImplementationOnce(
        async (options?: {
          ensurePrepared?: () => Promise<boolean | undefined>;
          onMessageAccepted?: (
            sessionId: string,
            text: string,
          ) => boolean | undefined;
          __sessionId?: string;
        }) => {
          options?.onMessageAccepted?.(
            options.__sessionId ?? "session-1",
            "hello",
          );
          await options?.ensurePrepared?.();
          return true;
        },
      );
      mockUseMessageQueue.mockImplementationOnce(
        (
          _sessionId: string,
          _chatState: string,
          sendMessage: (
            text: string,
            persona?: { id: string; name?: string },
            attachments?: unknown[],
            sendOptions?: unknown,
          ) => boolean | Promise<boolean>,
        ) => ({
          queuedMessage: null,
          enqueue: (
            text: string,
            personaId?: string,
            attachments?: unknown[],
            sendOptions?: unknown,
          ) =>
            sendMessage(
              text,
              personaId ? { id: personaId } : undefined,
              attachments,
              sendOptions,
            ),
          dismiss: vi.fn(),
        }),
      );
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleDraftChange("hello");
      });

      await act(async () => {
        await result.current.handleSend("hello");
      });

      expect(
        useChatStore.getState().draftsBySession["session-1"],
      ).toBeUndefined();

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(
        useChatStore.getState().draftsBySession["session-1"],
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts ordinary idle sends before chat completion", () => {
    const completion = deferred<void>();
    mockUseChatSendMessage.mockReturnValueOnce(completion.promise);
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    let sendResult!: ReturnType<typeof result.current.handleSend>;
    act(() => {
      sendResult = result.current.handleSend("hello");
    });

    expect(sendResult).toBe(true);
  });

  it("preserves a newer draft when an older send is accepted later", async () => {
    vi.useFakeTimers();
    try {
      let acceptCommittedMessage!: (text: string) => void;
      mockUseChatSendMessage.mockImplementationOnce(
        (options?: {
          onMessageAccepted?: (
            sessionId: string,
            text: string,
          ) => boolean | undefined;
          __sessionId?: string;
        }) => {
          acceptCommittedMessage = (text: string) => {
            const sessionId = options?.__sessionId ?? "session-1";
            const shouldClearDraft =
              options?.onMessageAccepted?.(sessionId, text) !== false;
            if (shouldClearDraft) {
              useChatStore.getState().clearDraft(sessionId);
            }
          };
        },
      );
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleDraftChange("first");
      });
      act(() => {
        result.current.handleSend("first");
      });
      act(() => {
        result.current.handleDraftChange("");
        result.current.handleDraftChange("second");
      });

      act(() => {
        acceptCommittedMessage("first");
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        "second",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an in-progress draft when a queued message drains", async () => {
    vi.useFakeTimers();
    try {
      let acceptCommittedMessage!: (text: string) => void;
      mockUseChatSendMessage.mockImplementationOnce(
        (options?: {
          onMessageAccepted?: (
            sessionId: string,
            text: string,
          ) => boolean | undefined;
          __sessionId?: string;
        }) => {
          acceptCommittedMessage = (text: string) => {
            const sessionId = options?.__sessionId ?? "session-1";
            const shouldClearDraft =
              options?.onMessageAccepted?.(sessionId, text) !== false;
            if (shouldClearDraft) {
              useChatStore.getState().clearDraft(sessionId);
            }
          };
        },
      );
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleDraftChange("message after the queue");
      });
      act(() => {
        result.current.handleSend("queued follow-up");
      });
      act(() => {
        acceptCommittedMessage("queued follow-up");
        vi.advanceTimersByTime(300);
      });

      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        "message after the queue",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a same-text draft pending when a matching queued message drains", async () => {
    vi.useFakeTimers();
    try {
      let acceptCommittedMessage!: (text: string) => void;
      mockUseChatSendMessage.mockImplementationOnce(
        (options?: {
          onMessageAccepted?: (
            sessionId: string,
            text: string,
          ) => boolean | undefined;
          __sessionId?: string;
        }) => {
          acceptCommittedMessage = (text: string) => {
            const sessionId = options?.__sessionId ?? "session-1";
            const shouldClearDraft =
              options?.onMessageAccepted?.(sessionId, text) !== false;
            if (shouldClearDraft) {
              useChatStore.getState().clearDraft(sessionId);
            }
          };
        },
      );
      mockUseChatRuntime.chatState = "streaming";
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleDraftChange("same text");
      });
      act(() => {
        result.current.handleSend("same text");
      });
      const [, , drainQueuedMessage] = latestMessageQueueArgs();
      act(() => {
        (drainQueuedMessage as (text: string) => void)("same text");
      });
      act(() => {
        acceptCommittedMessage("same text");
        vi.advanceTimersByTime(300);
      });

      expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
        "same text",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a debounced draft to the backend session id when a draft session is promoted", () => {
    vi.useFakeTimers();
    try {
      useChatSessionStore.setState({
        sessions: [
          sessionFixture({
            id: "draft-session",
            clientSessionId: "draft-session",
            executionTarget: {
              harnessId: "goose",
              modelProviderId: "openai",
            },
            projectId: "project-1",
            creationState: "pending",
          }),
        ],
      });

      const { result, rerender } = renderHook(
        ({ sessionId }: { sessionId: string }) =>
          useChatSessionController({ sessionId }),
        {
          initialProps: { sessionId: "draft-session" },
        },
      );

      act(() => {
        result.current.handleDraftChange("draft during promotion");
      });
      expect(
        useChatStore.getState().draftsBySession["draft-session"],
      ).toBeUndefined();

      act(() => {
        useChatStore
          .getState()
          .promoteSessionId("draft-session", "backend-session");
        useChatSessionStore
          .getState()
          .promoteDraftSession("draft-session", "backend-session");
      });
      rerender({ sessionId: "backend-session" });

      expect(useChatStore.getState().draftsBySession["backend-session"]).toBe(
        "draft during promotion",
      );
      expect(
        useChatStore.getState().draftsBySession["draft-session"],
      ).toBeUndefined();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(useChatStore.getState().draftsBySession["backend-session"]).toBe(
        "draft during promotion",
      );
      expect(
        useChatStore.getState().draftsBySession["draft-session"],
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a send into the queue while a draft session is pending", () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          id: "draft-session",
          clientSessionId: "draft-session",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          creationState: "pending",
        }),
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "draft-session" }),
    );

    act(() => {
      expect(result.current.handleSend("send when ready")).toBe(true);
    });
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"]?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      payload: { text: "send when ready" },
    });
  });

  it("preserves a newer draft when a pending send drains after promotion", () => {
    vi.useFakeTimers();
    try {
      let acceptCommittedMessage!: (sessionId: string, text: string) => void;
      mockUseChatSendMessage.mockImplementationOnce(
        (options?: {
          onMessageAccepted?: (
            sessionId: string,
            text: string,
          ) => boolean | undefined;
        }) => {
          acceptCommittedMessage = (sessionId, text) => {
            if (options?.onMessageAccepted?.(sessionId, text) !== false) {
              useChatStore.getState().clearDraft(sessionId);
            }
          };
        },
      );
      useChatSessionStore.setState({
        sessions: [
          sessionFixture({
            id: "draft-session",
            clientSessionId: "draft-session",
            executionTarget: {
              harnessId: "goose",
              modelProviderId: "openai",
            },
            creationState: "pending",
          }),
        ],
      });

      const { result, rerender } = renderHook(
        ({ sessionId }: { sessionId: string }) =>
          useChatSessionController({ sessionId }),
        { initialProps: { sessionId: "draft-session" } },
      );

      act(() => {
        expect(result.current.handleSend("send when ready")).toBe(true);
        result.current.handleDraftChange("newer draft");
        useChatStore
          .getState()
          .promoteSessionId("draft-session", "backend-session");
        useChatSessionStore
          .getState()
          .promoteDraftSession("draft-session", "backend-session");
      });
      rerender({ sessionId: "backend-session" });
      const [, , drainQueuedMessage] = latestMessageQueueArgs();
      act(() => {
        (drainQueuedMessage as (text: string) => void)("send when ready");
      });

      act(() => {
        acceptCommittedMessage("backend-session", "send when ready");
        vi.advanceTimersByTime(300);
      });

      expect(useChatStore.getState().draftsBySession["backend-session"]).toBe(
        "newer draft",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues an agent-builder send during session creation and prepares it after promotion", async () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          id: "draft-session",
          clientSessionId: "draft-session",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          creationState: "pending",
        }),
      ],
    });

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useChatSessionController({ sessionId }),
      { initialProps: { sessionId: "draft-session" } },
    );

    act(() => {
      expect(
        result.current.handleSend("make a reviewer", undefined, undefined, {
          chips: [{ label: "agent-builder", type: "skill" }],
          assistantPrompt: "Use agent-builder.",
        }),
      ).toBe(true);
    });

    expect(mockPreSeedDraftAgent).not.toHaveBeenCalled();
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"]?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      payload: {
        text: "make a reviewer",
        sendOptions: {
          chips: [{ label: "agent-builder", type: "skill" }],
        },
      },
    });

    act(() => {
      useChatStore
        .getState()
        .promoteSessionId("draft-session", "backend-session");
      useChatSessionStore
        .getState()
        .promoteDraftSession("draft-session", "backend-session");
    });
    rerender({ sessionId: "backend-session" });

    await waitFor(() => {
      expect(mockPreSeedDraftAgent).toHaveBeenCalledWith("backend-session");
    });
  });

  it("discards in-flight Agent Builder preparation when its queue record is removed", async () => {
    const pendingDraft = deferred<{ path: string; slug: string }>();
    mockPreSeedDraftAgent.mockReturnValueOnce(pendingDraft.promise);
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "make a reviewer",
      sendOptions: {
        chips: [{ label: "agent-builder", type: "skill" }],
      },
    });
    const queuedRecord =
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0];

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      expect(mockPreSeedDraftAgent).toHaveBeenCalledWith("session-1");
    });
    act(() => {
      useChatStore
        .getState()
        .dismissQueuedMessage("session-1", queuedRecord?.recordId);
    });
    await act(async () => {
      pendingDraft.resolve({
        path: "/Users/x/.agents/agents/removed-queue-record.md",
        slug: "removed-queue-record",
      });
      await pendingDraft.promise;
    });

    await waitFor(() => {
      expect(mockDeletePersonaSource).toHaveBeenCalledWith(
        "/Users/x/.agents/agents/removed-queue-record.md",
      );
    });
    const session = useChatSessionStore.getState().getSession("session-1");
    expect(session?.intent).toBeUndefined();
    expect(session?.targetAgentPath).toBeUndefined();
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();
  });

  it("marks queued Agent Builder preparation as failed without dropping its send", async () => {
    mockPreSeedDraftAgent.mockRejectedValueOnce(
      new Error("draft creation failed"),
    );
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "make a reviewer",
      sendOptions: {
        chips: [{ label: "agent-builder", type: "skill" }],
      },
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      expect(mockMarkAgentBuilderSessionPreparationFailed).toHaveBeenCalledWith(
        "session-1",
      );
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toHaveLength(1);
  });

  it("defers an eagerly selected Agent Builder draft until promotion", async () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          id: "draft-session",
          clientSessionId: "draft-session",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          creationState: "pending",
        }),
      ],
    });
    useChatStore
      .getState()
      .setSkillDrafts("draft-session", [
        { id: "builtin:agent-builder", name: "agent-builder" },
      ]);

    renderHook(() => useChatSessionController({ sessionId: "draft-session" }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockPreSeedDraftAgent).not.toHaveBeenCalled();
  });

  it("marks eagerly selected Agent Builder preparation as failed", async () => {
    mockPreSeedDraftAgent.mockRejectedValueOnce(new Error("draft failed"));
    useChatStore
      .getState()
      .setSkillDrafts("session-1", [
        { id: "builtin:agent-builder", name: "agent-builder" },
      ]);

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      expect(mockMarkAgentBuilderSessionPreparationFailed).toHaveBeenCalledWith(
        "session-1",
      );
    });
  });

  it("removing a deferred workspace send prevents Agent Builder preparation", () => {
    useChatStore.getState().enqueueDeferredMessage(
      "draft-session",
      {
        persona: { kind: "inherit" },
        text: "make a reviewer",
        sendOptions: {
          chips: [{ label: "agent-builder", type: "skill" }],
        },
      },
      { type: "workspace-first-send", status: "choice" },
    );
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          id: "draft-session",
          clientSessionId: "draft-session",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          creationState: "pending",
        }),
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "draft-session" }),
    );
    const deferredRecord =
      useChatStore.getState().queuedMessageBySession["draft-session"]?.[0];

    act(() => {
      result.current.queue.dismiss(deferredRecord?.recordId);
      useChatStore
        .getState()
        .promoteSessionId("draft-session", "backend-session");
      useChatSessionStore
        .getState()
        .promoteDraftSession("draft-session", "backend-session");
    });

    expect(mockPreSeedDraftAgent).not.toHaveBeenCalled();
  });

  it("keeps a promoted builder send parked until its draft target is ready", () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          intent: "build-agent",
          agentBuilderOpen: true,
          targetAgentPath: null,
          targetAgentDraftState: "preparing",
        }),
      ],
    });
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "make a reviewer",
      sendOptions: {
        chips: [{ label: "agent-builder", type: "skill" }],
      },
    });

    const { rerender } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    expect(latestMessageQueueArgs()[1]).toBe("thinking");
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();

    act(() => {
      useChatSessionStore.getState().patchSession("session-1", {
        targetAgentPath: "/Users/x/.agents/agents/draft-session-1.md",
        targetAgentSlug: "draft-session-1",
        targetAgentDraftState: null,
      });
    });
    rerender();

    expect(latestMessageQueueArgs()[1]).toBe("idle");
    const drainSend = latestMessageQueueArgs()[2] as (
      text: string,
      persona?: { id: string },
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) => boolean;
    act(() => {
      drainSend(
        "make a reviewer",
        undefined,
        undefined,
        useChatStore.getState().queuedMessageBySession["session-1"]?.[0]
          ?.payload.sendOptions,
      );
    });

    const sendOptions = mockUseChatSendMessage.mock.calls.at(-1)?.[4] as
      | ChatSendOptions
      | undefined;
    expect(sendOptions?.assistantPrompt).toContain("draft-session-1.md");
  });

  it("routes a pending project first send through workspace startup", () => {
    setMultiWorkspaceEnabled(true);
    const onWorkspaceNameRequest = vi.fn();
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          path: "/tmp/project.md",
          name: "Project",
          description: "",
          prompt: "",
          icon: "",
          color: "#22c55e",
          projectWorkspaces: [
            {
              id: "workspace-1",
              path: "/repo/project",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: false,
              repositoryPath: "/repo/project",
              startupMode: "worktree",
            },
          ],
          workingDirs: ["/repo/project"],
          useWorktrees: true,
          order: 0,
          archivedAt: null,
          artifact: null,
        },
      ],
      loading: false,
      activeProjectId: "project-1",
    });
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          id: "draft-session",
          clientSessionId: "draft-session",
          projectId: "project-1",
          workingDir: "/repo/project",
          workspaceAttachments: [],
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          creationState: "pending",
        }),
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({
        sessionId: "draft-session",
        onWorkspaceNameRequest,
      }),
    );

    act(() => {
      expect(result.current.handleSend("send after setup")).toBe(true);
    });

    expect(mockUseChatSendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"]?.[0],
    ).toMatchObject({
      kind: "deferred",
      payload: { text: "send after setup" },
      state: { type: "workspace-first-send", status: "choice" },
    });
  });

  it("keeps queued messages from draining while a project draft session is pending", () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          id: "draft-session",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          projectId: "project-1",
          creationState: "pending",
        }),
      ],
    });
    useChatStore.getState().enqueueTransportReadyMessage("draft-session", {
      persona: { kind: "inherit" },
      text: "queued from pill",
    });

    renderHook(() => useChatSessionController({ sessionId: "draft-session" }));

    const [queueSessionId, queueChatState] = latestMessageQueueArgs();
    expect(queueSessionId).toBe("draft-session");
    expect(queueChatState).toBe("thinking");
    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"]?.[0]
        ?.payload,
    ).toEqual({
      persona: { kind: "inherit" },
      text: "queued from pill",
    });
  });

  it("passes all included workspaces to the agent system prompt", async () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          workingDir: "/tmp/project",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/tmp/project"),
              path: "/tmp/project",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
            {
              id: workspaceAttachmentIdForPath(
                "/tmp/project-worktrees/phase-3",
              ),
              path: "/tmp/project-worktrees/phase-3",
              kind: "git-linked-worktree",
              source: "selected",
              branch: "phase-3",
              usedByAgent: false,
            },
          ],
        }),
      ],
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    const systemPrompt = mockUseChatHook.mock.calls.at(-1)?.[2];
    expect(systemPrompt).toContain("<included-workspaces>");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(systemPrompt).toContain("path: /tmp/project");
    expect(systemPrompt).toContain("branch: main");
    expect(systemPrompt).toContain("path: /tmp/project-worktrees/phase-3");
    expect(systemPrompt).toContain("branch: phase-3");
    expect(systemPrompt).not.toContain("<active-working-context>");
  });

  it("omits multi-workspace context when the setting is disabled", () => {
    setMultiWorkspaceEnabled(false);
    mockListSkills.mockResolvedValue([
      {
        id: "project:/tmp/project/.agents/skills/code-review",
        name: "code-review",
        description: "Review code changes for bugs and regressions.",
        instructions: "Full instructions are not part of the catalog.",
        path: "/tmp/project/.agents/skills/code-review",
        fileLocation: "/tmp/project/.agents/skills/code-review/SKILL.md",
        sourceKind: "project",
        sourceLabel: "project",
        projectLinks: [],
        readonly: false,
        color: null,
      },
    ]);
    mockLoadWorkspaceInstructionFiles.mockResolvedValue([
      {
        path: "/tmp/project/AGENTS.md",
        workspacePaths: ["/tmp/project"],
        content: "repo-only instructions",
      },
    ]);
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          workingDir: "/tmp/project",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/tmp/project"),
              path: "/tmp/project",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
            {
              id: workspaceAttachmentIdForPath(
                "/tmp/project-worktrees/phase-3",
              ),
              path: "/tmp/project-worktrees/phase-3",
              kind: "git-linked-worktree",
              source: "selected",
              branch: "phase-3",
              usedByAgent: false,
            },
          ],
        }),
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    const systemPrompt = mockUseChatHook.mock.calls.at(-1)?.[2] ?? "";
    expect(systemPrompt).not.toContain("<included-workspaces>");
    expect(systemPrompt).not.toContain("<available-skills>");
    expect(systemPrompt).not.toContain("repo-only instructions");
    expect(systemPrompt).not.toContain("/tmp/project-worktrees/phase-3");
    expect(mockListSkills).not.toHaveBeenCalled();
    expect(mockListBerdAppSkills).toHaveBeenCalled();
    expect(mockLoadWorkspaceInstructionFiles).not.toHaveBeenCalled();
    expect(result.current.skillProjectDirs).toBeUndefined();
    expect(result.current.fileMentionProjectDirs).toEqual(["/tmp/project"]);
  });

  it("passes Berd app skills to normal single-workspace chats", async () => {
    setMultiWorkspaceEnabled(false);
    mockListBerdAppSkills.mockResolvedValue([
      {
        id: "app:/app-data/skills/goose-help",
        name: "goose-help",
        description: "Help with Berd",
        instructions: "Use Berd help.",
        path: "/app-data/skills/goose-help",
        fileLocation: "/app-data/skills/goose-help/SKILL.md",
        sourceKind: "app",
        sourceLabel: "Berd app",
        projectLinks: [],
        readonly: true,
        color: null,
      },
    ]);

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      const systemPrompt = mockUseChatHook.mock.calls.at(-1)?.[2] ?? "";
      expect(systemPrompt).toContain("<available-skills>");
      expect(systemPrompt).toContain("goose-help: Help with Berd");
    });
    expect(mockListBerdAppSkills).toHaveBeenCalled();
    expect(mockListSkills).not.toHaveBeenCalled();
  });

  it("passes an available skills catalog to the agent system prompt", async () => {
    mockListSkills.mockResolvedValue([
      {
        id: "project:/tmp/project/.agents/skills/code-review",
        name: "code-review",
        description: "Review code changes for bugs and regressions.",
        instructions: "Full instructions are not part of the catalog.",
        path: "/tmp/project/.agents/skills/code-review",
        fileLocation: "/tmp/project/.agents/skills/code-review/SKILL.md",
        sourceKind: "project",
        sourceLabel: "project",
        projectLinks: [
          {
            id: "/tmp/project",
            name: "project",
            workingDir: "/tmp/project",
          },
        ],
        readonly: false,
        color: null,
      },
    ]);
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          workingDir: "/tmp/project",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/tmp/project"),
              path: "/tmp/project",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
        }),
      ],
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      const systemPrompt = mockUseChatHook.mock.calls.at(-1)?.[2] ?? "";
      expect(systemPrompt).toContain("<available-skills>");
      expect(systemPrompt).toContain(
        "- code-review: Review code changes for bugs and regressions.",
      );
      expect(systemPrompt).toContain(
        "Source: /tmp/project/.agents/skills/code-review/SKILL.md",
      );
      expect(systemPrompt).not.toContain(
        "Full instructions are not part of the catalog.",
      );
    });
    expect(mockListSkills).toHaveBeenCalledWith(["/tmp/project"], {
      providerId: "goose",
      includeAppSkills: false,
    });
  });

  it("reloads both skills catalogs fresh when a skills-changed event fires", async () => {
    mockListSkills.mockResolvedValue([catalogSkill("code-review")]);
    useChatSessionStore.setState({
      sessions: [singleWorkspaceSession()],
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      const systemPrompt = mockUseChatHook.mock.calls.at(-1)?.[2] ?? "";
      expect(systemPrompt).toContain("- code-review:");
    });

    // A skill is created or deleted elsewhere in the app: the session's
    // catalogs must observe the change instead of serving the mount-time
    // snapshot until remount.
    mockListSkills.mockResolvedValue([catalogSkill("brand-new")]);
    mockListBerdAppSkills.mockImplementation(() =>
      immediatelyResolved([
        { ...catalogSkill("goose-help"), sourceKind: "app" },
      ]),
    );
    act(() => {
      emitSkillsChanged();
    });

    await waitFor(() => {
      const systemPrompt = mockUseChatHook.mock.calls.at(-1)?.[2] ?? "";
      expect(systemPrompt).toContain("- brand-new:");
      expect(systemPrompt).toContain("- goose-help:");
      expect(systemPrompt).not.toContain("- code-review:");
    });
  });

  it("lands post-event skills when the event's fresh reload cancels an in-flight mount fetch on the shared query key", async () => {
    // With a query client the catalog reads share query keys with the
    // mention/search consumers, and a fresh reload cancels any in-flight
    // fetch on the key. The mount fetch below stays pending so the
    // skills-changed event lands mid-flight; the cancelled fetch's rejection
    // must be superseded rather than clearing the catalog for the session's
    // lifetime.
    const preChange = deferred<never[]>();
    mockListGooseSourceSkills
      .mockImplementationOnce(() => preChange.promise)
      .mockResolvedValue([catalogSkill("post-change")]);
    useChatSessionStore.setState({
      sessions: [singleWorkspaceSession()],
    });

    const queryClient = new QueryClient();
    renderHook(() => useChatSessionController({ sessionId: "session-1" }), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    });

    await waitFor(() =>
      expect(mockListGooseSourceSkills).toHaveBeenCalledTimes(1),
    );

    act(() => {
      emitSkillsChanged();
    });

    await waitFor(() => {
      const systemPrompt = mockUseChatHook.mock.calls.at(-1)?.[2] ?? "";
      expect(systemPrompt).toContain("- post-change:");
    });
  });

  it("uses the resolved external agent id for available skill discovery", async () => {
    mockPickerState.selectedAgentId = "codex-acp";
    useAgentStore.setState({ selectedProvider: "codex" });
    mockListSkills.mockResolvedValue([]);
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "codex-acp",
            modelProviderId: "codex-acp",
            modelId: "gpt-5.4",
            modelName: "GPT-5.4",
          },
          workingDir: "/tmp/project",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/tmp/project"),
              path: "/tmp/project",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
        }),
      ],
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalledWith(["/tmp/project"], {
        providerId: "codex-acp",
        includeAppSkills: false,
        fresh: undefined,
      });
    });
  });

  it("does not pass a project artifact folder as an included workspace", () => {
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          path: "/Users/test/.goose/projects/project-1.md",
          name: "Desktop UX",
          description: "",
          prompt: "",
          icon: "",
          color: "#22c55e",
          projectWorkspaces: [],
          workingDirs: [],
          useWorktrees: true,
          order: 0,
          archivedAt: null,
          artifact: null,
        },
      ],
      loading: false,
      activeProjectId: null,
    });
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          projectId: "project-1",
          workingDir: "/Users/test/goose artifacts",
        }),
      ],
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    const systemPrompt = mockUseChatHook.mock.calls.at(-1)?.[2] ?? "";
    expect(systemPrompt).not.toContain("<included-workspaces>");
    expect(systemPrompt).not.toContain("goose artifacts");
  });

  it("does not seed project workspaces into an existing chat prompt", async () => {
    setMultiWorkspaceEnabled(true);
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          path: "/Users/test/.goose/projects/project-1.md",
          name: "Builderbot",
          description: "",
          prompt: "",
          icon: "",
          color: "#22c55e",
          projectWorkspaces: [
            {
              id: "workspace-builderbot",
              path: "/repo/builderbot",
              kind: "subdirectory",
              source: "selected",
              branch: "main",
              usedByAgent: false,
              startupMode: "worktree",
            },
            {
              id: "workspace-bbsubscriber",
              path: "/repo/bbsubscriber",
              kind: "subdirectory",
              source: "selected",
              branch: "main",
              usedByAgent: false,
              startupMode: "worktree",
            },
          ],
          workingDirs: ["/repo/builderbot", "/repo/bbsubscriber"],
          useWorktrees: true,
          order: 0,
          archivedAt: null,
          artifact: null,
        },
      ],
      loading: false,
      activeProjectId: null,
    });
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          projectId: "project-1",
          workingDir: "/repo/builderbot",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/repo/builderbot"),
              path: "/repo/builderbot",
              kind: "subdirectory",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
        }),
      ],
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    const systemPrompt = mockUseChatHook.mock.calls.at(-1)?.[2] ?? "";
    expect(systemPrompt).toContain("<included-workspaces>");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(systemPrompt).toContain("path: /repo/builderbot");
    expect(systemPrompt).not.toContain("/repo/bbsubscriber");
  });

  it("allows a queued draft message to drain after promotion to the backend session id", () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          id: "draft-session",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          projectId: "project-1",
          creationState: "pending",
        }),
      ],
    });
    useChatStore.getState().enqueueTransportReadyMessage("draft-session", {
      persona: { kind: "inherit" },
      text: "queued from pill",
    });

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
          sessionFixture({
            id: "backend-1",
            projectId: "project-1",
          }),
        ],
      });
    });
    rerender({ sessionId: "backend-1" });

    const [queueSessionId, queueChatState] = latestMessageQueueArgs();
    expect(queueSessionId).toBe("backend-1");
    expect(queueChatState).toBe("idle");
    expect(
      useChatStore.getState().queuedMessageBySession["backend-1"]?.[0]?.payload,
    ).toEqual({
      persona: { kind: "inherit" },
      text: "queued from pill",
    });
    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"],
    ).toBeUndefined();
  });

  it("keeps failed project draft sessions from draining queued messages", () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          id: "draft-session",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          projectId: "project-1",
          creationState: "failed",
        }),
      ],
    });
    useChatStore.getState().enqueueTransportReadyMessage("draft-session", {
      persona: { kind: "inherit" },
      text: "queued from pill",
    });

    const { rerender } = renderHook(() =>
      useChatSessionController({ sessionId: "draft-session" }),
    );
    rerender();

    const [queueSessionId, queueChatState] = latestMessageQueueArgs();
    expect(queueSessionId).toBe("draft-session");
    expect(queueChatState).toBe("thinking");
    expect(
      useChatStore.getState().queuedMessageBySession["draft-session"]?.[0]
        ?.payload,
    ).toEqual({
      persona: { kind: "inherit" },
      text: "queued from pill",
    });
  });

  it("keeps existing non-draft sessions idle so no-project queued sends still drain", () => {
    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    const [queueSessionId, queueChatState] = latestMessageQueueArgs();
    expect(queueSessionId).toBe("session-1");
    expect(queueChatState).toBe("idle");
  });

  it("blocks queued sends while a stopped backend run is still active", () => {
    mockUseChatRuntime.chatState = "idle";
    mockUseChatRuntime.activeRunId = "run-1";

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    const [, , , , isSendBlocked] = latestMessageQueueArgs();
    expect(isSendBlocked).toBe(true);
  });

  it("blocks queued sends while stop cancellation is pending without run metadata", () => {
    mockUseChatRuntime.chatState = "idle";
    mockUseChatRuntime.activeRunId = null;
    mockUseChatRuntime.isRunCancellationPending = true;

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    const [, , , , isSendBlocked] = latestMessageQueueArgs();
    expect(isSendBlocked).toBe(true);
  });

  it("queues sends while stop cancellation is pending without run metadata", () => {
    mockUseChatRuntime.chatState = "idle";
    mockUseChatRuntime.activeRunId = null;
    mockUseChatRuntime.isRunCancellationPending = true;
    const enqueue = vi.fn();
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: null,
      enqueue,
      dismiss: vi.fn(),
    }));

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleSend("next poem");
    });

    expect(enqueue).toHaveBeenCalledWith(
      "next poem",
      undefined,
      undefined,
      { telemetrySourceSurface: CHAT_SOURCE_SURFACE.MAIN_CHAT },
      undefined,
    );
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();
  });

  it("waits for app skill discovery before accepting a normal chat send", async () => {
    const appSkillsDeferred = deferred<[]>();
    const enqueue = vi.fn();
    mockListBerdAppSkills.mockReturnValue(appSkillsDeferred.promise);
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: null,
      enqueue,
      dismiss: vi.fn(),
    }));

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    expect(latestMessageQueueArgs()[1]).toBe("thinking");
    act(() => {
      expect(result.current.handleSend("help me with Berd")).toBe(true);
    });
    expect(enqueue).toHaveBeenCalledWith(
      "help me with Berd",
      undefined,
      undefined,
      { telemetrySourceSurface: CHAT_SOURCE_SURFACE.MAIN_CHAT },
      undefined,
    );
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      appSkillsDeferred.resolve([]);
      await appSkillsDeferred.promise;
    });

    await waitFor(() => expect(latestMessageQueueArgs()[1]).toBe("idle"));
  });

  it("waits for complete workspace context before freezing queued execution", async () => {
    const skillsDeferred = deferred<ReturnType<typeof catalogSkill>[]>();
    const enqueue = vi.fn();
    mockListSkills.mockReturnValue(skillsDeferred.promise);
    mockLoadWorkspaceInstructionFiles.mockResolvedValue([
      {
        path: "/tmp/project/AGENTS.md",
        workspacePaths: ["/tmp/project"],
        content: "workspace instructions are ready",
      },
    ]);
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: null,
      enqueue,
      dismiss: vi.fn(),
    }));
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          workingDir: "/tmp/project",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/tmp/project"),
              path: "/tmp/project",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
        }),
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    expect(latestMessageQueueArgs()[1]).toBe("thinking");

    act(() => {
      expect(result.current.handleSend("hello")).toBe(true);
    });

    const queuedSendOptions = enqueue.mock.calls[0]?.[3];
    const queuedExecutionTarget = enqueue.mock.calls[0]?.[5];
    // Only the telemetry surface stamp is captured this early — no execution
    // context may freeze before the workspace context is ready.
    expect(queuedSendOptions).toEqual({
      telemetrySourceSurface: CHAT_SOURCE_SURFACE.MAIN_CHAT,
    });
    expect(queuedExecutionTarget).toBeUndefined();
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      skillsDeferred.resolve([catalogSkill("code-review")]);
      await skillsDeferred.promise;
    });

    await waitFor(() => {
      expect(latestMessageQueueArgs()[1]).toBe("idle");
    });

    const drainSend = latestMessageQueueArgs()[2] as (
      text: string,
      persona?: { id: string; name?: string },
      attachments?: unknown[],
      sendOptions?: ChatSendOptions,
    ) => boolean | Promise<boolean>;
    await act(async () => {
      await drainSend("hello", undefined, undefined, undefined);
    });

    const executionSystemPrompt =
      mockUseChatSendMessage.mock.calls.at(-1)?.[4]?.executionSystemPrompt;
    expect(executionSystemPrompt).toContain("<included-workspaces>");
    expect(executionSystemPrompt).toContain("workspace instructions are ready");
    expect(executionSystemPrompt).toContain("code-review");
  });

  it("snapshots persona identity before workspace context becomes ready", async () => {
    const skillsDeferred = deferred<ReturnType<typeof catalogSkill>[]>();
    const enqueue = vi.fn();
    mockListSkills.mockReturnValue(skillsDeferred.promise);
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: null,
      enqueue,
      dismiss: vi.fn(),
    }));
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Planner",
          systemPrompt: "Preserve this instruction.",
          isBuiltin: false,
          writable: true,
        },
      ],
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
          workingDir: "/tmp/project",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/tmp/project"),
              path: "/tmp/project",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 0,
        },
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );
    act(() => {
      result.current.handleSend("plan", "persona-1");
    });

    expect(enqueue).toHaveBeenCalledWith(
      "plan",
      "persona-1",
      undefined,
      expect.objectContaining({
        capturedPersonaSystemPrompt: expect.stringContaining(
          "Preserve this instruction.",
        ),
      }),
      "Planner",
    );
    expect(enqueue.mock.calls[0]?.[3]).not.toHaveProperty(
      "executionSystemPrompt",
    );
  });

  it("does not reuse stale workspace instructions after included workspaces are removed", async () => {
    mockLoadWorkspaceInstructionFiles.mockResolvedValue([
      {
        path: "/tmp/project/AGENTS.md",
        workspacePaths: ["/tmp/project"],
        content: "repo-only instructions",
      },
    ]);
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          workingDir: "/tmp/project",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/tmp/project"),
              path: "/tmp/project",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
        }),
      ],
    });

    const { rerender } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await waitFor(() => {
      expect(mockUseChatHook.mock.calls.at(-1)?.[2]).toContain(
        "repo-only instructions",
      );
    });
    const callsBeforeWorkspaceRemoval = mockUseChatHook.mock.calls.length;

    act(() => {
      useChatSessionStore.setState({
        sessions: [
          sessionFixture({
            executionTarget: {
              harnessId: "goose",
              modelProviderId: "openai",
              modelId: "gpt-4o",
              modelName: "GPT-4o",
            },
            workspaceAttachments: [],
          }),
        ],
      });
    });
    rerender();

    const promptsAfterWorkspaceRemoval = mockUseChatHook.mock.calls
      .slice(callsBeforeWorkspaceRemoval)
      .map((call) => String(call[2] ?? ""));
    expect(promptsAfterWorkspaceRemoval.length).toBeGreaterThan(0);
    expect(
      promptsAfterWorkspaceRemoval.some((prompt) =>
        prompt.includes("repo-only instructions"),
      ),
    ).toBe(false);
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
      expect.objectContaining({
        displayText: "make it shorter",
        // The controller always wires the send-telemetry commit anchor.
        onUserMessageCommitted: expect.any(Function),
      }),
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

  it("does not offer steering for external agent harnesses", async () => {
    mockUseChatRuntime.chatState = "streaming";
    mockPickerState.selectedAgentId = "codex-acp";
    useAgentStore.setState({ selectedProvider: "codex-acp" });
    useChatSessionStore.getState().replaceSessionExecutionTarget("session-1", {
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "gpt-5.4",
      modelName: "GPT-5.4",
    });
    const dismiss = vi.fn();
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: { text: "a little shorter" },
      enqueue: vi.fn(),
      dismiss,
    }));

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    expect(result.current.canSteerMessage).toBe(false);
    expect(result.current.canSteerQueuedMessage).toBe(false);

    let draftAccepted: boolean | undefined;
    let queuedAccepted: boolean | undefined;
    await act(async () => {
      draftAccepted = await result.current.steerDraftMessage("make it shorter");
      queuedAccepted = await result.current.steerQueuedMessage();
    });

    expect(draftAccepted).toBe(false);
    expect(queuedAccepted).toBe(false);
    expect(mockUseChatSteerMessage).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
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
        onMessageAccepted?: (
          sessionId: string,
          text: string,
        ) => boolean | undefined;
        __sessionId?: string;
      }) => {
        options?.onMessageAccepted?.(
          options.__sessionId ?? "session-1",
          "hello",
        );
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
      {
        providerId: "openai",
        modelId: "gpt-4o",
        reasoningEffortValue: "high",
      },
    );
  });

  it("keeps a reasoning-effort change in a started chat session-local", async () => {
    patchReasoningEffort("session-1");
    useChatSessionStore.getState().patchSession("session-1", {
      messageCount: 1,
    });
    mockUseChatSendMessage.mockImplementationOnce(
      async (options?: {
        onMessageAccepted?: (sessionId: string, text: string) => void;
      }) => {
        options?.onMessageAccepted?.("session-1", "follow up");
      },
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => result.current.handleReasoningEffortChange("high"));
    act(() => result.current.handleSend("follow up"));

    await waitFor(() => {
      expect(mockAcpSetSessionConfigOption).toHaveBeenCalledWith(
        "session-1",
        "thinking_effort",
        "high",
        {
          providerId: "openai",
          modelId: "gpt-4o",
          reasoningEffortValue: "high",
        },
      );
    });
    expect(mockGoosePreferencesSave).not.toHaveBeenCalled();
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
        sessionFixture({
          title: "Chat A",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-5.4",
            modelName: "GPT-5.4",
          },
        }),
        sessionFixture({
          id: "session-2",
          title: "Chat B",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-5.4",
            modelName: "GPT-5.4",
          },
        }),
      ],
    });
    patchReasoningEffort("session-1");
    patchReasoningEffort("session-2");
    mockUseChatSendMessage.mockImplementation(
      async (options?: {
        ensurePrepared?: () => Promise<boolean | undefined>;
        onMessageAccepted?: (
          sessionId: string,
          text: string,
        ) => boolean | undefined;
        __sessionId?: string;
      }) => {
        options?.onMessageAccepted?.(
          options.__sessionId ?? "session-1",
          "hello",
        );
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
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          intent: "build-agent",
          targetAgentPath: "/Users/x/.agents/agents/draft-1.md",
          targetAgentSlug: "draft-1",
        }),
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

  it("lets the canonical composer remove the agent-builder skill", () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          intent: "build-agent",
          targetAgentPath: "/Users/x/.agents/agents/draft-1.md",
          targetAgentSlug: "draft-1",
        }),
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    expect(result.current.selectedSkills).toEqual([]);

    act(() => {
      result.current.handleSkillsChange([]);
    });

    expect(
      useChatStore.getState().skillDraftsBySession["session-1"] ?? [],
    ).toEqual([]);
  });

  it("does not reopen a closed builder just because its skill remains selected", async () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          intent: "build-agent",
          agentBuilderOpen: false,
          targetAgentPath: "/Users/x/.agents/agents/draft-1.md",
          targetAgentSlug: "draft-1",
        }),
      ],
    });
    useChatStore
      .getState()
      .setSkillDrafts("session-1", [
        { id: "builtin:agent-builder", name: "agent-builder" },
      ]);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockPreSeedDraftAgent).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({ agentBuilderOpen: false });

    act(() => {
      result.current.handleSkillsChange([]);
    });
    act(() => {
      result.current.handleSkillsChange([
        { id: "builtin:agent-builder", name: "agent-builder" },
      ]);
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({ agentBuilderOpen: true });
    });
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

  it("activates builder mode before appending an agent-builder send", async () => {
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "existing",
    });
    mockUseMessageQueue.mockImplementation((sessionId: string) => ({
      queuedMessage: null,
      queuedRecords:
        useChatStore.getState().queuedMessageBySession[sessionId] ?? [],
      enqueue: (
        text: string,
        personaId?: string,
        attachments?: unknown[],
        sendOptions?: unknown,
        personaName?: string,
      ) =>
        useChatStore.getState().enqueueTransportReadyMessage(sessionId, {
          persona:
            personaId === undefined
              ? { kind: "inherit" }
              : {
                  kind: "persona",
                  id: personaId,
                  ...(personaName ? { name: personaName } : {}),
                },
          text,
          attachments: attachments as ChatAttachmentDraft[] | undefined,
          sendOptions: sendOptions as ChatSendOptions | undefined,
        }),
      dismiss: vi.fn(),
    }));
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await act(async () => {
      expect(
        await result.current.handleSend("make an agent", undefined, undefined, {
          chips: [{ label: "agent-builder", type: "skill" }],
          assistantPrompt: "Use these skills for this request: agent-builder.",
        }),
      ).toBe(true);
    });

    expect(mockPreSeedDraftAgent).toHaveBeenCalledWith("session-1");
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({ intent: "build-agent" });
    expect(
      useChatStore
        .getState()
        .queuedMessageBySession["session-1"]?.map(
          (record) => record.payload.text,
        ),
    ).toEqual(["existing", "make an agent"]);
  });

  it("activates builder mode for a deferred persona send with the agent-builder chip", async () => {
    useAgentStore.setState({
      personas: [
        personaFixture({
          displayName: "Planner",
          systemPrompt: "Plan clearly.",
        }),
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

  it("routes a persona-switched builder first send through workspace startup", async () => {
    setMultiWorkspaceEnabled(true);
    const onWorkspaceNameRequest = vi.fn();
    const onMessageAccepted = vi.fn();
    useAgentStore.setState({
      personas: [
        personaFixture({
          displayName: "Planner",
          systemPrompt: "Plan clearly.",
          provider: "goose",
          model: "goose-claude-opus-4-8",
        }),
      ],
    });
    mockPickerState.modelsByAgent.set("goose", [
      {
        id: "goose-claude-opus-4-8",
        name: "Claude Opus 4.8",
        providerId: "databricks_v2",
      },
    ]);
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          path: "/Users/test/.goose/projects/project-1.md",
          name: "Builderbot",
          description: "",
          prompt: "",
          icon: "",
          color: "#22c55e",
          projectWorkspaces: [
            {
              id: "workspace-builderbot",
              path: "/repo/builderbot",
              kind: "git-main-worktree",
              source: "selected",
              branch: "main",
              usedByAgent: false,
              startupMode: "worktree",
            },
          ],
          workingDirs: ["/repo/builderbot"],
          useWorktrees: true,
          order: 0,
          archivedAt: null,
          artifact: null,
        },
      ],
      loading: false,
      activeProjectId: "project-1",
    });
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          projectId: "project-1",
          workingDir: "/repo/builderbot",
        }),
      ],
    });
    const { result } = renderHook(() =>
      useChatSessionController({
        sessionId: "session-1",
        onMessageAccepted,
        onWorkspaceNameRequest,
      }),
    );

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.handleSend(
        "plan",
        "persona-1",
        undefined,
        {
          chips: [{ label: "agent-builder", type: "skill" }],
          assistantPrompt: "Use agent-builder.",
        },
      );
    });

    expect(accepted).toBe(true);
    expect(mockPreSeedDraftAgent).toHaveBeenCalledWith("session-1");
    expect(onMessageAccepted).toHaveBeenCalledWith("session-1");
    expect(onWorkspaceNameRequest).not.toHaveBeenCalled();
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0],
    ).toMatchObject({
      kind: "deferred",
      payload: {
        text: "plan",
        persona: { kind: "persona", id: "persona-1" },
        sendOptions: {
          assistantPrompt: expect.stringContaining("draft-from-chat.md"),
        },
      },
      state: { type: "workspace-first-send", status: "choice" },
    });
  });

  it("cleans up a pre-seeded builder draft when inline setup is dismissed", async () => {
    const dismiss = vi.fn();
    mockUseMessageQueue.mockReturnValue({
      queuedMessage: null,
      enqueue: vi.fn(),
      dismiss,
    });
    useChatSessionStore.getState().patchSession("session-1", {
      intent: "build-agent",
      targetAgentPath: "/tmp/draft-agent.md",
      targetAgentSlug: "draft-agent",
    });
    useChatStore.getState().enqueueDeferredMessage(
      "session-1",
      { persona: { kind: "inherit" }, text: "build it" },
      {
        type: "workspace-first-send",
        status: "choice",
        projectId: "project-1",
        desired: [],
        cancelBuilderDraftPath: "/tmp/draft-agent.md",
      },
    );
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => result.current.queue.dismiss());

    expect(dismiss).toHaveBeenCalledOnce();
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      intent: undefined,
      targetAgentPath: undefined,
      targetAgentSlug: undefined,
    });
    await waitFor(() => {
      expect(mockDeletePersonaSource).toHaveBeenCalledWith(
        "/tmp/draft-agent.md",
      );
    });
  });

  it("queues persona-switch sends immediately with immutable FIFO selections", async () => {
    useAgentStore.setState({
      personas: [
        personaFixture({
          displayName: "Codex Planner",
          systemPrompt: "Plan clearly.",
          provider: "codex-acp",
        }),
        personaFixture({
          id: "persona-2",
          displayName: "Goose Reviewer",
          systemPrompt: "Review carefully.",
          provider: "goose",
          model: "goose-claude-opus-4-8",
        }),
      ],
    });
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          workingDir: "/tmp/project",
          workspaceAttachments: [
            {
              id: workspaceAttachmentIdForPath("/tmp/project"),
              path: "/tmp/project",
              kind: "git-main-worktree",
              source: "inferred",
              branch: "main",
              usedByAgent: false,
            },
          ],
        }),
      ],
    });
    mockPickerState.modelsByAgent.set("goose", [
      {
        id: "goose-claude-opus-4-8",
        name: "Claude Opus 4.8",
        providerId: "databricks_v2",
      },
    ]);
    const queued: Array<{
      text: string;
      personaId?: string | null;
      personaName?: string;
      sendOptions?: ChatSendOptions;
    }> = [];
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: null,
      queuedRecords: queued.map((payload, index) => ({
        id: `queued-${index}`,
        kind: "transport-ready" as const,
        payload,
        createdAt: index,
      })),
      enqueue: (
        text: string,
        personaId?: string | null,
        _attachments?: ChatAttachmentDraft[],
        sendOptions?: ChatSendOptions,
        personaName?: string,
      ) => {
        queued.push({
          text,
          personaId,
          personaName,
          sendOptions,
        });
        return true;
      },
      dismiss: vi.fn(),
    }));

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      expect(result.current.handleSend("no persona", null)).toBe(true);
      expect(result.current.handleSend("plan", "persona-1")).toBe(true);
      expect(result.current.handleSend("review", "persona-2")).toBe(true);
    });

    expect(queued).toEqual([
      {
        text: "no persona",
        personaId: null,
        personaName: undefined,
        sendOptions: {
          telemetrySourceSurface: CHAT_SOURCE_SURFACE.MAIN_CHAT,
        },
      },
      {
        text: "plan",
        personaId: "persona-1",
        personaName: "Codex Planner",
        sendOptions: {
          capturedPersonaSystemPrompt: expect.stringContaining("Plan clearly."),
          telemetrySourceSurface: CHAT_SOURCE_SURFACE.MAIN_CHAT,
        },
      },
      {
        text: "review",
        personaId: "persona-2",
        personaName: "Goose Reviewer",
        sendOptions: {
          capturedPersonaSystemPrompt:
            expect.stringContaining("Review carefully."),
          telemetrySourceSurface: CHAT_SOURCE_SURFACE.MAIN_CHAT,
        },
      },
    ]);
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("preserves a newer draft when a persona-switch queue commits later", () => {
    vi.useFakeTimers();
    let acceptCommittedMessage!: (text: string) => void;
    mockUseChatSendMessage.mockImplementationOnce(
      (options?: {
        onMessageAccepted?: (
          sessionId: string,
          text: string,
        ) => boolean | undefined;
        __sessionId?: string;
      }) => {
        acceptCommittedMessage = (text: string) => {
          const targetSessionId = options?.__sessionId ?? "session-1";
          if (options?.onMessageAccepted?.(targetSessionId, text) !== false) {
            useChatStore.getState().clearDraft(targetSessionId);
          }
        };
      },
    );
    mockUseChatRuntime.chatState = "streaming";
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

    act(() => {
      result.current.handleDraftChange("plan this");
      expect(result.current.handleSend("plan this", "persona-1")).toBe(true);
      result.current.handleDraftChange("newer draft");
    });
    const [, , drainQueuedMessage] = latestMessageQueueArgs();
    act(() => {
      (drainQueuedMessage as (text: string) => void)("plan this");
      acceptCommittedMessage("plan this");
      vi.advanceTimersByTime(300);
    });

    expect(useChatStore.getState().draftsBySession["session-1"]).toBe(
      "newer draft",
    );
    vi.useRealTimers();
  });

  it("keeps an accepted persona-switch record when the view becomes read-only", () => {
    useAgentStore.setState({
      personas: [
        personaFixture({
          displayName: "Planner",
          systemPrompt: "Plan clearly.",
        }),
      ],
    });
    const enqueue = vi.fn().mockReturnValue(true);
    mockUseMessageQueue.mockImplementation(() => ({
      queuedMessage: null,
      queuedRecords: [],
      enqueue,
      dismiss: vi.fn(),
    }));
    const { result, rerender } = renderHook(
      ({ readOnly }: { readOnly: boolean }) =>
        useChatSessionController({ sessionId: "session-1", readOnly }),
      { initialProps: { readOnly: false } },
    );

    act(() => {
      expect(result.current.handleSend("plan", "persona-1")).toBe(true);
      rerender({ readOnly: true });
    });

    expect(enqueue).toHaveBeenCalledOnce();
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();
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

  it("applies the selected provider-qualified model atomically", async () => {
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
        modelName: "Claude Sonnet 4",
      },
    });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
      });
    });

    expect(mockSetSelectedProvider).toHaveBeenCalledWith("goose");
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
        modelName: "Claude Sonnet 4",
      },
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
    expect(getModelSelectionIntent("session-1")).toBeUndefined();
  });

  it("archives the stranded empty session after recovering from a 'Provider not set' switch", async () => {
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("Provider not set"));

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    // The dead in-place switch is abandoned; a fresh session is born directly on
    // the target provider with the provider forced at birth.
    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "anthropic",
        "/tmp/project",
        expect.objectContaining({
          modelId: "claude-sonnet-4",
          deferProviderSetup: false,
        }),
      );
    });

    await waitFor(() => {
      expect(useChatSessionStore.getState().activeSessionId).toBe(
        "session-recovered",
      );
    });
    expect(useChatStore.getState().activeSessionId).toBe("session-recovered");

    // The stranded empty corpse is archived on the backend rather than left in
    // the list to re-trigger the trap or accumulate empties.
    await waitFor(() => {
      expect(mockAcpSessionArchive).toHaveBeenCalledWith({
        sessionId: "session-1",
      });
    });
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toBeDefined();

    // The recovered choice sticks: the success-path persist is skipped by the
    // recovery early-return, so recovery persists it explicitly. Without this
    // the next new session for this agent would fall back to the old (dead)
    // preference and re-enter the trap.
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
  });

  it("keeps the recovery navigation when archiving the stranded session fails", async () => {
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("Provider not set"));
    mockAcpSessionArchive.mockRejectedValueOnce(new Error("archive failed"));

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    // Recovery still lands on the fresh session even though the best-effort
    // cleanup of the old one throws.
    await waitFor(() => {
      expect(useChatSessionStore.getState().activeSessionId).toBe(
        "session-recovered",
      );
    });
    await waitFor(() => {
      expect(mockAcpSessionArchive).toHaveBeenCalledWith({
        sessionId: "session-1",
      });
    });
  });

  it("skips navigation and archives the fresh session when a newer pick supersedes the recreate mid-flight", async () => {
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("Provider not set"));

    // Suspend the recovery's createSession so a second pick can land while the
    // fresh session is still being born.
    const create = deferred<{
      sessionId: string;
      configOptionsSnapshot: undefined;
    }>();
    mockAcpCreateSession.mockReturnValueOnce(create.promise);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    // First switch strands the provider and kicks off a recreate that suspends
    // inside createSession.
    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledTimes(1);
    });

    // A second pick lands mid-recreate, bumping the picker's shared version
    // counter so the in-flight recreate is now superseded.
    act(() => {
      result.current.handleProviderChange("codex-acp");
    });

    // Let the suspended recreate finish creating its (now stale) session.
    create.resolve({
      sessionId: "session-recovered",
      configOptionsSnapshot: undefined,
    });

    // The superseded recreate archives the empty session it just created rather
    // than orphaning it, closing the empty-accumulation gap under a rapid
    // double-switch.
    await waitFor(() => {
      expect(mockAcpSessionArchive).toHaveBeenCalledWith({
        sessionId: "session-recovered",
      });
    });
    // ...and never navigates onto the stale target — the newer pick owns
    // activation, so the user is not left on the superseded provider.
    expect(useChatSessionStore.getState().activeSessionId).not.toBe(
      "session-recovered",
    );
    expect(useChatStore.getState().activeSessionId).not.toBe(
      "session-recovered",
    );
    // The superseded recreate must not persist its stale model choice either —
    // the newer pick owns the preference, so the discarded selection leaves no
    // residue in goose:preferredModelsByAgent.
    expect(
      window.localStorage.getItem("goose:preferredModelsByAgent"),
    ).toBeNull();
  });

  it("recovers a session with a failed prompt and carries the draft into the new composer", async () => {
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("Provider not set"));

    // Chat-first on a dead provider: the optimistic user message and the
    // error bubble live only in the local store; the backend committed
    // nothing. There is also a half-typed draft in the composer.
    const draftAttachment = {
      id: "draft-attachment",
      kind: "file" as const,
      name: "report.pdf",
      path: "/tmp/report.pdf",
      mimeType: "application/pdf",
    };

    useChatStore.setState({
      messagesBySession: {
        "session-1": [
          {
            id: "user-1",
            role: "user",
            created: 0,
            content: [{ type: "text", text: "help me fix this bug" }],
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
      draftsBySession: { "session-1": "second attempt" },
      draftAttachmentsBySession: { "session-1": [draftAttachment] },
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    // Recovery recreates on the target provider despite the local history…
    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "anthropic",
        "/tmp/project",
        expect.objectContaining({
          modelId: "claude-sonnet-4",
          deferProviderSetup: false,
        }),
      );
    });
    await waitFor(() => {
      expect(useChatSessionStore.getState().activeSessionId).toBe(
        "session-recovered",
      );
    });

    // …and the typed-but-unsent draft survives the hop into the new composer.
    expect(useChatStore.getState().draftsBySession["session-recovered"]).toBe(
      "help me fix this bug\n\nsecond attempt",
    );
    expect(
      useChatStore.getState().draftAttachmentsBySession["session-recovered"],
    ).toEqual([draftAttachment]);

    await waitFor(() => {
      expect(mockAcpSessionArchive).toHaveBeenCalledWith({
        sessionId: "session-1",
      });
    });
  });

  it("does not recover a session that has assistant history", async () => {
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("Provider not set"));

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

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    // The switch failure surfaces through the normal rollback path instead.
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledTimes(1);
    });
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
  });

  it("recovers onto the persona's provider when a persona switch strands on a dead provider", async () => {
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("Provider not set"));
    useAgentStore.setState({
      personas: [
        personaFixture({
          provider: "anthropic",
          model: "claude-sonnet-4",
        }),
      ],
    });
    mockPickerState.availableModels = [
      {
        id: "claude-sonnet-4",
        name: "claude-sonnet-4",
        displayName: "Claude Sonnet 4",
        providerId: "anthropic",
      },
    ];

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePersonaChange("persona-1");
    });

    // The in-place persona model apply fails on the dead provider; recovery
    // recreates directly on the persona's provider instead of rolling back.
    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "anthropic",
        "/tmp/project",
        expect.objectContaining({
          modelId: "claude-sonnet-4",
          deferProviderSetup: false,
        }),
      );
    });
    await waitFor(() => {
      expect(useChatSessionStore.getState().activeSessionId).toBe(
        "session-recovered",
      );
    });
    await waitFor(() => {
      expect(mockAcpSessionArchive).toHaveBeenCalledWith({
        sessionId: "session-1",
      });
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("does not activate a persona recovery superseded by a newer pick", async () => {
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("Provider not set"));
    const create = deferred<{
      sessionId: string;
      configOptionsSnapshot: undefined;
    }>();
    mockAcpCreateSession.mockReturnValueOnce(create.promise);
    useAgentStore.setState({
      personas: [
        personaFixture({
          provider: "anthropic",
          model: "claude-sonnet-4",
        }),
      ],
    });
    mockPickerState.availableModels = [
      {
        id: "claude-sonnet-4",
        name: "claude-sonnet-4",
        displayName: "Claude Sonnet 4",
        providerId: "anthropic",
      },
    ];

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );
    act(() => {
      result.current.handlePersonaChange("persona-1");
    });
    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.handleProviderChange("codex-acp");
    });
    create.resolve({
      sessionId: "session-recovered",
      configOptionsSnapshot: undefined,
    });

    await waitFor(() => {
      expect(mockAcpSessionArchive).toHaveBeenCalledWith({
        sessionId: "session-recovered",
      });
    });
    expect(useChatSessionStore.getState().activeSessionId).not.toBe(
      "session-recovered",
    );
  });

  it("preserves reasoning effort rehydrated during a model switch", async () => {
    patchReasoningEffort("session-1", "low");
    mockAcpPrepareSession.mockImplementationOnce(async () => {
      patchReasoningEffort("session-1", "high");
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
      });
    });

    await waitFor(() => {
      expect(getModelSelectionIntent("session-1")).toBeUndefined();
    });
    expect(
      useChatSessionStore.getState().getSession("session-1")?.reasoningEffort,
    ).toMatchObject({
      configId: "thinking_effort",
      currentValue: "high",
    });
  });

  it("refreshes missing reasoning effort when the model picker opens", async () => {
    mockAcpPrepareSession.mockResolvedValueOnce({
      model: null,
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "high",
        options: [
          { id: "off", name: "Off" },
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
      },
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePickerOpen();
    });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "openai",
        modelId: "gpt-4o",
        forceConfigRefresh: true,
      });
    });
    expect(
      useChatSessionStore.getState().getSession("session-1")?.reasoningEffort,
    ).toMatchObject({
      configId: "thinking_effort",
      currentValue: "high",
    });
  });

  it("does not refresh a UI-owned provider-only target when the model picker opens", async () => {
    useChatSessionStore.getState().replaceSessionExecutionTarget("session-1", {
      harnessId: "goose",
      modelProviderId: "anthropic",
    });
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await act(async () => {
      result.current.handlePickerOpen();
      await Promise.resolve();
    });

    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.executionTarget,
    ).toEqual({
      harnessId: "goose",
      modelProviderId: "anthropic",
    });
  });

  it("does not restore a stale model when a reasoning refresh finishes after a provider change", async () => {
    const refresh = deferred<{
      model: null;
      reasoningEffort: {
        configId: string;
        currentValue: string;
        options: Array<{ id: string; name: string }>;
      };
    }>();
    mockAcpPrepareSession.mockReturnValueOnce(refresh.promise);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePickerOpen();
    });
    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "openai",
        modelId: "gpt-4o",
        forceConfigRefresh: true,
      });
    });

    act(() => {
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget("session-1", {
          harnessId: "goose",
          modelProviderId: "anthropic",
        });
      refresh.resolve({
        model: null,
        reasoningEffort: {
          configId: "thinking_effort",
          currentValue: "high",
          options: [{ id: "high", name: "High" }],
        },
      });
    });

    await act(async () => {
      await refresh.promise;
    });
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "anthropic",
      },
    });
    expect(
      useChatSessionStore.getState().getSession("session-1")?.executionTarget
        ?.modelId,
    ).toBeUndefined();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.reasoningEffort,
    ).toBeUndefined();
  });

  it("does not enqueue a reasoning refresh after its selection changes while resolving cwd", async () => {
    const cwd = deferred<string>();
    mockResolveSessionCwd.mockReturnValueOnce(cwd.promise);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePickerOpen();
    });
    await waitFor(() => {
      expect(mockResolveSessionCwd).toHaveBeenCalledOnce();
    });

    await act(async () => {
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget("session-1", {
          harnessId: "goose",
          modelProviderId: "anthropic",
          modelId: "claude-sonnet-4",
          modelName: "Claude Sonnet 4",
        });
      cwd.resolve("/tmp/project");
      await cwd.promise;
    });

    expect(mockAcpPrepareSession).not.toHaveBeenCalled();

    await act(async () => {
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget("session-1", {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-5.6",
          modelName: "GPT-5.6",
        });
      useChatSessionStore.getState().setActiveWorkspace("session-1", {
        path: "/tmp/final",
        branch: null,
      });
    });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "openai",
        modelId: "gpt-5.6",
      });
    });
  });

  it("does not enqueue a reasoning refresh when metadata arrives while resolving cwd", async () => {
    const cwd = deferred<string>();
    mockResolveSessionCwd.mockReturnValueOnce(cwd.promise);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePickerOpen();
    });
    await waitFor(() => {
      expect(mockResolveSessionCwd).toHaveBeenCalledOnce();
    });

    await act(async () => {
      patchReasoningEffort("session-1", "high");
      cwd.resolve("/tmp/project");
      await cwd.promise;
    });

    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
  });

  it("does not infer a model to refresh reasoning for an unresolved Home target", async () => {
    useChatSessionStore.setState((state) => ({
      sessions: [
        sessionFixture({
          id: "home-session",
          title: "Home",
          executionTarget: { harnessId: "goose" },
        }),
        ...state.sessions,
      ],
    }));
    mockPickerState.availableModels = [
      {
        id: "claude-sonnet-4",
        name: "claude-sonnet-4",
        displayName: "Claude Sonnet 4",
        providerId: "anthropic",
        recommended: true,
      },
    ];
    const { result } = renderHook(() =>
      useChatSessionController({
        sessionId: "home-session",
        isHomeSession: true,
      }),
    );

    await act(async () => {
      result.current.handlePickerOpen();
      await Promise.resolve();
    });

    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("home-session"),
    ).toMatchObject({
      executionTarget: { harnessId: "goose" },
    });
  });

  it("keeps the selected model when send-time preparation supersedes the model switch", async () => {
    const firstPrepare = deferred();
    mockAcpPrepareSession.mockReset();
    mockAcpPrepareSession
      .mockReturnValueOnce(firstPrepare.promise)
      .mockResolvedValue(undefined);

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
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
      });
    });

    act(() => {
      result.current.handleSend("use the selected model");
    });

    await waitFor(() => {
      expect(mockUseChatSendMessage).toHaveBeenCalled();
    });

    firstPrepare.resolve();

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledTimes(1);
    });
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
        modelName: "Claude Sonnet 4",
      },
    });
  });

  it("uses the selected provider and model during send-time preparation", async () => {
    useChatSessionStore.getState().replaceSessionExecutionTarget("session-1", {
      harnessId: "goose",
      modelProviderId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
    mockAcpPrepareSession.mockReset();
    mockAcpPrepareSession.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await act(async () => {
      await result.current.handleSend("use the selected model");
    });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
      });
    });
  });

  it("does not prepare or dispatch an unresolved existing session", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Existing chat",
          workingDir: "/tmp/project",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    const preparationResults: Array<boolean | undefined> = [];
    const promptTransport = vi.fn();
    mockUseChatSendMessage.mockImplementation(
      async (options?: {
        ensurePrepared?: () => Promise<boolean | undefined>;
      }) => {
        const prepared = await options?.ensurePrepared?.();
        preparationResults.push(prepared);
        if (prepared !== false) promptTransport();
      },
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleSend("keep the backend model");
    });

    await waitFor(() => {
      expect(preparationResults).toEqual([false]);
    });
    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
    expect(promptTransport).not.toHaveBeenCalled();

    act(() => {
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget("session-1", {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-5.6",
          modelName: "GPT-5.6",
        });
      result.current.handleSend("now use the explicit model");
    });

    await waitFor(() => {
      expect(preparationResults).toEqual([false, true]);
      expect(promptTransport).toHaveBeenCalledOnce();
    });
    expectSessionPreparation({
      sessionId: "session-1",
      modelProviderId: "openai",
      modelId: "gpt-5.6",
    });
  });

  it("does not prepare an unresolved session when its workspace changes", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Existing chat",
          workingDir: "/tmp/project",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });

    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    await act(async () => {
      useChatSessionStore.getState().setActiveWorkspace("session-1", {
        path: "/tmp/other",
        branch: null,
      });
    });

    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
  });

  it("keeps a manually selected Goose model when sending with the current persona", async () => {
    useChatSessionStore.getState().replaceSessionExecutionTarget("session-1", {
      harnessId: "goose",
      modelProviderId: "databricks_v2",
      modelId: "goose-gpt-5-6-sol",
      modelName: "GPT-5.6 Sol",
    });
    useChatSessionStore.getState().patchSession("session-1", {
      personaId: "persona-1",
    });
    useAgentStore.setState({
      personas: [
        personaFixture({
          displayName: "Trace",
          systemPrompt: "Debug carefully.",
          provider: "goose",
          model: "goose-claude-fable-5",
        }),
      ],
    });
    mockPickerState.modelsByAgent.set("goose", [
      {
        id: "goose-gpt-5-5",
        name: "GPT-5.5",
        providerId: "databricks_v2",
        recommended: true,
      },
      {
        id: "goose-gpt-5-6-sol",
        name: "GPT-5.6 Sol",
        providerId: "databricks_v2",
      },
      {
        id: "goose-claude-fable-5",
        name: "Claude Fable 5",
        providerId: "databricks_v2",
      },
    ]);
    mockAcpPrepareSession.mockReset();
    mockAcpPrepareSession.mockResolvedValue(undefined);
    mockUseChatSendMessage.mockImplementationOnce(
      async (options?: {
        ensurePrepared?: (personaId?: string) => Promise<boolean | undefined>;
      }) => {
        await options?.ensurePrepared?.("persona-1");
      },
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    await act(async () => {
      await result.current.handleSend("use the selected model", "persona-1");
    });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-6-sol",
      });
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
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
      });
    });
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
        modelName: "Claude Sonnet 4",
      },
    });

    await act(async () => {
      firstCwd.resolve("/tmp/project");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockAcpPrepareSession).toHaveBeenCalledTimes(1);
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
        modelName: "Claude Sonnet 4",
      },
    });
  });

  it("rejects a captured send target when the UI changes before cwd resolves", async () => {
    const capturedTarget = {
      harnessId: "goose" as const,
      modelProviderId: "openai",
      modelId: "gpt-4o",
      modelName: "GPT-4o",
    };
    const capturedCwd = deferred<string>();
    const preparationResults: Array<boolean | undefined> = [];
    const promptTransport = vi.fn();
    mockResolveSessionCwd.mockReset();
    mockResolveSessionCwd
      .mockReturnValueOnce(capturedCwd.promise)
      .mockResolvedValue("/tmp/project");
    mockUseChatSendMessage.mockImplementationOnce(
      async (
        options?: {
          ensurePrepared?: (
            personaId?: string,
            sessionSelection?: ChatSendOptions["sessionSelection"],
          ) => Promise<boolean | undefined>;
        },
        _text?: string,
        _persona?: unknown,
        _attachments?: unknown,
        sendOptions?: ChatSendOptions,
      ) => {
        const prepared = await options?.ensurePrepared?.(
          undefined,
          sendOptions?.sessionSelection,
        );
        preparationResults.push(prepared);
        if (prepared !== false) promptTransport();
      },
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleSend(
        "use the captured model",
        undefined,
        undefined,
        {
          sessionSelection: capturedTarget,
        },
      );
    });
    await waitFor(() => {
      expect(mockResolveSessionCwd).toHaveBeenCalledOnce();
    });

    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });
    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
      });
    });

    await act(async () => {
      capturedCwd.resolve("/tmp/project");
      await capturedCwd.promise;
    });

    await waitFor(() => {
      expect(preparationResults).toEqual([false]);
    });
    expect(promptTransport).not.toHaveBeenCalled();
    expect(mockAcpPrepareSession).toHaveBeenCalledTimes(1);
    expect(mockAcpPrepareSession).not.toHaveBeenCalledWith(
      "session-1",
      "openai",
      expect.anything(),
      expect.objectContaining({ modelId: "gpt-4o" }),
    );
    expect(
      useChatSessionStore.getState().getSession("session-1")?.executionTarget,
    ).toEqual({
      harnessId: "goose",
      modelProviderId: "anthropic",
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
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("set model failed"));

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
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-4o",
          modelName: "GPT-4o",
        },
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
    expect(getModelSelectionIntent("session-1")).toBeUndefined();
    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "openai",
        modelId: "gpt-4o",
      });
    });
  });

  it("keeps a newer model selection when a superseded model switch fails", async () => {
    const firstPrepare = deferred();
    mockAcpPrepareSession.mockReset();
    mockAcpPrepareSession
      .mockReturnValueOnce(firstPrepare.promise)
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
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "anthropic",
          modelId: "claude-sonnet-4",
          modelName: "Claude Sonnet 4",
        },
      });
    });

    act(() => {
      result.current.handleModelChange("gpt-5.4");
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-5.4",
          modelName: "GPT-5.4",
        },
      });
    });

    firstPrepare.reject(new Error("first prepare failed"));

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "openai",
        modelId: "gpt-5.4",
      });
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
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "gpt-5.4",
        modelName: "GPT-5.4",
      },
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("adopts a managed model repair after foreground selection", async () => {
    useProviderCatalogStore.getState().mergeEntries([
      {
        id: "databricks_v2",
        displayName: "Databricks",
        category: "model",
        description: "Databricks",
        setupMethod: "single_api_key",
        group: "default",
      },
    ]);
    const managedRuntimeConfig = {
      schemaVersion: 1 as const,
      goose: {
        defaultModelProviderId: "databricks_v2",
        defaultModelId: "goose-gpt-5-5",
        modelProviders: [
          {
            id: "databricks_v2",
            displayName: "Databricks",
            models: [{ id: "goose-gpt-5-5", name: "GPT-5.5" }],
          },
        ],
      },
    };
    useRuntimeConfigStore.setState({
      loaded: true,
      result: {
        status: "ready",
        source: "fakeEndpoint",
        config: managedRuntimeConfig,
      },
      config: managedRuntimeConfig,
    });
    mockSupportedModelsList.mockResolvedValue({ models: ["goose-gpt-5-5"] });
    mockPickerState.availableModels = [
      {
        id: "legacy-v1-model",
        name: "Legacy",
        providerId: "databricks_v2",
      },
    ];
    modelFixtures["legacy-v1-model"] = {
      name: "legacy-v1-model",
      displayName: "Legacy",
      providerId: "databricks_v2",
    };

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleModelChange("legacy-v1-model");
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1")?.executionTarget,
      ).toEqual({
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-5",
        modelName: "goose-gpt-5-5",
      });
    });
    expectSessionPreparation({
      sessionId: "session-1",
      modelProviderId: "databricks_v2",
      modelId: "goose-gpt-5-5",
    });
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

  it("applies a persona's provider-only target exactly", async () => {
    useProviderCatalogStore.getState().mergeEntries([
      {
        id: "openai",
        displayName: "OpenAI",
        category: "model",
        description: "OpenAI",
        setupMethod: "single_api_key",
        group: "default",
      },
    ]);
    useAgentStore.setState({
      personas: [
        personaFixture({
          provider: "goose",
          modelProviderId: "openai",
          model: undefined,
        }),
      ],
    });
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePersonaChange("persona-1");
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        personaId: "persona-1",
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
        },
      });
    });
    expect(mockAcpPrepareSession).toHaveBeenCalledWith(
      "session-1",
      "openai",
      "/tmp/project",
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("keeps a provider-only persona target local while session creation is pending", () => {
    useProviderCatalogStore.getState().mergeEntries([
      {
        id: "openai",
        displayName: "OpenAI",
        category: "model",
        description: "OpenAI",
        setupMethod: "single_api_key",
        group: "default",
      },
    ]);
    useAgentStore.setState({
      personas: [
        personaFixture({
          provider: "goose",
          modelProviderId: "openai",
          model: undefined,
        }),
      ],
    });
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === "session-1"
          ? { ...candidate, creationState: "pending" }
          : candidate,
      ),
    }));
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePersonaChange("persona-1");
    });

    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      personaId: "persona-1",
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "openai",
      },
    });
    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
  });

  it("keeps a provider-qualified persona target local while session creation is pending", () => {
    useProviderCatalogStore.getState().mergeEntries([
      {
        id: "databricks_v2",
        displayName: "Databricks",
        category: "model",
        description: "Databricks",
        setupMethod: "single_api_key",
        group: "default",
      },
    ]);
    useAgentStore.setState({
      personas: [
        personaFixture({
          provider: "goose",
          modelProviderId: "databricks_v2",
          model: "goose-claude-opus-4-8",
        }),
      ],
    });
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === "session-1"
          ? { ...candidate, creationState: "pending" }
          : candidate,
      ),
    }));
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePersonaChange("persona-1");
    });

    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      personaId: "persona-1",
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-claude-opus-4-8",
      },
    });
    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
  });

  it("applies a persona's provider-qualified model without model inventory", async () => {
    useProviderCatalogStore.getState().mergeEntries([
      {
        id: "databricks_v2",
        displayName: "Databricks",
        category: "model",
        description: "Databricks",
        setupMethod: "single_api_key",
        group: "default",
      },
    ]);
    useAgentStore.setState({
      personas: [
        personaFixture({
          provider: "goose",
          modelProviderId: "databricks_v2",
          model: "goose-claude-opus-4-8",
        }),
      ],
    });
    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePersonaChange("persona-1");
    });

    await waitFor(() => {
      expect(result.current.currentModelId).toBe("goose-claude-opus-4-8");
    });
    expect(result.current.currentModelProviderId).toBe("databricks_v2");
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      personaId: "persona-1",
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-claude-opus-4-8",
        modelName: "goose-claude-opus-4-8",
      },
    });
    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "databricks_v2",
        modelId: "goose-claude-opus-4-8",
      });
    });
  });

  it("resolves a persona model from its agent when another harness is selected", async () => {
    useAgentStore.setState({
      selectedProvider: "codex-acp",
      personas: [
        personaFixture({
          provider: "goose",
          model: "goose-claude-opus-4-8",
        }),
      ],
    });
    mockPickerState.selectedAgentId = "codex-acp";
    mockPickerState.availableModels = [
      {
        id: "gpt-5.4",
        name: "gpt-5.4",
        providerId: "codex-acp",
        recommended: true,
      },
    ];
    mockPickerState.modelsByAgent.set("goose", [
      {
        id: "goose-claude-opus-4-8",
        name: "goose-claude-opus-4-8",
        providerId: "databricks_v2",
      },
    ]);

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePersonaChange("persona-1");
    });

    await waitFor(() => {
      expect(result.current.currentModelId).toBe("goose-claude-opus-4-8");
    });
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      personaId: "persona-1",
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-claude-opus-4-8",
        modelName: "goose-claude-opus-4-8",
      },
    });
    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-1",
        modelProviderId: "databricks_v2",
        modelId: "goose-claude-opus-4-8",
      });
    });
  });

  it("keeps a selected persona when a later persona refresh omits it", async () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          personaId: "persona-1",
        }),
      ],
    });
    useAgentStore.setState({
      personas: [personaFixture()],
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    expect(result.current.selectedPersona?.displayName).toBe("Research Scout");

    await act(async () => {
      useAgentStore.getState().setPersonas([
        personaFixture({
          id: "persona-2",
          displayName: "Another Agent",
          systemPrompt: "Help elsewhere.",
        }),
      ]);
      await Promise.resolve();
    });

    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      personaId: "persona-1",
    });
    expect(result.current.selectedPersona?.displayName).toBe("Research Scout");
    expect(result.current.personas.map((persona) => persona.id)).toEqual([
      "persona-1",
      "persona-2",
    ]);

    act(() => {
      result.current.handleSend("hello", "persona-1");
    });

    await waitFor(() => {
      expect(mockUseChatSendMessage).toHaveBeenCalled();
    });
    expect(mockUseChatSendMessage.mock.calls.at(-1)?.[2]).toEqual({
      id: "persona-1",
      name: "Research Scout",
    });
  });

  it("sends the selected persona id even when the persona snapshot is missing", async () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
            modelId: "gpt-4o",
            modelName: "GPT-4o",
          },
          personaId: "persona-1",
        }),
      ],
    });
    useAgentStore.setState({ personas: [] });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleSend("hello", "persona-1");
    });

    await waitFor(() => {
      expect(mockUseChatSendMessage).toHaveBeenCalled();
    });
    expect(mockUseChatSendMessage.mock.calls.at(-1)?.[2]).toEqual({
      id: "persona-1",
    });
  });

  it("keeps the current configured persona model through send-time preparation", async () => {
    useChatSessionStore.setState({
      sessions: [
        sessionFixture({
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "databricks_v2",
            modelId: "goose-claude-opus-4-8",
            modelName: "goose-claude-opus-4-8",
          },
          personaId: "persona-1",
          workingDir: "/tmp/stored-session",
        }),
      ],
    });
    useAgentStore.setState({
      personas: [
        personaFixture({
          provider: "goose",
          model: "goose-claude-opus-4-8",
        }),
      ],
    });
    mockPickerState.modelsByAgent.set("goose", [
      {
        id: "goose-claude-opus-4-8",
        name: "goose-claude-opus-4-8",
        providerId: "databricks_v2",
      },
      {
        id: "goose-gpt-5-5",
        name: "GPT-5.5",
        providerId: "databricks_v2",
        recommended: true,
      },
    ]);
    mockResolveSessionCwd.mockResolvedValue("/tmp/stored-session");
    mockUseChatSendMessage.mockImplementationOnce(
      async (options?: {
        ensurePrepared?: (personaId?: string) => Promise<boolean | undefined>;
      }) => {
        await options?.ensurePrepared?.("persona-1");
      },
    );

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handleSend("hello from persona");
    });

    await waitFor(() => {
      expect(mockResolveSessionCwd).toHaveBeenCalledWith(
        null,
        "/tmp/stored-session",
      );
    });
    expectSessionPreparation({
      sessionId: "session-1",
      modelProviderId: "databricks_v2",
      modelId: "goose-claude-opus-4-8",
      workingDir: "/tmp/stored-session",
    });
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-claude-opus-4-8",
      },
    });
  });

  it("leaves the current target alone when a legacy persona model cannot resolve", async () => {
    useAgentStore.setState({
      personas: [
        personaFixture({
          provider: "goose",
          model: "goose-claude-fable-5",
        }),
      ],
    });
    mockPickerState.availableModels = [
      {
        id: "goose-claude-opus-4-8",
        name: "goose-claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        providerId: "databricks_v2",
        recommended: true,
      },
    ];

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
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "gpt-4o",
      },
    });
    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
  });

  it("replaces a user-selected model highlight when selecting a persona with a configured model", async () => {
    useAgentStore.setState({
      personas: [
        personaFixture({
          provider: "goose",
          model: "goose-claude-opus-4-8",
        }),
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
        providerId: "databricks_v2",
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
    expect(result.current.currentModelProviderId).toBe("databricks_v2");
    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      personaId: "persona-1",
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-claude-opus-4-8",
      },
    });
  });

  it("removes the active persona without changing the selected model", async () => {
    useChatSessionStore.getState().replaceSessionExecutionTarget("session-1", {
      harnessId: "goose",
      modelProviderId: "databricks_v2",
      modelId: "goose-gpt-5-6-sol",
      modelName: "GPT-5.6 Sol",
    });
    useChatSessionStore.getState().patchSession("session-1", {
      personaId: "persona-1",
    });
    useAgentStore.setState({
      personas: [
        personaFixture({
          displayName: "Trace",
          systemPrompt: "Debug carefully.",
          provider: "goose",
          model: "goose-claude-fable-5",
        }),
      ],
    });

    const { result } = renderHook(() =>
      useChatSessionController({ sessionId: "session-1" }),
    );

    act(() => {
      result.current.handlePersonaChange(null);
    });

    expect(
      useChatSessionStore.getState().getSession("session-1"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-6-sol",
      },
    });
    expect(
      useChatSessionStore.getState().getSession("session-1")?.personaId,
    ).toBeUndefined();
    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
  });

  it("leaves the current target alone when a persona target cannot resolve", () => {
    useAgentStore.setState({
      personas: [
        personaFixture({
          provider: "missing-provider",
          model: "goose-claude-opus-4-8",
        }),
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
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "gpt-4o",
      },
    });
    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
  });

  it("keeps the Home target when an unresolved persona is selected", async () => {
    useAgentStore.setState({
      personas: [
        personaFixture({
          provider: "missing-provider",
          model: "goose-claude-opus-4-8",
        }),
      ],
    });
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useChatSessionController({ sessionId, isHomeSession: true }),
      { initialProps: { sessionId: null as string | null } },
    );

    act(() => {
      result.current.handlePersonaChange("persona-1");
    });
    useChatSessionStore.setState((state) => ({
      sessions: [
        sessionFixture({
          id: "home-unresolved-persona",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
        }),
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "home-unresolved-persona" });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("home-unresolved-persona"),
      ).toMatchObject({
        personaId: "persona-1",
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
        },
      });
    });
    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
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
        sessionFixture({
          id: "session-2",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "session-2" });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-2",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
      });
    });

    expect(
      useChatSessionStore.getState().getSession("session-2"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
        modelName: "Claude Sonnet 4",
      },
    });
  });

  it("refreshes reasoning effort after a Home model change response omits it", async () => {
    mockAcpPrepareSession
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        model: null,
        reasoningEffort: {
          configId: "thinking_effort",
          currentValue: "high",
          options: [
            { id: "off", name: "Off" },
            { id: "low", name: "Low" },
            { id: "high", name: "High" },
          ],
        },
      });

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
        sessionFixture({
          id: "home-session-model-change",
          title: "Home",
          executionTarget: { harnessId: "goose" },
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "home-session-model-change" });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "home-session-model-change",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
        forceConfigRefresh: true,
      });
    });
    expect(
      useChatSessionStore.getState().getSession("home-session-model-change")
        ?.reasoningEffort,
    ).toMatchObject({
      configId: "thinking_effort",
      currentValue: "high",
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
        useChatStore.getState().enqueueTransportReadyMessage(sessionId, {
          persona: { kind: "inherit" },
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
      useChatStore.getState().queuedMessageBySession.__home_pending__?.[0]
        ?.payload,
    ).toEqual({
      persona: { kind: "inherit" },
      text: "",
      attachments: [imageDraft],
      sendOptions: {
        telemetrySourceSurface: CHAT_SOURCE_SURFACE.GLOBAL_COMPOSER,
      },
    });

    useChatSessionStore.setState((state) => ({
      sessions: [
        sessionFixture({
          id: "session-home-attachments",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "session-home-attachments" });

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession[
          "session-home-attachments"
        ]?.[0]?.payload,
      ).toEqual({
        persona: { kind: "inherit" },
        text: "",
        attachments: [imageDraft],
        // The migrated record keeps its Home-composer surface stamp so a
        // deferred-workspace release still reports where it was accepted.
        sendOptions: {
          telemetrySourceSurface: CHAT_SOURCE_SURFACE.GLOBAL_COMPOSER,
        },
      });
    });
    expect(
      useChatStore.getState().queuedMessageBySession.__home_pending__,
    ).toBeUndefined();
  });

  it("unparks restored Home messages after attaching them to a ready session", async () => {
    useChatStore.setState({
      queuedMessageBySession: {
        __home_pending__: [
          {
            kind: "transport-ready",
            recordId: "restored-home",
            payload: {
              persona: { kind: "inherit" },
              text: "restored from Home",
            },
            restored: true,
          },
        ],
      },
    });
    useChatSessionStore.setState((state) => ({
      sessions: [
        sessionFixture({
          id: "session-restored-home",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
        ...state.sessions,
      ],
    }));

    renderHook(() =>
      useChatSessionController({
        sessionId: "session-restored-home",
        isHomeSession: true,
      }),
    );

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession[
          "session-restored-home"
        ]?.[0],
      ).toMatchObject({
        recordId: "restored-home",
        payload: {
          persona: { kind: "inherit" },
          text: "restored from Home",
        },
      });
    });
    expect(
      useChatStore.getState().queuedMessageBySession[
        "session-restored-home"
      ]?.[0],
    ).not.toHaveProperty("restored");
  });

  it("appends pending Home messages to an occupied destination", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("__home_pending__", {
      persona: { kind: "inherit" },
      text: "queued from Home",
    });
    chatStore.enqueueTransportReadyMessage("__home_pending__", {
      persona: { kind: "inherit" },
      text: "Home follow-up",
    });
    chatStore.enqueueTransportReadyMessage("session-occupied", {
      persona: { kind: "inherit" },
      text: "already queued",
    });
    chatStore.setDraft("__home_pending__", "pending draft");
    const pendingRecord =
      useChatStore.getState().queuedMessageBySession.__home_pending__;
    const destinationRecord =
      useChatStore.getState().queuedMessageBySession["session-occupied"];

    useChatSessionStore.setState((state) => ({
      sessions: [
        sessionFixture({
          id: "session-occupied",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
        ...state.sessions,
      ],
    }));

    renderHook(() =>
      useChatSessionController({
        sessionId: "session-occupied",
        isHomeSession: true,
      }),
    );

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession.__home_pending__,
      ).toBeUndefined();
      expect(
        useChatStore.getState().queuedMessageBySession["session-occupied"],
      ).toEqual([...destinationRecord, ...pendingRecord]);
    });
    expect(useChatStore.getState().draftsBySession["session-occupied"]).toBe(
      "pending draft",
    );
    expect(mockUseChatSendMessage).not.toHaveBeenCalled();
  });

  it("flushes a debounced Home draft before migrating to a real session", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ sessionId }: { sessionId: string | null }) =>
          useChatSessionController({ sessionId, isHomeSession: true }),
        {
          initialProps: { sessionId: null as string | null },
        },
      );

      act(() => {
        result.current.handleDraftChange("home draft");
      });
      expect(
        useChatStore.getState().draftsBySession.__home_pending__,
      ).toBeUndefined();

      act(() => {
        useChatSessionStore.setState((state) => ({
          sessions: [
            sessionFixture({
              id: "session-from-home",
              executionTarget: {
                harnessId: "goose",
                modelProviderId: "openai",
              },
              createdAt: "2026-04-21T00:00:00.000Z",
              updatedAt: "2026-04-21T00:00:00.000Z",
            }),
            ...state.sessions,
          ],
        }));
      });

      rerender({ sessionId: "session-from-home" });

      expect(useChatStore.getState().draftsBySession["session-from-home"]).toBe(
        "home draft",
      );
      expect(
        useChatStore.getState().draftsBySession.__home_pending__,
      ).toBeUndefined();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(
        useChatStore.getState().draftsBySession.__home_pending__,
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
      useChatStore.getState().enqueueTransportReadyMessage("__home_pending__", {
        persona: { kind: "inherit" },
        text: "queued from Home",
        attachments: [queuedImageAttachment],
      });
    });

    useChatSessionStore.setState((state) => ({
      sessions: [
        sessionFixture({
          id: "session-superseded-home",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "session-superseded-home" });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-superseded-home",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
      });
    });

    const latestConfig = transitionSessionTarget({
      sessionId: "session-superseded-home",
      target: {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
        modelName: "Claude Sonnet 4",
      },
      workingDir: "/tmp/other-project",
    });

    firstPrepare.resolve();

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledTimes(1);
    });
    await expect(latestConfig).resolves.toMatchObject({ applied: false });

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession[
          "session-superseded-home"
        ]?.[0]?.payload,
      ).toEqual({
        persona: { kind: "inherit" },
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
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("set model failed"));

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
        sessionFixture({
          id: "session-3",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "session-3" });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-3",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
      });
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-3"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
        },
      });
    });

    expect(
      useChatSessionStore.getState().getSession("session-3"),
    ).not.toMatchObject({
      executionTarget: {
        modelId: "claude-sonnet-4",
        modelName: "Claude Sonnet 4",
      },
    });
    expect(
      window.localStorage.getItem("goose:preferredModelsByAgent"),
    ).toBeNull();
    expect(mockToastError).toHaveBeenCalledWith(
      "Could not switch to Claude Sonnet 4.",
    );
    expect(getModelSelectionIntent("session-3")).toBeUndefined();
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
        sessionFixture({
          id: "session-4",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        }),
        ...state.sessions,
      ],
    }));

    rerender({ sessionId: "session-4" });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-4",
        modelProviderId: "anthropic",
      });
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
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "openai",
      },
    });
    expect(mockToastError).toHaveBeenCalledWith(
      "Could not switch to anthropic. This chat is still using openai.",
    );
    expect(getModelSelectionIntent("session-4")).toBeUndefined();

    consoleError.mockRestore();
  });

  it("does not let a failed Home provider sync roll back a newer model pick", async () => {
    const firstPrepare = deferred<void>();
    mockAcpPrepareSession.mockReturnValueOnce(firstPrepare.promise);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useChatSessionController({ sessionId, isHomeSession: true }),
      { initialProps: { sessionId: null as string | null } },
    );

    act(() => {
      result.current.handleProviderChange("anthropic");
    });
    useChatSessionStore.setState((state) => ({
      sessions: [
        sessionFixture({
          id: "session-home-provider-race",
          title: "Home provider race",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        ...state.sessions,
      ],
    }));
    rerender({ sessionId: "session-home-provider-race" });

    await waitFor(() => {
      expectSessionPreparation({
        sessionId: "session-home-provider-race",
        modelProviderId: "anthropic",
      });
    });
    act(() => {
      result.current.handleModelChange("claude-sonnet-4");
    });
    firstPrepare.reject(new Error("old Home prepare failed"));

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-home-provider-race")
          ?.executionTarget,
      ).toMatchObject({
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-sonnet-4",
      });
    });
    expect(consoleError).not.toHaveBeenCalledWith(
      "Failed to sync pending Home state:",
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  // Regression coverage for the `berd_chat` send-telemetry anchor: both events
  // fire from the user-message-commit callback, so an attempt that fails
  // before committing emits nothing and the queue's automatic retry of the
  // same payload emits exactly once, when it finally commits.
  describe("chat send telemetry", () => {
    type DrainSend = (
      text: string,
      overridePersona?: { id: string | null; name?: string },
      attachments?: ChatAttachmentDraft[],
      sendOptions?: ChatSendOptions,
    ) => boolean | Promise<boolean>;

    // Mimics sendCore's commit contract: the user message is appended to the
    // transcript, then the commit callback fires synchronously.
    function commitUserMessage(
      sessionId: string,
      text: string,
      sendOptions?: ChatSendOptions,
    ) {
      useChatStore.getState().addMessage(sessionId, createUserMessage(text));
      sendOptions?.onUserMessageCommitted?.();
    }

    function latestDrainSend(): DrainSend {
      return latestMessageQueueArgs()[2] as DrainSend;
    }

    function commitOnSendOnce() {
      mockUseChatSendMessage.mockImplementationOnce(
        async (
          options?: { __sessionId?: string },
          text?: string,
          _persona?: unknown,
          _attachments?: unknown,
          sendOptions?: ChatSendOptions,
        ) => {
          commitUserMessage(
            options?.__sessionId ?? "session-1",
            text ?? "",
            sendOptions,
          );
          return true;
        },
      );
    }

    it("emits Session Started and Message Sent once, only at the user-message commit", async () => {
      // Captured for the outer assertions — an expect() inside the async send
      // mock would be swallowed by the queue's void'ed send promise.
      let trackCallsBeforeCommit = -1;
      mockUseChatSendMessage.mockImplementationOnce(
        async (
          options?: { __sessionId?: string },
          text?: string,
          _persona?: unknown,
          _attachments?: unknown,
          sendOptions?: ChatSendOptions,
        ) => {
          trackCallsBeforeCommit =
            mockTrackChatSessionStarted.mock.calls.length +
            mockTrackChatMessageSent.mock.calls.length;
          commitUserMessage(
            options?.__sessionId ?? "session-1",
            text ?? "",
            sendOptions,
          );
          return true;
        },
      );
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      await act(async () => {
        await result.current.handleSend("hello");
      });

      expect(mockUseChatSendMessage).toHaveBeenCalledTimes(1);
      // Nothing fired before the user message was committed.
      expect(trackCallsBeforeCommit).toBe(0);
      expect(mockTrackChatSessionStarted).toHaveBeenCalledTimes(1);
      expect(mockTrackChatSessionStarted).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          sourceSurface: CHAT_SOURCE_SURFACE.MAIN_CHAT,
        }),
      );
      expect(mockTrackChatMessageSent).toHaveBeenCalledTimes(1);
      expect(mockTrackChatMessageSent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          isFirstMessage: true,
        }),
      );
    });

    // The anchor is observation-only by construction: it runs inside the
    // send/steer commit callbacks, so a throwing wrapper contained here can
    // never reject a dispatch the backend already accepted.
    it("contains a throwing telemetry wrapper so a committed send still resolves", async () => {
      mockTrackChatMessageSent.mockImplementationOnce(() => {
        throw new Error("telemetry exploded");
      });
      commitOnSendOnce();
      renderHook(() => useChatSessionController({ sessionId: "session-1" }));
      const drainSend = latestDrainSend();

      let accepted: boolean | undefined;
      await act(async () => {
        accepted = await drainSend("hello");
      });

      expect(accepted).toBe(true);
      expect(mockTrackChatMessageSent).toHaveBeenCalledTimes(1);
    });

    it("emits nothing on a pre-commit failure and once when the automatic retry commits", async () => {
      renderHook(() => useChatSessionController({ sessionId: "session-1" }));
      const drainSend = latestDrainSend();
      const queueCommitMarker = vi.fn();

      // First attempt: preparation/dispatch fails before the user message is
      // committed, so the queue keeps the record for its automatic retry.
      mockUseChatSendMessage.mockImplementationOnce(async () => false);
      await act(async () => {
        await drainSend("hello", undefined, undefined, {
          onUserMessageCommitted: queueCommitMarker,
        });
      });

      expect(mockTrackChatSessionStarted).not.toHaveBeenCalled();
      expect(mockTrackChatMessageSent).not.toHaveBeenCalled();
      expect(queueCommitMarker).not.toHaveBeenCalled();

      // The retry re-dispatches the same payload; this time it commits. No
      // user message committed before it, so it is still the first message.
      commitOnSendOnce();
      await act(async () => {
        await drainSend("hello", undefined, undefined, {
          onUserMessageCommitted: queueCommitMarker,
        });
      });

      expect(mockTrackChatSessionStarted).toHaveBeenCalledTimes(1);
      expect(mockTrackChatMessageSent).toHaveBeenCalledTimes(1);
      expect(mockTrackChatMessageSent).toHaveBeenCalledWith(
        expect.objectContaining({ isFirstMessage: true }),
      );
      // The queue's own commit callback still fires through the telemetry
      // wrapper — it is what stops the queue from retrying a committed send.
      expect(queueCommitMarker).toHaveBeenCalledTimes(1);
    });

    it("emits Message Sent as not-first and no Session Started once a user message exists", async () => {
      useChatStore
        .getState()
        .addMessage("session-1", createUserMessage("earlier message"));
      commitOnSendOnce();
      renderHook(() => useChatSessionController({ sessionId: "session-1" }));
      const drainSend = latestDrainSend();

      await act(async () => {
        await drainSend("follow up");
      });

      expect(mockTrackChatSessionStarted).not.toHaveBeenCalled();
      expect(mockTrackChatMessageSent).toHaveBeenCalledTimes(1);
      expect(mockTrackChatMessageSent).toHaveBeenCalledWith(
        expect.objectContaining({ isFirstMessage: false }),
      );
    });

    // A resumed session replays its history asynchronously and nothing gates
    // sending on that load, so the transcript a commit reads can still be
    // empty for a conversation that started long ago. Those sends must report
    // as follow-ups, not as a brand-new session.
    describe("session history that has not replayed", () => {
      it("emits Message Sent as not-first and no Session Started while the history is still replaying", async () => {
        useChatSessionStore.setState({
          sessions: [sessionFixture({ messageCount: 12 })],
        });
        // The session was just opened: its replay is in flight, so the
        // transcript is empty until the load flushes it.
        useChatStore.getState().setSessionLoading("session-1", true);
        commitOnSendOnce();
        renderHook(() => useChatSessionController({ sessionId: "session-1" }));
        const drainSend = latestDrainSend();

        await act(async () => {
          await drainSend("typed before the transcript landed");
        });

        expect(mockTrackChatSessionStarted).not.toHaveBeenCalled();
        expect(mockTrackChatMessageSent).toHaveBeenCalledTimes(1);
        expect(mockTrackChatMessageSent).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: "session-1",
            isFirstMessage: false,
          }),
        );
      });

      it("emits Message Sent as not-first when a settled load left the session's history unreplayed", async () => {
        // A failed load settles with an empty transcript (its error notice is
        // a system message), so the record's backend count is what remains.
        useChatSessionStore.setState({
          sessions: [sessionFixture({ messageCount: 12 })],
        });
        commitOnSendOnce();
        renderHook(() => useChatSessionController({ sessionId: "session-1" }));
        const drainSend = latestDrainSend();

        await act(async () => {
          await drainSend("typed after a failed load");
        });

        expect(mockTrackChatSessionStarted).not.toHaveBeenCalled();
        expect(mockTrackChatMessageSent).toHaveBeenCalledTimes(1);
        expect(mockTrackChatMessageSent).toHaveBeenCalledWith(
          expect.objectContaining({ isFirstMessage: false }),
        );
      });
    });

    // Steer sends commit a real user message through steerCore, whose commit
    // callback fires only once the backend acknowledges the steer — so both
    // steer paths ride the same anchor as regular sends: a rejected steer
    // emits nothing, an accepted one emits Message Sent exactly once.
    describe("steer sends", () => {
      // Mimics steerCore's commit contract: the acknowledged steer's user
      // message is in the transcript when the commit callback fires.
      function commitOnSteerOnce() {
        mockUseChatSteerMessage.mockImplementationOnce(
          async (
            text?: string,
            _attachments?: unknown,
            sendOptions?: ChatSendOptions,
          ) => {
            useChatStore
              .getState()
              .addMessage("session-1", createUserMessage(text ?? ""));
            sendOptions?.onUserMessageCommitted?.();
            return true;
          },
        );
      }

      it("emits Message Sent once, only at the commit of a steered draft", async () => {
        // Steering happens mid-run, so an earlier user message exists.
        useChatStore
          .getState()
          .addMessage("session-1", createUserMessage("start the run"));
        mockUseChatRuntime.chatState = "streaming";
        let trackCallsBeforeCommit = -1;
        mockUseChatSteerMessage.mockImplementationOnce(
          async (
            text?: string,
            _attachments?: unknown,
            sendOptions?: ChatSendOptions,
          ) => {
            trackCallsBeforeCommit =
              mockTrackChatSessionStarted.mock.calls.length +
              mockTrackChatMessageSent.mock.calls.length;
            useChatStore
              .getState()
              .addMessage("session-1", createUserMessage(text ?? ""));
            sendOptions?.onUserMessageCommitted?.();
            return true;
          },
        );
        const { result } = renderHook(() =>
          useChatSessionController({ sessionId: "session-1" }),
        );

        let accepted: boolean | undefined;
        await act(async () => {
          accepted = await result.current.steerDraftMessage("make it shorter");
        });

        expect(accepted).toBe(true);
        // Nothing fired before the steer was acknowledged and committed.
        expect(trackCallsBeforeCommit).toBe(0);
        expect(mockTrackChatMessageSent).toHaveBeenCalledTimes(1);
        expect(mockTrackChatMessageSent).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: "session-1",
            isFirstMessage: false,
          }),
        );
        expect(mockTrackChatSessionStarted).not.toHaveBeenCalled();
      });

      it("emits nothing for a steered draft rejected before commit", async () => {
        mockUseChatRuntime.chatState = "streaming";
        // A rejected steer rolls its user message back and never invokes the
        // commit callback.
        mockUseChatSteerMessage.mockResolvedValueOnce(false);
        const { result } = renderHook(() =>
          useChatSessionController({ sessionId: "session-1" }),
        );

        let accepted: boolean | undefined;
        await act(async () => {
          accepted = await result.current.steerDraftMessage("make it shorter");
        });

        expect(accepted).toBe(false);
        expect(mockTrackChatSessionStarted).not.toHaveBeenCalled();
        expect(mockTrackChatMessageSent).not.toHaveBeenCalled();
      });

      it("emits Message Sent once for a steered queued message, chaining the record's own commit callback", async () => {
        useChatStore
          .getState()
          .addMessage("session-1", createUserMessage("start the run"));
        const recordCommitMarker = vi.fn();
        const dismiss = vi.fn();
        mockUseMessageQueue.mockImplementation(() => ({
          queuedMessage: {
            text: "queued follow-up",
            attachments: [],
            sendOptions: {
              telemetrySourceSurface: CHAT_SOURCE_SURFACE.MAIN_CHAT,
              onUserMessageCommitted: recordCommitMarker,
            },
          },
          enqueue: vi.fn(),
          dismiss,
        }));
        commitOnSteerOnce();
        const { result } = renderHook(() =>
          useChatSessionController({ sessionId: "session-1" }),
        );

        let accepted: boolean | undefined;
        await act(async () => {
          accepted = await result.current.steerQueuedMessage();
        });

        expect(accepted).toBe(true);
        expect(mockTrackChatMessageSent).toHaveBeenCalledTimes(1);
        expect(mockTrackChatMessageSent).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: "session-1",
            isFirstMessage: false,
          }),
        );
        expect(mockTrackChatSessionStarted).not.toHaveBeenCalled();
        // The payload's own commit callback still fires through the wrapper.
        expect(recordCommitMarker).toHaveBeenCalledTimes(1);
        expect(dismiss).toHaveBeenCalledTimes(1);
      });

      // A throw escaping the anchor here would reject steerQueuedMessage
      // after the backend acknowledged the steer, skipping queue.dismiss() —
      // the already-steered record would then drain again as a duplicate
      // user turn (LAWS/CHAT.md: at most one user turn per message).
      it("dismisses the queued record even when the telemetry wrapper throws at the steer commit", async () => {
        useChatStore
          .getState()
          .addMessage("session-1", createUserMessage("start the run"));
        const dismiss = vi.fn();
        mockUseMessageQueue.mockImplementation(() => ({
          queuedMessage: { text: "queued follow-up" },
          enqueue: vi.fn(),
          dismiss,
        }));
        mockTrackChatMessageSent.mockImplementationOnce(() => {
          throw new Error("telemetry exploded");
        });
        commitOnSteerOnce();
        const { result } = renderHook(() =>
          useChatSessionController({ sessionId: "session-1" }),
        );

        let accepted: boolean | undefined;
        await act(async () => {
          accepted = await result.current.steerQueuedMessage();
        });

        expect(accepted).toBe(true);
        expect(mockTrackChatMessageSent).toHaveBeenCalledTimes(1);
        expect(dismiss).toHaveBeenCalledTimes(1);
      });

      it("emits nothing when a queued-message steer is rejected, keeping the record for the instrumented drain", async () => {
        const dismiss = vi.fn();
        mockUseMessageQueue.mockImplementation(() => ({
          queuedMessage: { text: "queued follow-up" },
          enqueue: vi.fn(),
          dismiss,
        }));
        mockUseChatSteerMessage.mockResolvedValueOnce(false);
        const { result } = renderHook(() =>
          useChatSessionController({ sessionId: "session-1" }),
        );

        let accepted: boolean | undefined;
        await act(async () => {
          accepted = await result.current.steerQueuedMessage();
        });

        expect(accepted).toBe(false);
        expect(mockTrackChatSessionStarted).not.toHaveBeenCalled();
        expect(mockTrackChatMessageSent).not.toHaveBeenCalled();
        expect(dismiss).not.toHaveBeenCalled();
      });
    });

    // Captured payloads carry the surface that accepted them: a queued record
    // can be released to the background queued-send pipeline by the
    // deferred-workspace flow, which cannot recompute this controller's
    // surface, so losing the stamp would silence that send's telemetry.
    describe("captured payload surface stamp", () => {
      function renderWithCapturingQueue(
        options: Parameters<typeof useChatSessionController>[0],
      ) {
        const enqueue = vi.fn();
        mockUseMessageQueue.mockImplementation(() => ({
          queuedMessage: null,
          enqueue,
          dismiss: vi.fn(),
        }));
        const { result } = renderHook(() => useChatSessionController(options));
        return { result, enqueue };
      }

      it("stamps main-chat sends", () => {
        const { result, enqueue } = renderWithCapturingQueue({
          sessionId: "session-1",
        });

        act(() => {
          result.current.handleSend("hello");
        });

        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue.mock.calls[0]?.[3]).toMatchObject({
          telemetrySourceSurface: CHAT_SOURCE_SURFACE.MAIN_CHAT,
        });
      });

      it("stamps Home composer sends as global composer", () => {
        const { result, enqueue } = renderWithCapturingQueue({
          sessionId: null,
          isHomeSession: true,
        });

        act(() => {
          result.current.handleSend("hello");
        });

        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue.mock.calls[0]?.[3]).toMatchObject({
          telemetrySourceSurface: CHAT_SOURCE_SURFACE.GLOBAL_COMPOSER,
        });
      });

      it("stamps builder-session sends as agent builder", () => {
        useChatSessionStore.setState({
          sessions: [
            sessionFixture({
              intent: "build-agent",
              executionTarget: {
                harnessId: "goose",
                modelProviderId: "openai",
                modelId: "gpt-4o",
                modelName: "GPT-4o",
              },
            }),
          ],
        });
        const { result, enqueue } = renderWithCapturingQueue({
          sessionId: "session-1",
        });

        act(() => {
          result.current.handleSend("hello");
        });

        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue.mock.calls[0]?.[3]).toMatchObject({
          telemetrySourceSurface: CHAT_SOURCE_SURFACE.AGENT_BUILDER,
        });
      });
    });
  });

  describe("remote SSH host selection", () => {
    beforeEach(() => {
      mockEnsureRemoteHostConnected.mockReset().mockResolvedValue(undefined);
      setExperimentEnabled(REMOTE_SSH_SESSIONS_EXPERIMENT_ID, true);
    });

    it("is disabled while the experiment is off", () => {
      setExperimentEnabled(REMOTE_SSH_SESSIONS_EXPERIMENT_ID, false);
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      expect(result.current.remoteHostSelectionEnabled).toBe(false);
    });

    it("tracks pending host and dir, and clearing the host resets the dir", () => {
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      expect(result.current.remoteHostSelectionEnabled).toBe(true);
      expect(result.current.selectedRemoteHost).toBeNull();

      act(() => {
        result.current.handleRemoteHostChange("devbox");
      });
      expect(result.current.selectedRemoteHost).toBe("devbox");
      // Remote sessions are project-less: picking a host clears the project.
      expect(result.current.selectedProjectId).toBeNull();
      expect(result.current.selectedRemoteDir).toBeNull();

      act(() => {
        result.current.handleRemoteDirChange("/home/dev/project");
      });
      expect(result.current.selectedRemoteDir).toBe("/home/dev/project");

      act(() => {
        result.current.handleRemoteHostChange(null);
      });
      expect(result.current.selectedRemoteHost).toBeNull();
      expect(result.current.selectedRemoteDir).toBeNull();
    });

    it("is not offered once the session has started", () => {
      useChatStore.setState({
        messagesBySession: {
          "session-1": [createUserMessage("already chatting")],
        },
      });

      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      expect(result.current.remoteHostSelectionEnabled).toBe(false);
    });

    it("blocks a send when a host is selected without a remote directory", async () => {
      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleRemoteHostChange("devbox");
      });

      let accepted: boolean | Promise<boolean> = true;
      act(() => {
        accepted = result.current.handleSend("hello remote");
      });
      expect(await accepted).toBe(false);
      expect(mockAcpCreateSession).not.toHaveBeenCalled();
      expect(mockEnsureRemoteHostConnected).not.toHaveBeenCalled();
    });

    it("routes a send with host and dir into a fresh remote session", async () => {
      mockAcpCreateSession.mockResolvedValue({
        sessionId: "remote-session-1",
        configOptionsSnapshot: undefined,
      });

      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleRemoteHostChange("devbox");
        result.current.handleRemoteDirChange("/home/dev/project");
      });

      let accepted: boolean | Promise<boolean> = false;
      act(() => {
        accepted = result.current.handleSend("hello remote");
      });
      await act(async () => {
        expect(await accepted).toBe(true);
      });

      expect(mockEnsureRemoteHostConnected).toHaveBeenCalledWith("devbox");
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        expect.any(String),
        "/home/dev/project",
        expect.objectContaining({ remoteHost: "devbox" }),
      );
      const created = useChatSessionStore
        .getState()
        .getSession("remote-session-1");
      expect(created?.remoteHost).toBe("devbox");
      expect(created?.workingDir).toBe("/home/dev/project");
      // The original (local) session is left untouched.
      expect(
        useChatSessionStore.getState().getSession("session-1")?.remoteHost,
      ).toBeUndefined();
      expect(useChatSessionStore.getState().activeSessionId).toBe(
        "remote-session-1",
      );
    });

    it("creates exactly one remote session when send fires twice in flight", async () => {
      // ssh connect + session/new take a moment; a re-submit inside that
      // window (double Enter, double click) must not create a second session.
      let releaseConnect: () => void = () => {};
      mockEnsureRemoteHostConnected.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseConnect = resolve;
          }),
      );
      mockAcpCreateSession.mockResolvedValue({
        sessionId: "remote-session-1",
        configOptionsSnapshot: undefined,
      });

      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleRemoteHostChange("devbox");
        result.current.handleRemoteDirChange("/home/dev/project");
      });

      let first: boolean | Promise<boolean> = false;
      let second: boolean | Promise<boolean> = true;
      act(() => {
        first = result.current.handleSend("hello remote");
        second = result.current.handleSend("hello remote");
      });
      await act(async () => {
        releaseConnect();
        expect(await first).toBe(true);
        expect(await second).toBe(false);
      });

      expect(mockAcpCreateSession).toHaveBeenCalledTimes(1);
    });

    it("reports a failed connect and keeps the send unaccepted", async () => {
      mockEnsureRemoteHostConnected.mockRejectedValue({
        kind: "host-unreachable",
        message: "no route to host",
      });

      const { result } = renderHook(() =>
        useChatSessionController({ sessionId: "session-1" }),
      );

      act(() => {
        result.current.handleRemoteHostChange("devbox");
        result.current.handleRemoteDirChange("/home/dev/project");
      });

      let accepted: boolean | Promise<boolean> = true;
      act(() => {
        accepted = result.current.handleSend("hello remote");
      });
      await act(async () => {
        expect(await accepted).toBe(false);
      });

      expect(mockAcpCreateSession).not.toHaveBeenCalled();
      expect(mockToastError).toHaveBeenCalled();
    });
  });
});
