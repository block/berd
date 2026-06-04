import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  emitSessionHandoffComplete,
  emitSessionHandoffSnapshot,
} from "@/features/chat/lib/sessionHandoffEvents";
import { completeSessionHandoff } from "@/features/chat/lib/sessionWindowCommands";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";
import { useSessionHandoffSource } from "../useSessionHandoffSource";

vi.mock("@/features/chat/lib/sessionHandoffEvents", () => ({
  emitSessionHandoffComplete: vi.fn().mockResolvedValue(undefined),
  emitSessionHandoffFailed: vi.fn().mockResolvedValue(undefined),
  emitSessionHandoffSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  completeSessionHandoff: vi.fn().mockResolvedValue(undefined),
}));

const textMessage = (id: string, text: string): Message => ({
  id,
  role: "assistant",
  created: 1,
  content: [{ type: "text", text }],
});

function setActiveHandoff() {
  useSessionWindowStore.getState().setSnapshot([
    {
      sessionId: "session-1",
      windowLabel: "session:session-1",
      mode: {
        handoff: {
          fromLabel: "main",
          toLabel: "session:session-1",
        },
      },
    },
  ]);
}

describe("useSessionHandoffSource", () => {
  beforeEach(() => {
    useSessionWindowStore.getState().setSnapshot([]);
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      activeSessionId: null,
      isViewingActiveSession: false,
      loadingSessionIds: new Set(),
      scrollTargetMessageBySession: {},
    });
    vi.mocked(emitSessionHandoffComplete).mockClear();
    vi.mocked(emitSessionHandoffSnapshot).mockClear();
    vi.mocked(completeSessionHandoff).mockClear();
  });

  it("emits an immediate snapshot when this window owns a handoff", async () => {
    const message = textMessage("m1", "hello");
    useChatStore.getState().setMessages("session-1", [message]);
    useChatStore.setState({
      sessionStateById: {
        "session-1": {
          ...INITIAL_SESSION_CHAT_RUNTIME,
          chatState: "streaming",
          streamingMessageId: "m1",
        },
      },
    });
    setActiveHandoff();

    renderHook(() => useSessionHandoffSource({ currentWindowLabel: "main" }));

    await waitFor(() => {
      expect(emitSessionHandoffSnapshot).toHaveBeenCalledWith(
        "session:session-1",
        {
          sessionId: "session-1",
          fromLabel: "main",
          toLabel: "session:session-1",
          messages: [message],
          sessionState: {
            ...INITIAL_SESSION_CHAT_RUNTIME,
            chatState: "streaming",
            streamingMessageId: "m1",
          },
        },
      );
    });
  });

  it("mirrors message updates while the handoff is active", async () => {
    useChatStore
      .getState()
      .setMessages("session-1", [textMessage("m1", "hello")]);
    useChatStore.setState({
      sessionStateById: {
        "session-1": {
          ...INITIAL_SESSION_CHAT_RUNTIME,
          chatState: "streaming",
          streamingMessageId: "m1",
        },
      },
    });
    setActiveHandoff();
    renderHook(() => useSessionHandoffSource({ currentWindowLabel: "main" }));
    await waitFor(() => expect(emitSessionHandoffSnapshot).toHaveBeenCalled());
    vi.mocked(emitSessionHandoffSnapshot).mockClear();

    const nextMessage = textMessage("m2", "still going");
    act(() => {
      useChatStore.getState().addMessage("session-1", nextMessage);
    });

    await waitFor(() => {
      expect(emitSessionHandoffSnapshot).toHaveBeenCalledWith(
        "session:session-1",
        expect.objectContaining({
          messages: [textMessage("m1", "hello"), nextMessage],
        }),
      );
    });
  });

  it("emits completion and marks the handoff complete when runtime settles idle", async () => {
    useChatStore
      .getState()
      .setMessages("session-1", [textMessage("m1", "done")]);
    useChatStore.setState({
      sessionStateById: {
        "session-1": {
          ...INITIAL_SESSION_CHAT_RUNTIME,
          chatState: "streaming",
          streamingMessageId: "m1",
        },
      },
    });
    setActiveHandoff();
    renderHook(() => useSessionHandoffSource({ currentWindowLabel: "main" }));
    await waitFor(() => expect(emitSessionHandoffSnapshot).toHaveBeenCalled());
    vi.mocked(emitSessionHandoffComplete).mockClear();
    vi.mocked(completeSessionHandoff).mockClear();

    act(() => {
      useChatStore.getState().setStreamingMessageId("session-1", null);
      useChatStore.getState().setChatState("session-1", "idle");
    });

    await waitFor(() => {
      expect(emitSessionHandoffComplete).toHaveBeenCalledWith(
        "session:session-1",
        {
          sessionId: "session-1",
          fromLabel: "main",
          toLabel: "session:session-1",
        },
      );
      expect(completeSessionHandoff).toHaveBeenCalledWith("session-1");
    });
  });
});
