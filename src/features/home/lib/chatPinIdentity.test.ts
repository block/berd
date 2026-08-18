import { beforeEach, describe, expect, it } from "vitest";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { resolveChatPinIdentity } from "./chatPinIdentity";

function session(
  overrides: Partial<ChatSession> & { id: string },
): ChatSession {
  return {
    title: "Chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useChatSessionStore.setState({ sessions: [] });
});

describe("resolveChatPinIdentity", () => {
  it("resolves a session the store does not know to itself", () => {
    // The ids are the caller's own, echoed back: there is no session record
    // behind them, so no promotion can change them.
    expect(resolveChatPinIdentity("session-1")).toEqual({
      keyId: "session-1",
      matchIds: ["session-1"],
    });
  });

  it("resolves a draft whose backend session is still being created to itself", () => {
    useChatSessionStore.setState({
      sessions: [
        session({
          id: "draft-1",
          clientSessionId: "draft-1",
          creationState: "pending",
        }),
      ],
    });

    expect(resolveChatPinIdentity("draft-1")).toEqual({
      keyId: "draft-1",
      matchIds: ["draft-1"],
    });
  });

  it("resolves a promoted session by the draft id its pin still carries", () => {
    useChatSessionStore.setState({
      sessions: [session({ id: "backend-1", clientSessionId: "draft-1" })],
    });

    expect(resolveChatPinIdentity("draft-1")).toEqual({
      keyId: "draft-1",
      matchIds: ["draft-1", "backend-1"],
    });
  });

  it("keys a promoted session the same way whichever id the pin carries", () => {
    useChatSessionStore.setState({
      sessions: [session({ id: "backend-1", clientSessionId: "draft-1" })],
    });

    expect(resolveChatPinIdentity("backend-1")).toEqual({
      keyId: "draft-1",
      matchIds: ["backend-1", "draft-1"],
    });
  });

  it("resolves a session that never was a draft to itself", () => {
    useChatSessionStore.setState({
      sessions: [session({ id: "session-1", messageCount: 12 })],
    });

    expect(resolveChatPinIdentity("session-1")).toEqual({
      keyId: "session-1",
      matchIds: ["session-1"],
    });
  });
});
