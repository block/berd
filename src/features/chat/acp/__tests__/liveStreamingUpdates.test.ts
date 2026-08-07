import { beforeEach, describe, expect, it } from "vitest";
import {
  clearBufferedStreamingUpdatesForSession,
  clearLiveSubtitleUpdate,
  clearStreamingMessageOwners,
  enqueueStreamingTextUpdate,
  enqueueStreamingThinkingUpdate,
  flushAllBufferedStreamingUpdates,
  flushBufferedStreamingUpdatesForSession,
  flushLiveSubtitleUpdate,
  scheduleLiveSubtitleUpdate,
} from "../liveStreamingUpdates";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { claimSessionPrompt } from "@/features/chat/lib/sessionPromptOwnership";
import type { Message } from "@/shared/types/messages";

const sessionId = "acp-session";

function seedSession(): ChatSession {
  return {
    id: sessionId,
    title: "Test Session",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 0,
  };
}

function makeAssistantMessage(id = "assistant-1"): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [],
    metadata: { userVisible: true, completionStatus: "inProgress" },
  };
}

describe("liveStreamingUpdates", () => {
  beforeEach(() => {
    clearLiveSubtitleUpdate(sessionId);
    clearStreamingMessageOwners();
    clearBufferedStreamingUpdatesForSession(sessionId);
    useChatStore.setState({ messagesBySession: {}, sessionStateById: {} });
    useChatSessionStore.setState({
      sessions: [seedSession()],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
    });
  });

  it("does not republish a previous turn subtitle after subtitle state is cleared", () => {
    scheduleLiveSubtitleUpdate(sessionId, "old assistant subtitle");
    expect(useChatSessionStore.getState().getSession(sessionId)?.subtitle).toBe(
      "old assistant subtitle",
    );

    clearLiveSubtitleUpdate(sessionId);
    useChatSessionStore
      .getState()
      .updateSessionSubtitleFromText(sessionId, "new user prompt");

    flushLiveSubtitleUpdate(sessionId);

    expect(useChatSessionStore.getState().getSession(sessionId)?.subtitle).toBe(
      "new user prompt",
    );
  });

  it("consumes pending subtitle state when flushing a completed turn", () => {
    scheduleLiveSubtitleUpdate(sessionId, "completed assistant subtitle");
    flushLiveSubtitleUpdate(sessionId);
    expect(useChatSessionStore.getState().getSession(sessionId)?.subtitle).toBe(
      "completed assistant subtitle",
    );

    useChatSessionStore
      .getState()
      .updateSessionSubtitleFromText(sessionId, "next user prompt");

    flushLiveSubtitleUpdate(sessionId);

    expect(useChatSessionStore.getState().getSession(sessionId)?.subtitle).toBe(
      "next user prompt",
    );
  });

  it("applies interleaved streaming updates in one store write", () => {
    claimSessionPrompt(sessionId);
    useChatStore.getState().setMessages(sessionId, [makeAssistantMessage()]);
    useChatStore.getState().setStreamingMessageId(sessionId, "assistant-1");

    let storeWrites = 0;
    const unsubscribe = useChatStore.subscribe(() => {
      storeWrites += 1;
    });

    enqueueStreamingThinkingUpdate(sessionId, "assistant-1", "thinking");
    enqueueStreamingThinkingUpdate(
      sessionId,
      "assistant-1",
      "thinking through",
    );
    enqueueStreamingThinkingUpdate(
      sessionId,
      "assistant-1",
      "thinking through",
    );
    enqueueStreamingThinkingUpdate(sessionId, "assistant-1", " it");
    enqueueStreamingTextUpdate(sessionId, "assistant-1", "hello ");
    enqueueStreamingTextUpdate(sessionId, "assistant-1", "world");
    flushAllBufferedStreamingUpdates();
    unsubscribe();

    expect(storeWrites).toBe(1);
    expect(
      useChatStore.getState().messagesBySession[sessionId]?.[0]?.content,
    ).toEqual([
      { type: "thinking", text: "thinking through it" },
      { type: "text", text: "hello world" },
    ]);
  });

  it("batches stale-owner updates without moving the current stream", () => {
    const staleOwner = claimSessionPrompt(sessionId);
    useChatStore
      .getState()
      .setMessages(sessionId, [
        makeAssistantMessage("assistant-1"),
        makeAssistantMessage("assistant-2"),
      ]);
    useChatStore.getState().setStreamingMessageId(sessionId, "assistant-1");
    enqueueStreamingThinkingUpdate(sessionId, "assistant-1", "old thought");
    enqueueStreamingTextUpdate(sessionId, "assistant-1", "old text");

    claimSessionPrompt(sessionId);
    useChatStore.getState().setStreamingMessageId(sessionId, "assistant-2");

    let storeWrites = 0;
    const unsubscribe = useChatStore.subscribe(() => {
      storeWrites += 1;
    });
    flushBufferedStreamingUpdatesForSession(sessionId, {
      owner: staleOwner,
    });
    unsubscribe();

    expect(storeWrites).toBe(1);
    expect(
      useChatStore.getState().messagesBySession[sessionId]?.[0]?.content,
    ).toEqual([
      { type: "thinking", text: "old thought" },
      { type: "text", text: "old text" },
    ]);
    expect(
      useChatStore.getState().getSessionRuntime(sessionId).streamingMessageId,
    ).toBe("assistant-2");
    expect(useChatStore.getState().getSessionRuntime(sessionId).hasUnread).toBe(
      true,
    );
    expect(useChatSessionStore.getState().getSession(sessionId)?.subtitle).toBe(
      undefined,
    );
  });

  it("publishes the subtitle from the last text update in a session", () => {
    claimSessionPrompt(sessionId);
    useChatStore
      .getState()
      .setMessages(sessionId, [
        makeAssistantMessage("assistant-1"),
        makeAssistantMessage("assistant-2"),
      ]);

    enqueueStreamingTextUpdate(sessionId, "assistant-1", "first ");
    enqueueStreamingTextUpdate(sessionId, "assistant-2", "second");
    enqueueStreamingTextUpdate(sessionId, "assistant-1", "latest");
    flushAllBufferedStreamingUpdates();

    expect(useChatSessionStore.getState().getSession(sessionId)?.subtitle).toBe(
      "first latest",
    );
  });
});
