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
import { sendPromptToExistingSessionInBackground } from "./sessionSend";

const mocks = vi.hoisted(() => ({
  acpGetSessionInfo: vi.fn(),
  acpLoadSession: vi.fn(),
  acpPrepareSession: vi.fn(),
  acpSendMessage: vi.fn(),
  acpSetModel: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: (...args: unknown[]) => mocks.acpGetSessionInfo(...args),
  acpLoadSession: (...args: unknown[]) => mocks.acpLoadSession(...args),
  acpPrepareSession: (...args: unknown[]) => mocks.acpPrepareSession(...args),
  acpSendMessage: (...args: unknown[]) => mocks.acpSendMessage(...args),
  acpSetModel: (...args: unknown[]) => mocks.acpSetModel(...args),
}));

const SESSION_ID = "old-monitor-session";

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
          providerId: "goose",
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
    mocks.acpSetModel.mockResolvedValue(undefined);
    mocks.acpSendMessage.mockResolvedValue(undefined);
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
});
