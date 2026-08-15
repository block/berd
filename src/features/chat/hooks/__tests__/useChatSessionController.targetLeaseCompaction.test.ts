import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { useChatStore } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { ensureReplayBuffer } from "../replayBuffer";
import { createUserMessage } from "@/shared/types/messages";
import { beginModelSelectionIntent } from "../../model-selection/modelSelectionIntent";
import {
  resetSessionTargetCoordinatorsForTests,
  transitionSessionTarget,
} from "../../lib/sessionTargetCoordinator";

const mockAcpPrepareSession = vi.fn();
const mockAcpLoadSession = vi.fn();
const mockAcpSendMessage = vi.fn();
const mockResolveSessionCwd = vi.fn();
const preparedProviderBySession = new Map<string, string>();
const transportProviders: string[] = [];
let selectedAgentId = "goose";

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
  acpPrepareSession: async (...args: unknown[]) => {
    const result = await mockAcpPrepareSession(...args);
    preparedProviderBySession.set(args[0] as string, args[1] as string);
    return result;
  },
  acpLoadSession: (...args: unknown[]) => mockAcpLoadSession(...args),
  acpSendMessage: (...args: unknown[]) => {
    const provider = preparedProviderBySession.get(args[0] as string);
    if (!provider) throw new Error("transport used an unprepared session");
    transportProviders.push(provider);
    const options = args[2] as
      | { onPromptDispatching?: () => void; onPromptDispatched?: () => void }
      | undefined;
    options?.onPromptDispatching?.();
    options?.onPromptDispatched?.();
    return mockAcpSendMessage(...args);
  },
  acpCancelSession: vi.fn().mockResolvedValue(true),
  acpSetSessionConfigOption: vi.fn(),
  acpCreateSession: vi.fn(),
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
    selectedAgentId,
    pickerAgents: [{ id: "goose", label: "Goose" }],
    availableModels: [],
    getModelsForAgent: () => [],
    modelsLoading: false,
    modelStatusMessage: null,
    handleProviderChange: vi.fn(),
    handleModelChange: vi.fn(),
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
    selectedProvider: "openai",
    setSelectedProvider: vi.fn(),
  }),
}));

vi.mock("@/features/projects/lib/sessionCwdSelection", () => ({
  resolveSessionCwd: (...args: unknown[]) => mockResolveSessionCwd(...args),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listBerdAppSkills: vi.fn().mockResolvedValue([]),
  listGooseSourceSkills: vi.fn().mockResolvedValue([]),
  listSkills: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/features/chat/api/workspaceContext", () => ({
  loadWorkspaceInstructionFiles: vi.fn().mockResolvedValue([]),
}));

import { useChatSessionController } from "../useChatSessionController";
import {
  applyChatSessionConfigOptionsSnapshot,
  registerChatSessionConfigSnapshotHandlers,
} from "../../acp/sessionConfigSnapshotAdapter";

const TARGET_A = {
  harnessId: "goose" as const,
  modelProviderId: "openai",
  modelId: "gpt-4o",
  modelName: "GPT-4o",
};
const TARGET_B = {
  harnessId: "goose" as const,
  modelProviderId: "anthropic",
  modelId: "claude-sonnet-4",
  modelName: "Claude Sonnet 4",
};
const EXTERNAL_TARGET_B = {
  ...TARGET_B,
  modelProviderId: TARGET_A.modelProviderId,
};
const TOKEN_STATE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  accumulatedInput: 8_500,
  accumulatedOutput: 0,
  accumulatedTotal: 8_500,
  contextLimit: 10_000,
  accumulatedCost: null,
};

function queuePrompt(text: string) {
  act(() => {
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      text,
      persona: { kind: "inherit" },
    });
  });
}

function selectB(): ReturnType<typeof transitionSessionTarget> {
  const requestId = `select-b-${Math.random()}`;
  act(() => {
    beginModelSelectionIntent("session-1", {
      requestId,
      target: TARGET_B,
      previousTarget: TARGET_A,
    });
  });
  const applySelection = transitionSessionTarget({
    sessionId: "session-1",
    target: TARGET_B,
    workingDir: "/tmp/project",
    requestId,
  });
  expect(
    useChatSessionStore.getState().getSession("session-1")?.executionTarget,
  ).toEqual(TARGET_A);
  return applySelection;
}

function applyExternalB(reasoningEffort = "high") {
  applyChatSessionConfigOptionsSnapshot(
    "session-1",
    {
      configOptions: [
        {
          id: "model",
          category: "model",
          kind: {
            type: "select",
            currentValue: TARGET_B.modelId,
            options: {
              type: "ungrouped",
              values: [{ value: TARGET_B.modelId, name: TARGET_B.modelName }],
            },
          },
        },
        {
          id: "thinking_effort",
          category: "thought_level",
          kind: {
            type: "select",
            currentValue: reasoningEffort,
            options: {
              type: "ungrouped",
              values: [{ value: reasoningEffort, name: reasoningEffort }],
            },
          },
        },
      ],
    },
    { origin: "notification" },
  );
}

