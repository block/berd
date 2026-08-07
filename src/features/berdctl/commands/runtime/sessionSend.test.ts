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
import { getTextContent } from "@/shared/types/messages";
import {
  sendPromptToExistingSessionInBackground,
  sendQueuedPromptToExistingSessionInBackground,
} from "./sessionSend";

const mocks = vi.hoisted(() => ({
  acpGetSessionInfo: vi.fn(),
  acpLoadSession: vi.fn(),
  acpPrepareSession: vi.fn(),
  acpSendMessage: vi.fn(),
  resolveSessionCwd: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: (...args: unknown[]) => mocks.acpGetSessionInfo(...args),
  acpLoadSession: (...args: unknown[]) => mocks.acpLoadSession(...args),
  acpPrepareSession: (...args: unknown[]) => mocks.acpPrepareSession(...args),
  acpSendMessage: (...args: unknown[]) => mocks.acpSendMessage(...args),
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
    vi.clearAllMocks();
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
          executionTarget: { harnessId: "goose" },
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 2,
        },
      ],
      activeSessionId: null,
      activeWorkspaceBySession: {},
      hasHydratedSessions: true,
    });
    useProjectStore.setState({ projects: [], hasFetchedProjects: true });
    useAgentStore.setState({ personas: [] });

    mocks.acpGetSessionInfo.mockResolvedValue(null);
    mocks.acpSendMessage.mockResolvedValue(undefined);
    mocks.resolveSessionCwd.mockResolvedValue("/tmp/project");
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
  it("uses the deferred message's captured provider and model before dispatch", async () => {
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
        personaId: "claude-reviewer",
        executionTarget: {
          harnessId: "claude-acp",
          modelProviderId: "claude-acp",
          modelId: "claude-sonnet-4",
          modelName: "claude-sonnet-4",
        },
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

  it("does not prepare or dispatch an unresolved queued session", async () => {
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, undefined);
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    const queuedMessage = {
      kind: "transport-ready",
      recordId: "unresolved-send",
      payload: { text: "keep the backend model" },
    } as const;

    await expect(
      sendQueuedPromptToExistingSessionInBackground(SESSION_ID, queuedMessage),
    ).rejects.toThrow(
      "Select a model before sending to this unresolved session.",
    );
    expect(mocks.acpPrepareSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();

    useChatSessionStore.getState().replaceSessionExecutionTarget(SESSION_ID, {
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "gpt-5.6",
      modelName: "GPT-5.6",
    });
    await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      queuedMessage,
    );

    expect(mocks.acpPrepareSession).toHaveBeenCalledWith(
      SESSION_ID,
      "openai",
      "/tmp/project",
      { modelId: "gpt-5.6" },
    );
    expect(mocks.acpSendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      "keep the backend model",
      expect.any(Object),
    );
  });

  it("does not restore a queued target after the UI selects a newer model", async () => {
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, INITIAL_TARGET);
    const queuedMessage = {
      kind: "transport-ready",
      recordId: "deferred-model-send",
      releasedFromDeferred: true,
      payload: {
        text: "keep the selected model",
        executionTarget: INITIAL_TARGET,
      },
    } as const;
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, UPDATED_TARGET);
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);

    await expect(
      sendQueuedPromptToExistingSessionInBackground(SESSION_ID, queuedMessage),
    ).rejects.toThrow(
      "Session preparation was superseded by a newer selection.",
    );

    expect(mocks.acpPrepareSession).not.toHaveBeenCalledWith(
      SESSION_ID,
      INITIAL_TARGET.modelProviderId,
      expect.any(String),
      { modelId: INITIAL_TARGET.modelId },
    );
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(UPDATED_TARGET);
  });

  it("does not restore a queued target after the UI clears its selection", async () => {
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, INITIAL_TARGET);
    const queuedMessage = {
      kind: "transport-ready",
      recordId: "deferred-cleared-model-send",
      releasedFromDeferred: true,
      payload: {
        text: "keep the selection unresolved",
        executionTarget: INITIAL_TARGET,
      },
    } as const;
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, undefined);
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);

    await expect(
      sendQueuedPromptToExistingSessionInBackground(SESSION_ID, queuedMessage),
    ).rejects.toThrow(
      "Session preparation was superseded by a newer selection.",
    );

    expect(mocks.acpPrepareSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(useChatSessionStore.getState().getSession(SESSION_ID)).toMatchObject(
      {
        executionTarget: undefined,
        executionTargetSource: "ui",
      },
    );
  });

  it("uses the latest UI target after background preparation yields", async () => {
    let resolveCwd: ((workingDir: string) => void) | undefined;
    mocks.resolveSessionCwd.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveCwd = resolve;
      }),
    );
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockResolvedValue(undefined);
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, INITIAL_TARGET);

    const send = sendPromptToExistingSessionInBackground(
      SESSION_ID,
      "use the latest model",
    );
    await vi.waitFor(() => {
      expect(mocks.resolveSessionCwd).toHaveBeenCalledTimes(1);
    });
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, UPDATED_TARGET);
    resolveCwd?.("/tmp/project");

    await send;

    expect(mocks.acpPrepareSession.mock.calls.at(-1)).toEqual([
      SESSION_ID,
      "databricks_v2",
      "/tmp/project",
      { modelId: "goose-gpt-5-6-sol" },
    ]);
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(UPDATED_TARGET);
  });

  it("does not commit a stale target when the UI changes during preparation", async () => {
    let resolvePrepare: (() => void) | undefined;
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolvePrepare = resolve;
        }),
      );
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, INITIAL_TARGET);

    const send = sendPromptToExistingSessionInBackground(
      SESSION_ID,
      "keep the newer model",
    );
    await vi.waitFor(() => {
      expect(mocks.acpPrepareSession).toHaveBeenCalledTimes(2);
    });
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, UPDATED_TARGET);
    resolvePrepare?.();

    await expect(send).rejects.toThrow(
      "Session preparation was superseded by a newer selection.",
    );
    expect(
      useChatSessionStore.getState().getSession(SESSION_ID)?.executionTarget,
    ).toEqual(UPDATED_TARGET);
  });

  it("does not commit a queued target when the UI clears during preparation", async () => {
    let resolvePrepare: (() => void) | undefined;
    mocks.acpLoadSession.mockResolvedValue(undefined);
    mocks.acpPrepareSession.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePrepare = resolve;
      }),
    );
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, INITIAL_TARGET);
    const queuedMessage = {
      kind: "transport-ready",
      recordId: "deferred-cleared-during-prepare",
      releasedFromDeferred: true,
      payload: {
        text: "do not restore the queued model",
        executionTarget: INITIAL_TARGET,
      },
    } as const;

    const send = sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      queuedMessage,
    );
    await vi.waitFor(() => {
      expect(mocks.acpPrepareSession).toHaveBeenCalledTimes(1);
    });
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget(SESSION_ID, undefined);
    resolvePrepare?.();

    await expect(send).rejects.toThrow(
      "Session preparation was superseded by a newer selection.",
    );
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(useChatSessionStore.getState().getSession(SESSION_ID)).toMatchObject(
      {
        executionTarget: undefined,
        executionTargetSource: "ui",
      },
    );
  });
});
