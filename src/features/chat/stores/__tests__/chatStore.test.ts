import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_TOKEN_STATE } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";
import { useChatStore } from "../chatStore";
import { loadCachedDrafts } from "../draftPersistence";
import { loadCachedUnreadSessionIds } from "../unreadPersistence";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    created: Date.now(),
    content: [{ type: "text", text: "hello" }],
    metadata: { userVisible: true },
    ...overrides,
  };
}

function getRuntime(sessionId: string) {
  return useChatStore.getState().getSessionRuntime(sessionId);
}

describe("chatStore", () => {
  beforeEach(() => {
    window.localStorage.removeItem("goose:unread-sessions");
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      nonEmptyDraftSessionIds: new Set(),
      skillDraftsBySession: {},
      draftAttachmentsBySession: {},
      activeSessionId: null,
      recentMessageSessionIds: [],
      isViewingActiveSession: false,
      isConnected: false,
      loadingSessionIds: new Set(),
      scrollTargetMessageBySession: {},
    });
  });

  it("starts with empty messages and no active session", () => {
    const state = useChatStore.getState();
    expect(state.messagesBySession).toEqual({});
    expect(state.sessionStateById).toEqual({});
    expect(state.activeSessionId).toBeNull();
  });

  it("stores messages per session", () => {
    const first = makeMessage({ id: "first" });
    const second = makeMessage({ id: "second" });

    useChatStore.getState().addMessage("s1", first);
    useChatStore.getState().addMessage("s2", second);

    expect(useChatStore.getState().messagesBySession.s1).toEqual([first]);
    expect(useChatStore.getState().messagesBySession.s2).toEqual([second]);
  });

  it("keeps the 10 most recently active message sessions", () => {
    for (let index = 1; index <= 11; index += 1) {
      const sessionId = `s${index}`;
      useChatStore.getState().setActiveSession(sessionId);
      useChatStore
        .getState()
        .setMessages(sessionId, [makeMessage({ id: `message-${index}` })]);
    }

    const messagesBySession = useChatStore.getState().messagesBySession;
    expect(Object.keys(messagesBySession)).toHaveLength(10);
    expect(messagesBySession.s1).toBeUndefined();
    expect(messagesBySession.s2).toHaveLength(1);
    expect(messagesBySession.s11).toHaveLength(1);
  });

  it("refreshes cached sessions on activation so back-and-forth sessions stay warm", () => {
    for (let index = 1; index <= 10; index += 1) {
      const sessionId = `s${index}`;
      useChatStore.getState().setActiveSession(sessionId);
      useChatStore
        .getState()
        .setMessages(sessionId, [makeMessage({ id: `message-${index}` })]);
    }

    useChatStore.getState().setActiveSession("s1");
    useChatStore.getState().setActiveSession("s11");
    useChatStore
      .getState()
      .setMessages("s11", [makeMessage({ id: "message-11" })]);

    const messagesBySession = useChatStore.getState().messagesBySession;
    expect(Object.keys(messagesBySession)).toHaveLength(10);
    expect(messagesBySession.s1).toHaveLength(1);
    expect(messagesBySession.s2).toBeUndefined();
    expect(messagesBySession.s11).toHaveLength(1);
  });

  it("does not evict inactive messages for a running session", () => {
    useChatStore.getState().setActiveSession("running");
    useChatStore
      .getState()
      .setMessages("running", [makeMessage({ id: "running-message" })]);
    useChatStore.getState().setStreamingMessageId("running", "running-message");
    useChatStore.getState().setChatState("running", "streaming");

    for (let index = 1; index <= 11; index += 1) {
      const sessionId = `s${index}`;
      useChatStore.getState().setActiveSession(sessionId);
      useChatStore
        .getState()
        .setMessages(sessionId, [makeMessage({ id: `message-${index}` })]);
    }

    expect(useChatStore.getState().messagesBySession.running).toHaveLength(1);
  });

  it("updates runtime state per session", () => {
    const store = useChatStore.getState();

    store.setChatState("s1", "streaming");
    store.setStreamingMessageId("s1", "stream-1");
    store.updateTokenState("s1", { inputTokens: 12, outputTokens: 8 });

    const runtime = getRuntime("s1");
    expect(runtime.chatState).toBe("streaming");
    expect(runtime.streamingMessageId).toBe("stream-1");
    expect(runtime.tokenState.totalTokens).toBe(20);
    expect(runtime.hasUsageSnapshot).toBe(true);

    expect(getRuntime("s2").chatState).toBe("idle");
    expect(getRuntime("s2").tokenState).toEqual(INITIAL_TOKEN_STATE);
    expect(getRuntime("s2").hasUsageSnapshot).toBe(false);
  });

  it("appends streamed text only within the targeted session", () => {
    const streaming = makeMessage({
      id: "stream-1",
      content: [{ type: "text", text: "" }],
    });

    useChatStore.getState().setMessages("s1", [streaming]);
    useChatStore.getState().setStreamingMessageId("s1", "stream-1");
    useChatStore.getState().updateStreamingText("s1", "Hello");
    useChatStore.getState().updateStreamingText("s1", " world");

    const updated = useChatStore.getState().messagesBySession.s1[0];
    expect(updated.content[0]).toEqual({ type: "text", text: "Hello world" });
    expect(getRuntime("s2").streamingMessageId).toBeNull();
  });

  it("appends streaming text with one logical write and preserves unrelated session arrays", () => {
    const streaming = makeMessage({
      id: "stream-1",
      content: [{ type: "text", text: "Hello" }],
    });
    const other = makeMessage({ id: "other-1" });
    const store = useChatStore.getState();

    store.setActiveSession("s1");
    store.setActiveSessionViewing(true);
    store.setMessages("s1", [streaming]);
    store.setMessages("s2", [other]);
    store.setStreamingMessageId("s1", "stream-1");

    let writeCount = 0;
    const unsubscribe = useChatStore.subscribe(() => {
      writeCount += 1;
    });
    const before = useChatStore.getState();
    const s2Messages = before.messagesBySession.s2;
    const s1Runtime = before.sessionStateById.s1;

    store.appendStreamingText("s1", "stream-1", " world");

    const after = useChatStore.getState();
    expect(after.messagesBySession.s1).not.toBe(before.messagesBySession.s1);
    expect(after.messagesBySession.s2).toBe(s2Messages);
    expect(after.sessionStateById.s1).toBe(s1Runtime);
    expect(after.messagesBySession.s1[0]?.content[0]).toEqual({
      type: "text",
      text: "Hello world",
    });
    expect(writeCount).toBe(1);
    unsubscribe();
  });

  it("does not replace runtime state when appending to the same streaming message", () => {
    const store = useChatStore.getState();
    store.setActiveSession("s1");
    store.setActiveSessionViewing(true);
    store.setMessages("s1", [makeMessage({ id: "assistant-1" })]);
    store.setStreamingMessageId("s1", "assistant-1");

    const beforeRuntime = useChatStore.getState().sessionStateById.s1;
    store.appendStreamingText("s1", "assistant-1", " more");

    expect(useChatStore.getState().sessionStateById.s1).toBe(beforeRuntime);
  });

  it("updates runtime state once when the streaming message id changes", () => {
    const store = useChatStore.getState();
    store.setMessages("s1", [
      makeMessage({ id: "assistant-1", content: [] }),
      makeMessage({ id: "assistant-2", content: [] }),
    ]);
    store.setStreamingMessageId("s1", "assistant-1");

    const beforeRuntime = useChatStore.getState().sessionStateById.s1;
    store.appendStreamingText("s1", "assistant-2", "next");
    const afterRuntime = useChatStore.getState().sessionStateById.s1;

    expect(afterRuntime).not.toBe(beforeRuntime);
    expect(afterRuntime.streamingMessageId).toBe("assistant-2");
    store.appendStreamingText("s1", "assistant-2", " chunk");
    expect(useChatStore.getState().sessionStateById.s1).toBe(afterRuntime);
  });

  it("appends streamed thinking only within the targeted session", () => {
    const streaming = makeMessage({
      id: "stream-1",
      content: [{ type: "text", text: "Visible reply" }],
    });

    useChatStore.getState().setMessages("s1", [streaming]);
    useChatStore.getState().setStreamingMessageId("s1", "stream-1");
    useChatStore.getState().updateStreamingThinking("s1", "Plan");
    useChatStore.getState().updateStreamingThinking("s1", " next step");

    const updated = useChatStore.getState().messagesBySession.s1[0];
    expect(updated.content).toEqual([
      { type: "text", text: "Visible reply" },
      { type: "thinking", text: "Plan next step" },
    ]);
    expect(getRuntime("s2").streamingMessageId).toBeNull();
  });

  it("transitions a session to error without affecting another session", () => {
    const store = useChatStore.getState();

    store.setChatState("s1", "streaming");
    store.setChatState("s2", "thinking");
    store.setError("s1", "boom");

    expect(getRuntime("s1").chatState).toBe("error");
    expect(getRuntime("s1").error).toBe("boom");
    expect(getRuntime("s2").chatState).toBe("thinking");
    expect(getRuntime("s2").error).toBeNull();
  });

  it("returns a parked error session to idle when the error is cleared", () => {
    const store = useChatStore.getState();

    store.setError("s1", "boom");
    expect(getRuntime("s1").chatState).toBe("error");

    store.setError("s1", null);

    expect(getRuntime("s1").chatState).toBe("idle");
    expect(getRuntime("s1").error).toBeNull();
  });

  it("leaves a live chatState untouched when clearing the error", () => {
    const store = useChatStore.getState();

    store.setChatState("s1", "streaming");
    store.setError("s1", null);

    expect(getRuntime("s1").chatState).toBe("streaming");
    expect(getRuntime("s1").error).toBeNull();
  });

  it("promotes all local chat state to a real ACP session id", () => {
    const message = makeMessage({ id: "message-1" });
    const store = useChatStore.getState();

    store.setActiveSession("local-session");
    store.setMessages("local-session", [message]);
    store.setChatState("local-session", "thinking");
    store.setDraft("local-session", "draft text");
    store.setSkillDrafts("local-session", [{ id: "skill-1", name: "Skill" }]);
    const queuedAttachment = {
      id: "queued-attachment-1",
      kind: "file" as const,
      name: "queued-notes.txt",
      path: "/tmp/queued-notes.txt",
    };
    const queuedSendOptions = {
      assistantPrompt: "Use these skills for this request: code-review.",
      displayText: "@Reviewer queued text",
      chips: [
        {
          id: "reviewer",
          label: "Reviewer",
          agentRole: "active" as const,
          type: "agent" as const,
        },
        { label: "code-review", type: "skill" as const },
      ],
    };
    store.setDraftAttachments("local-session", [
      {
        id: "attachment-1",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
      },
    ]);
    store.enqueueMessage("local-session", {
      text: "@Reviewer queued text",
      personaId: "reviewer",
      attachments: [queuedAttachment],
      sendOptions: queuedSendOptions,
    });
    store.setSessionLoading("local-session", true);
    store.setScrollTargetMessage("local-session", "message-1", "query");

    store.promoteSessionId("local-session", "acp-session");

    const state = useChatStore.getState();
    expect(state.activeSessionId).toBe("acp-session");
    expect(state.messagesBySession["acp-session"]).toEqual([message]);
    expect(state.messagesBySession["local-session"]).toBeUndefined();
    expect(state.sessionStateById["acp-session"].chatState).toBe("thinking");
    expect(state.sessionStateById["local-session"]).toBeUndefined();
    expect(state.draftsBySession["acp-session"]).toBe("draft text");
    expect(state.draftsBySession["local-session"]).toBeUndefined();
    expect(state.skillDraftsBySession["acp-session"]).toEqual([
      { id: "skill-1", name: "Skill" },
    ]);
    expect(state.draftAttachmentsBySession["acp-session"]).toEqual([
      {
        id: "attachment-1",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
      },
    ]);
    expect(state.draftAttachmentsBySession["local-session"]).toBeUndefined();
    expect(state.queuedMessageBySession["acp-session"]).toEqual({
      text: "@Reviewer queued text",
      personaId: "reviewer",
      attachments: [queuedAttachment],
      sendOptions: queuedSendOptions,
    });
    expect(state.loadingSessionIds.has("acp-session")).toBe(true);
    expect(state.loadingSessionIds.has("local-session")).toBe(false);
    expect(state.scrollTargetMessageBySession["acp-session"]).toEqual({
      messageId: "message-1",
      query: "query",
    });
  });

  it("marks visible assistant messages unread unless the session is actively viewed", () => {
    const store = useChatStore.getState();

    store.setActiveSession("s1");
    store.setActiveSessionViewing(false);
    store.addMessage(
      "s1",
      makeMessage({ id: "assistant-away", role: "assistant" }),
    );

    expect(getRuntime("s1").hasUnread).toBe(true);

    store.markSessionRead("s1");
    store.setActiveSessionViewing(true);
    store.addMessage(
      "s1",
      makeMessage({ id: "assistant-active", role: "assistant" }),
    );

    expect(getRuntime("s1").hasUnread).toBe(false);

    store.setActiveSession("s2");
    store.setActiveSessionViewing(true);
    store.addMessage("s1", makeMessage({ id: "assistant-inactive" }));

    expect(getRuntime("s1").hasUnread).toBe(true);
  });

  it("marks streamed assistant output unread for inactive sessions", () => {
    const store = useChatStore.getState();

    store.setActiveSession("s2");
    store.setActiveSessionViewing(true);
    store.addMessage(
      "s1",
      makeMessage({
        id: "assistant-1",
        content: [],
        metadata: { userVisible: true, completionStatus: "inProgress" },
      }),
    );
    store.markSessionRead("s1");
    store.setStreamingMessageId("s1", "assistant-1");

    store.updateStreamingText("s1", "Done");

    expect(getRuntime("s1").hasUnread).toBe(true);

    store.markSessionRead("s1");
    store.appendToStreamingMessage("s1", {
      type: "toolRequest",
      id: "tool-1",
      name: "read_file",
      arguments: {},
      status: "in_progress",
    });

    expect(getRuntime("s1").hasUnread).toBe(true);
  });

  it("does not mark streamed assistant output unread for the actively viewed session", () => {
    const store = useChatStore.getState();

    store.setActiveSession("s1");
    store.setActiveSessionViewing(true);
    store.addMessage(
      "s1",
      makeMessage({
        id: "assistant-1",
        content: [],
        metadata: { userVisible: true, completionStatus: "inProgress" },
      }),
    );
    store.setStreamingMessageId("s1", "assistant-1");

    store.updateStreamingText("s1", "Visible here");

    expect(getRuntime("s1").hasUnread).toBe(false);
  });

  it("does not mark user, hidden, or replayed historical messages unread", () => {
    const store = useChatStore.getState();

    store.setActiveSession("s2");
    store.setActiveSessionViewing(true);

    store.addMessage("s1", makeMessage({ id: "user", role: "user" }));
    store.addMessage(
      "s1",
      makeMessage({
        id: "hidden-assistant",
        role: "assistant",
        metadata: { userVisible: false },
      }),
    );
    store.setMessages("s3", [makeMessage({ id: "historical-assistant" })]);

    expect(getRuntime("s1").hasUnread).toBe(false);
    expect(getRuntime("s3").hasUnread).toBe(false);
  });

  it("tracks unread state per session and clears it idempotently", () => {
    const store = useChatStore.getState();

    store.markSessionUnread("s1");
    expect(getRuntime("s1").hasUnread).toBe(true);
    expect(getRuntime("s2").hasUnread).toBe(false);
    expect(loadCachedUnreadSessionIds()).toEqual(["s1"]);

    store.markSessionRead("s1");
    store.markSessionRead("s1");
    expect(getRuntime("s1").hasUnread).toBe(false);
    expect(loadCachedUnreadSessionIds()).toEqual([]);
  });

  it("hydrates persisted unread sessions on store initialization", async () => {
    window.localStorage.setItem(
      "goose:unread-sessions",
      JSON.stringify(["s1", "s2"]),
    );

    vi.resetModules();
    const { useChatStore: freshChatStore } = await import("../chatStore");

    expect(freshChatStore.getState().getSessionRuntime("s1").hasUnread).toBe(
      true,
    );
    expect(freshChatStore.getState().getSessionRuntime("s2").hasUnread).toBe(
      true,
    );
  });

  it("clears messages and runtime state for a single session", () => {
    useChatStore.getState().addMessage("s1", makeMessage());
    useChatStore.getState().setChatState("s1", "streaming");
    useChatStore.getState().setStreamingMessageId("s1", "stream-1");
    useChatStore.getState().markSessionUnread("s1");
    useChatStore.getState().clearMessages("s1");

    expect(useChatStore.getState().messagesBySession.s1).toEqual([]);
    expect(getRuntime("s1").chatState).toBe("idle");
    expect(getRuntime("s1").streamingMessageId).toBeNull();
    expect(getRuntime("s1").hasUnread).toBe(false);
    expect(loadCachedUnreadSessionIds()).toEqual([]);
  });

  it("enqueues and dismisses messages per session", () => {
    const store = useChatStore.getState();

    store.enqueueMessage("s1", { text: "follow up" });
    expect(useChatStore.getState().queuedMessageBySession.s1).toEqual({
      text: "follow up",
    });
    expect(useChatStore.getState().queuedMessageBySession.s2).toBeUndefined();

    store.dismissQueuedMessage("s1");
    expect(useChatStore.getState().queuedMessageBySession.s1).toBeUndefined();
  });

  it("persists and clears draft text per session", () => {
    const store = useChatStore.getState();

    store.setDraft("s1", "hello world");
    expect(useChatStore.getState().draftsBySession.s1).toBe("hello world");
    expect(useChatStore.getState().draftsBySession.s2).toBeUndefined();

    store.clearDraft("s1");
    expect(useChatStore.getState().draftsBySession.s1).toBeUndefined();
  });

  it("stores and clears skill draft chips per session", () => {
    const store = useChatStore.getState();

    store.setSkillDrafts("s1", [{ id: "skill-1", name: "code-review" }]);
    expect(useChatStore.getState().skillDraftsBySession.s1).toEqual([
      { id: "skill-1", name: "code-review" },
    ]);

    store.clearSkillDrafts("s1");
    expect(useChatStore.getState().skillDraftsBySession.s1).toBeUndefined();
  });

  it("stores and clears draft attachments per session", () => {
    const store = useChatStore.getState();
    const attachment = {
      id: "attachment-1",
      kind: "file" as const,
      name: "report.pdf",
      path: "/tmp/report.pdf",
      mimeType: "application/pdf",
    };

    store.setDraftAttachments("s1", [attachment]);
    expect(useChatStore.getState().draftAttachmentsBySession.s1).toEqual([
      attachment,
    ]);
    expect(
      useChatStore.getState().draftAttachmentsBySession.s2,
    ).toBeUndefined();

    store.clearDraftAttachments("s1");
    expect(
      useChatStore.getState().draftAttachmentsBySession.s1,
    ).toBeUndefined();
  });

  it("removes session data during cleanup including queued messages and drafts", () => {
    const store = useChatStore.getState();

    store.addMessage("s1", makeMessage());
    store.setChatState("s1", "streaming");
    store.enqueueMessage("s1", { text: "queued" });
    store.setDraft("s1", "draft text");
    store.setSkillDrafts("s1", [{ id: "skill-1", name: "code-review" }]);
    store.setDraftAttachments("s1", [
      {
        id: "attachment-1",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
      },
    ]);
    store.markSessionUnread("s1");
    store.markSessionUnread("s2");
    store.setActiveSession("s1");
    store.cleanupSession("s1");

    expect(store.messagesBySession.s1).toBeUndefined();
    expect(store.sessionStateById.s1).toBeUndefined();
    expect(store.queuedMessageBySession.s1).toBeUndefined();
    expect(store.draftsBySession.s1).toBeUndefined();
    expect(useChatStore.getState().skillDraftsBySession.s1).toBeUndefined();
    expect(
      useChatStore.getState().draftAttachmentsBySession.s1,
    ).toBeUndefined();
    expect(store.activeSessionId).toBeNull();
    expect(loadCachedUnreadSessionIds()).toEqual(["s2"]);
  });

  it("stores and clears scroll targets per session", () => {
    const store = useChatStore.getState();

    store.setScrollTargetMessage("s1", "message-1", "needle");
    expect(useChatStore.getState().scrollTargetMessageBySession.s1).toEqual({
      messageId: "message-1",
      query: "needle",
    });

    store.clearScrollTargetMessage("s1");
    expect(
      useChatStore.getState().scrollTargetMessageBySession.s1,
    ).toBeUndefined();
  });
});

