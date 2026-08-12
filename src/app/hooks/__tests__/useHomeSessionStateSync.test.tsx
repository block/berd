import { useRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { Message } from "@/shared/types/messages";
import { useHomeSessionStateSync } from "../useHomeSessionStateSync";

function makeSession(id: string): ChatSession {
  return {
    id,
    title: "Home draft",
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:00.000Z",
    messageCount: 0,
  };
}

function makeMessage(id: string): Message {
  return {
    id,
    role: "assistant",
    created: Date.now(),
    content: [{ type: "text", text: "hello" }],
    metadata: { userVisible: true },
  };
}

function ShellHomeSessionProbe({ homeSession }: { homeSession: ChatSession }) {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const homeSessionMessages = useChatStore(
    (state) => state.messagesBySession[homeSession.id],
  );

  useHomeSessionStateSync({
    homeSessionId: homeSession.id,
    homeSession,
    homeSessionMessages,
    hasHydratedSessions: true,
    isLoading: false,
    setHomeSessionId: vi.fn(),
  });

  return <div data-testid="render-count">{renderCountRef.current}</div>;
}

describe("useHomeSessionStateSync", () => {
  beforeEach(() => {
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      skillDraftsBySession: {},
      activeSessionId: null,
      recentMessageSessionIds: [],
      isViewingActiveSession: false,
      isConnected: false,
      loadingSessionIds: new Set(),
      scrollTargetMessageBySession: {},
    });
  });

  it("does not rerender a shell home-session subscriber for unrelated streaming text", () => {
    render(<ShellHomeSessionProbe homeSession={makeSession("home")} />);
    expect(screen.getByTestId("render-count")).toHaveTextContent("1");

    act(() => {
      const store = useChatStore.getState();
      store.setMessages("other", [makeMessage("other-message")]);
      store.setStreamingMessageId("other", "other-message");
      store.appendStreamingText("other", "other-message", " world");
    });

    expect(screen.getByTestId("render-count")).toHaveTextContent("1");
  });
});
