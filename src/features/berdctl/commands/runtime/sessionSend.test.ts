import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearMessageTracking,
  handleSessionNotification,
} from "@/features/chat/acp/acpNotificationHandler";
import { clearBufferedStreamingUpdatesForSession } from "@/features/chat/acp/liveStreamingUpdates";
import { clearReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { createUserMessage, getTextContent } from "@/shared/types/messages";
import {
  acquireSessionDispatchTarget,
  observeSessionTargetModelSnapshot,
  resetSessionTargetCoordinatorsForTests,
  transitionSessionTarget,
} from "@/features/chat/lib/sessionTargetCoordinator";
import { beginModelSelectionIntent } from "@/features/chat/model-selection/modelSelectionIntent";
import {
  sendPromptToExistingSessionInBackground,
  sendQueuedPromptToExistingSessionInBackground,
  SessionDispatchCreationIncompleteError,
} from "./sessionSend";

const mocks = vi.hoisted(() => ({
  acpGetSessionInfo: vi.fn(),
  acpLoadSession: vi.fn(),
  acpPrepareSession: vi.fn(),
  acpSendMessage: vi.fn(),
  preparedProviderBySession: new Map<string, string>(),
  transportProviders: [] as string[],
  resolveSessionCwd: vi.fn(),
  loadWorkspaceInstructionFiles: vi.fn(),
  listSkills: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: (...args: unknown[]) => mocks.acpGetSessionInfo(...args),
  acpLoadSession: (...args: unknown[]) => mocks.acpLoadSession(...args),
  acpPrepareSession: (...args: unknown[]) => {
    const [sessionId, providerId] = args as [string, string];
    return Promise.resolve(mocks.acpPrepareSession(...args)).then((value) => {
      mocks.preparedProviderBySession.set(sessionId, providerId);
      return value;
    });
  },
  acpSendMessage: (...args: unknown[]) => {
    const [sessionId] = args as [string];
    const providerId = mocks.preparedProviderBySession.get(sessionId);
    if (!providerId) throw new Error("transport used an unprepared session");
    mocks.transportProviders.push(providerId);
    const result = mocks.acpSendMessage(...args);
    const options = args[2] as
      | {
          onPromptDispatching?: () => void;
          onPromptDispatched?: () => void;
        }
      | undefined;
    options?.onPromptDispatching?.();
    return Promise.resolve(result).then((value) => {
      options?.onPromptDispatched?.();
      return value;
    });
  },
}));

vi.mock("@/features/chat/api/workspaceContext", () => ({
  loadWorkspaceInstructionFiles: (...args: unknown[]) =>
    mocks.loadWorkspaceInstructionFiles(...args),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listSkills: (...args: unknown[]) => mocks.listSkills(...args),
}));

vi.mock(
  "@/features/projects/lib/sessionCwdSelection",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/projects/lib/sessionCwdSelection")
    >()),
    resolveSessionCwd: (...args: unknown[]) => mocks.resolveSessionCwd(...args),
  }),
);

const SESSION_ID = "old-monitor-session";
const INITIAL_TARGET = {
  harnessId: "goose",
  modelProviderId: "databricks_v2",
  modelId: "goose-gpt-5-5",
  modelName: "GPT-5.5",
} as const;
const UPDATED_TARGET = {
  harnessId: "goose",
  modelProviderId: "databricks_v2",
  modelId: "goose-gpt-5-6-sol",
  modelName: "GPT-5.6 Sol",
} as const;
const UPDATED_TARGET_FROM_ACP = {
  ...UPDATED_TARGET,
  modelName: UPDATED_TARGET.modelId,
} as const;

function beginUpdatedTargetSelection(requestId: string) {
  beginModelSelectionIntent(SESSION_ID, {
    requestId,
    target: UPDATED_TARGET,
    previousTarget: INITIAL_TARGET,
  });
  return transitionSessionTarget({
    sessionId: SESSION_ID,
    target: UPDATED_TARGET,
    workingDir: "/tmp/project",
    requestId,
  });
}