describe("chatStore draft localStorage persistence", () => {
  const STORAGE_KEY = "goose:chat-drafts";

  beforeEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      nonEmptyDraftSessionIds: new Set(),
      skillDraftsBySession: {},
      draftAttachmentsBySession: {},
      activeSessionId: null,
      recentMessageSessionIds: [],
      isViewingActiveSession: false,
      isConnected: false,
    });
  });

  afterEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
  });

  it("persists non-empty drafts to localStorage on setDraft", () => {
    useChatStore.getState().setDraft("s1", "hello");

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored).toEqual({ s1: "hello" });
  });

  it("removes empty drafts from localStorage", () => {
    useChatStore.getState().setDraft("s1", "hello");
    useChatStore.getState().setDraft("s1", "");

    const stored = window.localStorage.getItem(STORAGE_KEY);
    expect(stored).toBeNull();
  });

  it("removes draft from localStorage on clearDraft", () => {
    useChatStore.getState().setDraft("s1", "hello");
    useChatStore.getState().clearDraft("s1");

    const stored = window.localStorage.getItem(STORAGE_KEY);
    expect(stored).toBeNull();
  });

  it("removes draft from localStorage on cleanupSession", () => {
    useChatStore.getState().setDraft("s1", "hello");
    useChatStore.getState().setDraft("s2", "world");
    useChatStore.getState().cleanupSession("s1");

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored).toEqual({ s2: "world" });
  });

  it("preserves other session drafts when one is cleared", () => {
    useChatStore.getState().setDraft("s1", "hello");
    useChatStore.getState().setDraft("s2", "world");
    useChatStore.getState().clearDraft("s1");

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored).toEqual({ s2: "world" });
  });

  it("ignores malformed cached draft values", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ s1: "hello", s2: null, s3: 42, s4: false }),
    );

    expect(loadCachedDrafts()).toEqual({ s1: "hello" });
  });
});

