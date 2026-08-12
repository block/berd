import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  finishSessionHandoff,
  publishSessionHandoffSnapshot,
} from "@/features/chat/lib/sessionWindowCommands";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";
import { useSessionHandoffSource } from "../useSessionHandoffSource";

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  finishSessionHandoff: vi.fn().mockResolvedValue(undefined),
  publishSessionHandoffSnapshot: vi.fn().mockResolvedValue(undefined),
}));

const textMessage = (id: string, text: string): Message => ({
  id,
  role: "assistant",
  created: 1,
  content: [{ type: "text", text }],
});

function setActiveHandoff(destinationReady = true) {
  useSessionWindowStore.getState().setSnapshot([
    {
      sessionId: "session-1",
      windowLabel: "session:session-1",
      mode: {
        handoff: {
          fromLabel: "main",
          toLabel: "session:session-1",
          destinationReady,
          latestVersion: 0,
          finalVersion: null,
        },
      },
    },
  ]);
}

describe("useSessionHandoffSource", () => {
  beforeEach(() => {
    vi.useRealTimers();
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
    vi.mocked(finishSessionHandoff).mockClear();
    vi.mocked(publishSessionHandoffSnapshot).mockClear();
  });

  it("waits for destination readiness before publishing", async () => {
    setActiveHandoff(false);

    renderHook(() => useSessionHandoffSource({ currentWindowLabel: "main" }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishSessionHandoffSnapshot).not.toHaveBeenCalled();
  });

  it("publishes an immediate snapshot when this window owns a ready handoff", async () => {
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
      expect(publishSessionHandoffSnapshot).toHaveBeenCalledWith("session-1", {
        sessionId: "session-1",
        fromLabel: "main",
        toLabel: "session:session-1",
        messages: [message],
        sessionState: {
          ...INITIAL_SESSION_CHAT_RUNTIME,
          chatState: "streaming",
          streamingMessageId: "m1",
        },
        queuedMessages: [],
      });
    });
  });

  it("coalesces message updates using the latest chat state", async () => {
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
    await waitFor(() =>
      expect(publishSessionHandoffSnapshot).toHaveBeenCalled(),
    );
    vi.mocked(publishSessionHandoffSnapshot).mockClear();

    const nextMessage = textMessage("m2", "still going");
    const latestMessage = textMessage("m3", "latest token");
    act(() => {
      useChatStore.getState().addMessage("session-1", nextMessage);
      useChatStore.getState().addMessage("session-1", latestMessage);
    });

    await waitFor(() => {
      expect(publishSessionHandoffSnapshot).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          messages: [textMessage("m1", "hello"), nextMessage, latestMessage],
        }),
      );
    });
  });

  it("keeps pending coalesced publishes across unrelated registry refreshes", async () => {
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
    await waitFor(() =>
      expect(publishSessionHandoffSnapshot).toHaveBeenCalled(),
    );
    vi.mocked(publishSessionHandoffSnapshot).mockClear();

    const nextMessage = textMessage("m2", "still going");
    act(() => {
      useChatStore.getState().addMessage("session-1", nextMessage);
      useSessionWindowStore.getState().setSnapshot([
        {
          sessionId: "session-1",
          windowLabel: "session:session-1",
          mode: {
            handoff: {
              fromLabel: "main",
              toLabel: "session:session-1",
              destinationReady: true,
              latestVersion: 1,
              finalVersion: null,
            },
          },
        },
        {
          sessionId: "other-session",
          windowLabel: "session:other-session",
          mode: "owned",
        },
      ]);
    });

    await waitFor(() => {
      expect(publishSessionHandoffSnapshot).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          messages: [textMessage("m1", "hello"), nextMessage],
        }),
      );
    });
  });

  it("finishes with a final snapshot when runtime settles idle after live activity", async () => {
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
    await waitFor(() =>
      expect(publishSessionHandoffSnapshot).toHaveBeenCalled(),
    );
    vi.mocked(finishSessionHandoff).mockClear();

    act(() => {
      useChatStore.getState().setStreamingMessageId("session-1", null);
      useChatStore.getState().setChatState("session-1", "idle");
    });

    await waitFor(() => {
      expect(finishSessionHandoff).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          sessionId: "session-1",
          fromLabel: "main",
          toLabel: "session:session-1",
        }),
      );
    });
  });

  it("finishes when a late-attached handoff is already idle", async () => {
    const message = textMessage("m1", "done");
    useChatStore.getState().setMessages("session-1", [message]);
    useChatStore.setState({
      sessionStateById: {
        "session-1": {
          ...INITIAL_SESSION_CHAT_RUNTIME,
          chatState: "idle",
          streamingMessageId: null,
        },
      },
    });
    setActiveHandoff();

    renderHook(() => useSessionHandoffSource({ currentWindowLabel: "main" }));

    await waitFor(() =>
      expect(publishSessionHandoffSnapshot).toHaveBeenCalled(),
    );
    await waitFor(() => {
      expect(finishSessionHandoff).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          sessionId: "session-1",
          fromLabel: "main",
          toLabel: "session:session-1",
          messages: [message],
        }),
      );
    });
  });
});