describe("controller/useChat queued target lease during compaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    registerChatSessionConfigSnapshotHandlers();
    preparedProviderBySession.clear();
    transportProviders.length = 0;
    selectedAgentId = "goose";
    mockAcpPrepareSession.mockResolvedValue(undefined);
    mockAcpLoadSession.mockImplementation(async (sessionId: string) => {
      ensureReplayBuffer(sessionId).push(
        createUserMessage("Compacted history"),
      );
    });
    mockAcpSendMessage.mockResolvedValue(undefined);
    mockResolveSessionCwd.mockResolvedValue("/tmp/project");
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
    useChatStore.getState().replaceTokenState("session-1", TOKEN_STATE, true);
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Chat",
          executionTarget: TARGET_A,
          workingDir: "/tmp/project",
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

  it.each([
    { name: "successful", settle: "resolve" },
    { name: "failed", settle: "reject" },
  ] as const)("publishes the deferred external target atom once after $name dispatch settlement", async ({
    settle,
  }) => {
    const compactTransport = deferred();
    const replaceTarget = vi.spyOn(
      useChatSessionStore.getState(),
      "replaceSessionExecutionTarget",
    );
    mockAcpSendMessage.mockImplementationOnce(() => compactTransport.promise);
    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    queuePrompt("queued prompt");
    await waitFor(() =>
      expect(mockAcpSendMessage).toHaveBeenCalledWith(
        "session-1",
        "/compact",
        undefined,
      ),
    );

    act(() => applyExternalB());
    expect(
      useChatSessionStore.getState().getSession("session-1")?.executionTarget,
    ).toEqual(TARGET_A);
    expect(
      useChatSessionStore.getState().getSession("session-1")?.reasoningEffort,
    ).toBeUndefined();

    await act(async () => {
      if (settle === "resolve") {
        compactTransport.resolve();
      } else {
        compactTransport.reject(new Error("transport failed"));
      }
    });

    await waitFor(() =>
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        executionTarget: EXTERNAL_TARGET_B,
        reasoningEffort: { currentValue: "high" },
      }),
    );
    expect(
      replaceTarget.mock.calls.filter(
        (call) => JSON.stringify(call[1]) === JSON.stringify(EXTERNAL_TARGET_B),
      ),
    ).toHaveLength(0);
    expect(
      useChatSessionStore
        .getState()
        .sessions.filter(
          (session) =>
            session.id === "session-1" &&
            session.executionTarget?.modelId === TARGET_B.modelId &&
            session.reasoningEffort?.currentValue === "high",
        ),
    ).toHaveLength(1);
  });

  it("keeps A through compact preparation and send, then applies B once", async () => {
    const compactTransport = deferred();
    const replaceTarget = vi.spyOn(
      useChatSessionStore.getState(),
      "replaceSessionExecutionTarget",
    );
    mockAcpSendMessage.mockImplementationOnce(() => compactTransport.promise);
    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    queuePrompt("queued prompt");
    await waitFor(() =>
      expect(mockAcpSendMessage).toHaveBeenCalledWith(
        "session-1",
        "/compact",
        undefined,
      ),
    );
    const applySelection = selectB();

    await act(async () => compactTransport.resolve());
    await waitFor(() => expect(mockAcpSendMessage).toHaveBeenCalledTimes(2));
    await applySelection;
    await waitFor(() =>
      expect(
        useChatSessionStore.getState().getSession("session-1")?.executionTarget,
      ).toEqual(TARGET_B),
    );

    expect(mockAcpPrepareSession.mock.calls.map((call) => call[1])).toEqual([
      TARGET_A.modelProviderId,
      TARGET_A.modelProviderId,
      TARGET_B.modelProviderId,
    ]);
    expect(
      replaceTarget.mock.calls.filter(
        (call) => JSON.stringify(call[1]) === JSON.stringify(TARGET_B),
      ),
    ).toHaveLength(1);
    expect(transportProviders).toEqual([
      TARGET_A.modelProviderId,
      TARGET_A.modelProviderId,
    ]);
    expect(mockAcpSendMessage.mock.calls[1]?.[1]).toBe("queued prompt");
  });

  it("keeps A through failed compaction, skips prompt transport, then applies B once", async () => {
    const compactTransport = deferred();
    const replaceTarget = vi.spyOn(
      useChatSessionStore.getState(),
      "replaceSessionExecutionTarget",
    );
    mockAcpSendMessage.mockImplementationOnce(() => compactTransport.promise);
    renderHook(() => useChatSessionController({ sessionId: "session-1" }));

    queuePrompt("queued prompt");
    await waitFor(() =>
      expect(mockAcpSendMessage).toHaveBeenCalledWith(
        "session-1",
        "/compact",
        undefined,
      ),
    );
    const applySelection = selectB();

    await act(async () => compactTransport.reject(new Error("compact failed")));
    await applySelection;
    await waitFor(() =>
      expect(
        useChatSessionStore.getState().getSession("session-1")?.executionTarget,
      ).toEqual(TARGET_B),
    );

    expect(mockAcpPrepareSession.mock.calls.map((call) => call[1])).toEqual([
      TARGET_A.modelProviderId,
      TARGET_B.modelProviderId,
    ]);
    expect(
      replaceTarget.mock.calls.filter(
        (call) => JSON.stringify(call[1]) === JSON.stringify(TARGET_B),
      ),
    ).toHaveLength(1);
    expect(transportProviders).toEqual([TARGET_A.modelProviderId]);
    expect(mockAcpSendMessage).toHaveBeenCalledTimes(1);
  });
});