describe("chatStore session loading state", () => {
  beforeEach(() => {
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      nonEmptyDraftSessionIds: new Set(),
      skillDraftsBySession: {},
      draftAttachmentsBySession: {},
      activeSessionId: null,
      recentMessageSessionIds: [],
      isViewingActiveSession: false,
      isConnected: false,
      loadingSessionIds: new Set<string>(),
    });
  });

  it("starts with empty loadingSessionIds", () => {
    expect(useChatStore.getState().loadingSessionIds.size).toBe(0);
  });

  it("adds session to loadingSessionIds when setSessionLoading(true)", () => {
    useChatStore.getState().setSessionLoading("s1", true);

    expect(useChatStore.getState().loadingSessionIds.has("s1")).toBe(true);
  });

  it("removes session from loadingSessionIds when setSessionLoading(false)", () => {
    useChatStore.getState().setSessionLoading("s1", true);
    useChatStore.getState().setSessionLoading("s1", false);

    expect(useChatStore.getState().loadingSessionIds.has("s1")).toBe(false);
  });

  it("tracks multiple sessions independently", () => {
    useChatStore.getState().setSessionLoading("s1", true);
    useChatStore.getState().setSessionLoading("s2", true);

    expect(useChatStore.getState().loadingSessionIds.has("s1")).toBe(true);
    expect(useChatStore.getState().loadingSessionIds.has("s2")).toBe(true);

    useChatStore.getState().setSessionLoading("s1", false);

    expect(useChatStore.getState().loadingSessionIds.has("s1")).toBe(false);
    expect(useChatStore.getState().loadingSessionIds.has("s2")).toBe(true);
  });

  it("is idempotent for adding the same session", () => {
    useChatStore.getState().setSessionLoading("s1", true);
    useChatStore.getState().setSessionLoading("s1", true);

    expect(useChatStore.getState().loadingSessionIds.size).toBe(1);
  });

  it("is idempotent for removing a non-existent session", () => {
    useChatStore.getState().setSessionLoading("s1", false);

    expect(useChatStore.getState().loadingSessionIds.size).toBe(0);
  });
});