async function emitHistoricalReplay(sessionId: string): Promise<void> {
  await handleSessionNotification({
    sessionId,
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "older prompt" },
      _meta: { goose: { messageId: "historical-user" } },
    },
  } as never);
  await handleSessionNotification({
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "older answer" },
      _meta: { goose: { messageId: "historical-assistant" } },
    },
  } as never);
}

describe("sendPromptToExistingSessionInBackground", () => {
  beforeEach(() => {
    resetSessionTargetCoordinatorsForTests();
    vi.resetAllMocks();
    mocks.preparedProviderBySession.clear();
    mocks.transportProviders.length = 0;
    clearMessageTracking();
    clearReplayBuffer(SESSION_ID);
    clearBufferedStreamingUpdatesForSession(SESSION_ID);
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isViewingActiveSession: false,
      loadingSessionIds: new Set(),
      scrollTargetMessageBySession: {},
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: SESSION_ID,
          title: "Old monitored session",
          executionTarget: INITIAL_TARGET,
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      activeSessionId: null,
      activeWorkspaceBySession: {},
      hasHydratedSessions: true,
    });
    useProjectStore.setState({ projects: [], hasFetchedProjects: true });
    useAgentStore.setState({ personas: [] });

    mocks.acpGetSessionInfo.mockResolvedValue(null);
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpSendMessage.mockResolvedValue(undefined);
    mocks.resolveSessionCwd.mockResolvedValue("/tmp/project");
    mocks.loadWorkspaceInstructionFiles.mockResolvedValue([]);
    mocks.listSkills.mockResolvedValue([]);
  });

  it("buffers a first-load ACP replay before appending a berd-monitor prompt", async () => {
    let sessionWasLoaded = false;
    const replayLoadingStates: boolean[] = [];
    const messageSnapshots: string[][] = [];
    const unsubscribe = useChatStore.subscribe((state, previousState) => {
      if (
        state.messagesBySession[SESSION_ID] ===
        previousState.messagesBySession[SESSION_ID]
      ) {
        return;
      }
      messageSnapshots.push(
        (state.messagesBySession[SESSION_ID] ?? []).map(getTextContent),
      );
    });

    const replayHistory = async (sessionId: string) => {
      replayLoadingStates.push(
        useChatStore.getState().loadingSessionIds.has(sessionId),
      );
      await emitHistoricalReplay(sessionId);
    };
    mocks.acpLoadSession.mockImplementation(async (sessionId: string) => {
      sessionWasLoaded = true;
      await replayHistory(sessionId);
    });
    mocks.acpPrepareSession.mockImplementation(async (sessionId: string) => {
      // This models ACP's real first-preparation behavior. Before the fix,
      // sessions.send reached preparation first, and these history events were
      // therefore classified as live. After the fix, the explicit history load
      // prepares and flushes the session before this point.
      if (!sessionWasLoaded) {
        await replayHistory(sessionId);
      }
    });

    try {
      await sendPromptToExistingSessionInBackground(
        SESSION_ID,
        "new monitor event",
      );
      await vi.waitFor(() => {
        expect(mocks.acpSendMessage).toHaveBeenCalled();
      });
    } finally {
      unsubscribe();
    }

    expect(replayLoadingStates).toEqual([true]);
    expect(messageSnapshots[0]).toEqual(["older prompt", "older answer"]);
    expect(
      useChatStore.getState().messagesBySession[SESSION_ID].map(getTextContent),
    ).toEqual(["older prompt", "older answer", "new monitor event"]);
  });
  it("returns at dispatch for a turn still running past 60 seconds and retains ownership through failure", async () => {
    let failTurn!: (error: Error) => void;
    let signalDispatched!: () => void;
    mocks.acpSendMessage.mockImplementation(
      (...args: unknown[]) =>
        new Promise<void>((_resolve, reject) => {
          failTurn = reject;
          signalDispatched = () => {
            const options = args[2] as {
              onPromptDispatched?: () => void;
            };
            options.onPromptDispatched?.();
          };
        }),
    );

    const send = sendPromptToExistingSessionInBackground(
      SESSION_ID,
      "long-running turn",
      undefined,
      { returnOnDispatch: true },
    );
    await vi.waitFor(() => expect(signalDispatched).toBeTypeOf("function"));

    let commandReturned = false;
    void send.then(() => {
      commandReturned = true;
    });
    signalDispatched();
    await expect(send).resolves.toBeUndefined();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(commandReturned).toBe(true);
    expect(acquireSessionDispatchTarget(SESSION_ID)).toMatchObject({
      status: "contended",
    });

    failTurn(new Error("post-dispatch transport failed"));
    await vi.waitFor(() => {
      const nextLease = acquireSessionDispatchTarget(SESSION_ID);
      expect(nextLease).not.toBeNull();
      nextLease.release?.();
    });
    vi.useRealTimers();
  });

  it("refuses to reach the wire while the target session is still being created", async () => {
    const onUserMessageCommitted = vi.fn();
    useChatSessionStore
      .getState()
      .patchSession(SESSION_ID, { creationState: "pending" });

    await expect(
      sendPromptToExistingSessionInBackground(
        SESSION_ID,
        "cross-session prompt",
        onUserMessageCommitted,
      ),
    ).rejects.toBeInstanceOf(SessionDispatchCreationIncompleteError);

    // The id is renderer-local until promotion, so any wire call would be
    // made against a session the backend never created.
    expect(mocks.acpLoadSession).not.toHaveBeenCalled();
    expect(mocks.acpPrepareSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(onUserMessageCommitted).not.toHaveBeenCalled();
  });

  it("rejects when ACP setup fails before background transport dispatch", async () => {
    const onUserMessageCommitted = vi.fn();
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    mocks.acpSendMessage.mockImplementationOnce(() => {
      throw new Error("ACP setup failed");
    });

    await expect(
      sendPromptToExistingSessionInBackground(
        SESSION_ID,
        "queued monitor event",
        onUserMessageCommitted,
      ),
    ).rejects.toThrow("ACP setup failed");

    expect(onUserMessageCommitted).not.toHaveBeenCalled();
  });

  it("suppresses the session persona when the composer captured no persona", async () => {
    useAgentStore.setState({
      personas: [
        {
          id: "session-reviewer",
          displayName: "Session Reviewer",
          systemPrompt: "Review from the session persona.",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    useChatSessionStore.getState().patchSession(SESSION_ID, {
      personaId: "session-reviewer",
    });
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);

    await sendQueuedPromptToExistingSessionInBackground(SESSION_ID, {
      kind: "transport-ready",
      recordId: "explicit-no-persona",
      payload: {
        text: "send without a persona",
        persona: { kind: "none" },
      },
    });

    expect(mocks.acpSendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      "send without a persona",
      expect.objectContaining({
        personaId: undefined,
        personaName: undefined,
      }),
    );
    expect(
      mocks.acpSendMessage.mock.calls[0]?.[2]?.systemPrompt ?? "",
    ).not.toContain("Review from the session persona.");
  });

  it("inherits the session persona for an uncaptured legacy queue record", async () => {
    useAgentStore.setState({
      personas: [
        {
          id: "session-reviewer",
          displayName: "Session Reviewer",
          systemPrompt: "Review from the session persona.",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    useChatSessionStore.getState().patchSession(SESSION_ID, {
      personaId: "session-reviewer",
    });
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);

    await sendQueuedPromptToExistingSessionInBackground(SESSION_ID, {
      kind: "transport-ready",
      recordId: "legacy-uncaptured-persona",
      payload: {
        text: "inherit the session persona",
        persona: { kind: "inherit" },
      },
    });

    expect(mocks.acpSendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      "inherit the session persona",
      expect.objectContaining({
        personaId: "session-reviewer",
        personaName: "Session Reviewer",
        systemPrompt: expect.stringContaining(
          "Review from the session persona.",
        ),
      }),
    );
  });

  it("uses the deferred message's captured persona name after the persona is renamed", async () => {
    useAgentStore.setState({
      personas: [
        {
          id: "claude-reviewer",
          displayName: "Renamed Reviewer",
          systemPrompt: "Review with Claude.",
          provider: "claude-acp",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, { harnessId: "claude-acp" });

    await sendQueuedPromptToExistingSessionInBackground(SESSION_ID, {
      kind: "transport-ready",
      recordId: "deferred-persona-name",
      releasedFromDeferred: true,
      payload: {
        text: "review this",
        persona: {
          kind: "persona",
          id: "claude-reviewer",
          name: "Original Reviewer",
        },
      },
    });

    expect(mocks.acpSendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      "review this",
      expect.objectContaining({
        personaId: "claude-reviewer",
        personaName: "Original Reviewer",
      }),
    );
  });

  it("replays a captured persona after the persona is deleted", async () => {
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    useChatSessionStore.getState().patchSession(SESSION_ID, {
      personaId: "deleted-reviewer",
    });
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, { harnessId: "claude-acp" });

    await sendQueuedPromptToExistingSessionInBackground(SESSION_ID, {
      kind: "transport-ready",
      recordId: "deferred-deleted-persona",
      releasedFromDeferred: true,
      payload: {
        text: "review this",
        persona: {
          kind: "persona",
          id: "deleted-reviewer",
          name: "Deleted Reviewer",
        },
        sendOptions: {
          executionSystemPrompt: "Captured persona instructions.",
        },
      },
    });

    expect(mocks.acpSendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      "review this",
      expect.objectContaining({
        personaId: "deleted-reviewer",
        personaName: "Deleted Reviewer",
        systemPrompt: "Captured persona instructions.",
      }),
    );
  });

  it("recomposes released deferred workspace context at execution", async () => {
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    mocks.loadWorkspaceInstructionFiles.mockResolvedValue([
      {
        path: "/tmp/project/AGENTS.md",
        workspacePaths: ["/tmp/project"],
        content: "Fresh workspace rules.",
      },
    ]);
    mocks.listSkills.mockResolvedValue([
      {
        name: "fresh-skill",
        description: "Use the fresh workspace skill.",
        fileLocation: "/tmp/project/.agents/skills/fresh-skill/SKILL.md",
        sourceLabel: "Project",
        projectLinks: [{ workingDir: "/tmp/project" }],
      },
    ]);
    useChatSessionStore.getState().patchSession(SESSION_ID, {
      workingDir: "/tmp/project",
    });
    useChatStore
      .getState()
      .setMessages(SESSION_ID, [createUserMessage("existing prompt")]);

    await sendQueuedPromptToExistingSessionInBackground(SESSION_ID, {
      kind: "transport-ready",
      recordId: "released-workspace-send",
      releasedFromDeferred: true,
      payload: {
        text: "use fresh context",
        persona: {
          kind: "persona",
          id: "captured-reviewer",
          name: "Captured Reviewer",
        },
        sendOptions: {
          capturedPersonaSystemPrompt:
            "<active-persona>\nCaptured persona instructions.\n</active-persona>",
          executionSystemPrompt: undefined,
        },
      },
    });

    const systemPrompt = mocks.acpSendMessage.mock.calls[0]?.[2]?.systemPrompt;
    expect(systemPrompt).toContain("Fresh workspace rules.");
    expect(systemPrompt).toContain("fresh-skill");
    expect(systemPrompt).toContain("Captured persona instructions.");
    expect(systemPrompt?.match(/<active-persona>/g)).toHaveLength(1);
    expect(systemPrompt?.match(/<\/active-persona>/g)).toHaveLength(1);
  });

  it("uses the live session target with the deferred message's captured persona", async () => {
    useAgentStore.setState({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "claude-acp", label: "Claude Code" },
      ],
      personas: [
        {
          id: "claude-reviewer",
          displayName: "Claude Reviewer",
          systemPrompt: "Review with Claude.",
          provider: "claude-acp",
          model: "claude-sonnet-4",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    useChatSessionStore.getState().replaceSessionExecutionTarget(SESSION_ID, {
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "claude-sonnet-4",
      modelName: "claude-sonnet-4",
    });
    useChatSessionStore.getState().patchSession(SESSION_ID, {
      personaId: "claude-reviewer",
    });
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);

    await sendQueuedPromptToExistingSessionInBackground(SESSION_ID, {
      kind: "transport-ready",
      recordId: "deferred-global-send",
      releasedFromDeferred: true,
      payload: {
        text: "review this",
        persona: { kind: "persona", id: "claude-reviewer" },
      },
    });

    expect(mocks.acpPrepareSession).toHaveBeenCalledWith(
      SESSION_ID,
      "claude-acp",
      expect.any(String),
      { modelId: "claude-sonnet-4" },
    );
    expect(mocks.acpSendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      "review this",
      expect.objectContaining({
        personaId: "claude-reviewer",
        systemPrompt: expect.stringContaining("Review with Claude."),
      }),
    );
    expect(useChatSessionStore.getState().getSession(SESSION_ID)).toMatchObject(
      {
        executionTarget: {
          harnessId: "claude-acp",
          modelProviderId: "claude-acp",
          modelId: "claude-sonnet-4",
          modelName: "claude-sonnet-4",
        },
      },
    );
  });

  it("does not dispatch queued work while the live session target is unresolved", async () => {
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, undefined);
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    const queuedMessage = {
      kind: "transport-ready",
      recordId: "unresolved-send",
      payload: {
        text: "keep the backend model",
        persona: { kind: "inherit" },
        // Compatibility debris from an older persisted record must not supply
        // execution intent when the authoritative session is unresolved.
        executionTarget: { harnessId: "goose" },
      },
    } as const;

    await expect(
      sendQueuedPromptToExistingSessionInBackground(SESSION_ID, queuedMessage),
    ).rejects.toThrow(
      "Select a model before sending to this unresolved session.",
    );
    expect(mocks.acpPrepareSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
  });

  it("uses the live target selected before attempt and ignores a legacy payload target", async () => {
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, UPDATED_TARGET);
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    const queuedMessage = {
      kind: "transport-ready",
      recordId: "legacy-target-send",
      releasedFromDeferred: true,
      payload: {
        text: "use the selected model",
        persona: { kind: "inherit" },
        executionTarget: INITIAL_TARGET,
      },
    } as const;

    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      queuedMessage,
    );

    expect(mocks.acpPrepareSession.mock.calls.at(-1)).toEqual([
      SESSION_ID,
      UPDATED_TARGET.modelProviderId,
      "/tmp/project",
      { modelId: UPDATED_TARGET.modelId },
    ]);
    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(UPDATED_TARGET);
  });

  it.each([
    ["ACP load", "load"],
    ["pinned session info", "info"],
    ["an observed model snapshot", "snapshot"],
  ] as const)("keeps A through preparation and transport when %s reports divergent B", async (_boundary, source) => {
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        executionTargetSource: "acp" as const,
        ...(source === "info" ? { pinnedLoadState: "loading" as const } : {}),
      })),
    }));
    if (source === "load") {
      mocks.acpLoadSession.mockResolvedValue({
        providerId: UPDATED_TARGET.modelProviderId,
        modelId: UPDATED_TARGET.modelId,
      });
    } else {
      mocks.acpLoadSession.mockResolvedValue(undefined);
    }
    if (source === "info") {
      mocks.acpGetSessionInfo.mockResolvedValue({
        providerId: UPDATED_TARGET.modelProviderId,
        modelId: UPDATED_TARGET.modelId,
        messageCount: 0,
      });
    }
    mocks.acpPrepareSession.mockImplementation(async () => {
      if (source === "snapshot") {
        observeSessionTargetModelSnapshot({
          sessionId: SESSION_ID,
          snapshot: {
            modelId: UPDATED_TARGET.modelId,
            modelName: UPDATED_TARGET.modelName,
          },
          context: {
            origin: "response",
            providerId: UPDATED_TARGET.modelProviderId,
            modelId: UPDATED_TARGET.modelId,
          },
        });
      }
    });

    await sendQueuedPromptToExistingSessionInBackground(SESSION_ID, {
      kind: "transport-ready",
      recordId: `external-${source}`,
      payload: {
        text: "keep the attempt target",
        persona: { kind: "inherit" },
      },
    });

    expect(mocks.acpPrepareSession.mock.calls.at(-1)).toEqual([
      SESSION_ID,
      INITIAL_TARGET.modelProviderId,
      "/tmp/project",
      { modelId: INITIAL_TARGET.modelId },
    ]);
    expect(mocks.transportProviders).toEqual([INITIAL_TARGET.modelProviderId]);
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(source === "snapshot" ? UPDATED_TARGET : UPDATED_TARGET_FROM_ACP);
  });

  it("releases a deferred external target after transport fails", async () => {
    let rejectTransport: ((error: Error) => void) | undefined;
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        executionTargetSource: "acp" as const,
      })),
    }));
    mocks.acpLoadSession.mockResolvedValue({
      providerId: UPDATED_TARGET.modelProviderId,
      modelId: UPDATED_TARGET.modelId,
    });
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    mocks.acpSendMessage.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectTransport = reject;
      }),
    );

    const send = sendPromptToExistingSessionInBackground(
      SESSION_ID,
      "fail after divergent hydration",
    );
    await vi.waitFor(() => {
      expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
    });
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(INITIAL_TARGET);
    rejectTransport?.(new Error("transport failed"));

    await expect(send).rejects.toThrow("transport failed");
    expect(mocks.transportProviders).toEqual([INITIAL_TARGET.modelProviderId]);
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(UPDATED_TARGET_FROM_ACP);
  });

  it("holds the lease from before hydration through transport", async () => {
    const order: string[] = [];
    let resolveLoad: (() => void) | undefined;
    let resolveTransport: (() => void) | undefined;
    mocks.acpLoadSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          order.push("load-start");
          resolveLoad = () => {
            order.push("load-end");
            resolve();
          };
        }),
    );
    mocks.acpPrepareSession.mockImplementationOnce(() => {
      order.push("prepare");
    });
    mocks.acpSendMessage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          order.push("transport");
          resolveTransport = resolve;
        }),
    );

    const send = sendQueuedPromptToExistingSessionInBackground(SESSION_ID, {
      kind: "transport-ready",
      recordId: "load-before-acquire",
      releasedFromDeferred: true,
      payload: {
        text: "resume after hydration",
        persona: { kind: "inherit" },
      },
    });
    await vi.waitFor(() => expect(mocks.acpLoadSession).toHaveBeenCalledOnce());

    // The hydration window must already be contended: a prompt dispatched
    // while `session/load` is in flight has its live turn classified as replay
    // and then discarded when the load replaces the transcript.
    expect(acquireSessionDispatchTarget(SESSION_ID)).toMatchObject({
      status: "contended",
    });

    resolveLoad?.();
    await vi.waitFor(() => expect(mocks.acpSendMessage).toHaveBeenCalledOnce());
    expect(order).toEqual(["load-start", "load-end", "prepare", "transport"]);
    expect(mocks.acpLoadSession).toHaveBeenCalledOnce();
    expect(acquireSessionDispatchTarget(SESSION_ID)).toMatchObject({
      status: "contended",
    });

    resolveTransport?.();
    await send;
    const leaseAfterTransport = acquireSessionDispatchTarget(SESSION_ID);
    expect(leaseAfterTransport).not.toBeNull();
    leaseAfterTransport.release?.();
  });

  it("defers a real model selection during preparation until the attempt settles", async () => {
    let resolvePrepare: (() => void) | undefined;
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePrepare = resolve;
      }),
    );
    const queuedMessage = {
      kind: "transport-ready",
      recordId: "selection-during-prepare",
      payload: {
        text: "finish with the attempt target",
        persona: { kind: "inherit" },
      },
    } as const;

    const send = sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      queuedMessage,
    );
    await vi.waitFor(() => {
      expect(mocks.acpPrepareSession).toHaveBeenCalledTimes(1);
    });

    const applySelection = beginUpdatedTargetSelection(
      "select-updated-during-prepare",
    );
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(INITIAL_TARGET);

    resolvePrepare?.();
    await send;
    await applySelection;

    expect(mocks.acpPrepareSession).toHaveBeenNthCalledWith(
      1,
      SESSION_ID,
      INITIAL_TARGET.modelProviderId,
      "/tmp/project",
      { modelId: INITIAL_TARGET.modelId },
    );
    expect(mocks.acpPrepareSession.mock.calls.at(-1)).toEqual([
      SESSION_ID,
      UPDATED_TARGET.modelProviderId,
      "/tmp/project",
      expect.objectContaining({
        modelId: UPDATED_TARGET.modelId,
        requestId: "select-updated-during-prepare",
      }),
    ]);
    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.transportProviders).toEqual([INITIAL_TARGET.modelProviderId]);
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(UPDATED_TARGET);
  });

  it("keeps the snapshotted target when selection changes while cwd resolves", async () => {
    let resolveCwd: ((workingDir: string) => void) | undefined;
    mocks.resolveSessionCwd.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveCwd = resolve;
      }),
    );
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);

    const send = sendPromptToExistingSessionInBackground(
      SESSION_ID,
      "finish with the attempt target",
    );
    await vi.waitFor(() => {
      expect(mocks.resolveSessionCwd).toHaveBeenCalledTimes(1);
    });
    const applySelection = beginUpdatedTargetSelection(
      "select-updated-during-cwd",
    );
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(INITIAL_TARGET);
    resolveCwd?.("/tmp/project");

    await send;
    await applySelection;

    expect(mocks.acpPrepareSession.mock.calls[0]).toEqual([
      SESSION_ID,
      INITIAL_TARGET.modelProviderId,
      "/tmp/project",
      { modelId: INITIAL_TARGET.modelId },
    ]);
    expect(mocks.acpPrepareSession.mock.calls.at(-1)).toEqual([
      SESSION_ID,
      UPDATED_TARGET.modelProviderId,
      "/tmp/project",
      expect.objectContaining({
        modelId: UPDATED_TARGET.modelId,
        requestId: "select-updated-during-cwd",
      }),
    ]);
    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.transportProviders).toEqual([INITIAL_TARGET.modelProviderId]);
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(UPDATED_TARGET);
  });

  it("releases the attempt and applies a deferred selection after transport fails", async () => {
    let rejectTransport: ((error: Error) => void) | undefined;
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    mocks.acpSendMessage.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectTransport = reject;
      }),
    );

    const send = sendPromptToExistingSessionInBackground(
      SESSION_ID,
      "fail this attempt",
    );
    await vi.waitFor(() => {
      expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
    });
    const applySelection = beginUpdatedTargetSelection(
      "select-updated-before-failure",
    );
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(INITIAL_TARGET);
    rejectTransport?.(new Error("transport failed"));

    await expect(send).rejects.toThrow("transport failed");
    await applySelection;
    expect(mocks.acpSendMessage).toHaveBeenCalledTimes(1);
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(UPDATED_TARGET);
  });
});
