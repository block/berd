import { describe, expect, it } from "vitest";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { deriveStarterTaskCompletion } from "./starterTaskCompletion";

const session = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: "chat-1",
  title: "Chat",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  messageCount: 0,
  ...overrides,
});
const base = {
  providerReady: false,
  sessionsHydrated: true,
  sessions: [] as ChatSession[],
  messagesBySession: {},
  projectsFetched: true,
  projects: [],
};

describe("deriveStarterTaskCompletion", () => {
  it("derives provider, chat, project, and agent completion", () => {
    expect(
      deriveStarterTaskCompletion({
        ...base,
        providerReady: true,
        sessions: [session({ messageCount: 1 })],
        projects: [{ id: "p", archivedAt: null } as never],
      }),
    ).toEqual({
      "connect-provider": true,
      "start-chat": true,
      "create-project": true,
      "add-widget": false,
    });
  });

  it("does not count agent-builder chats", () => {
    const result = deriveStarterTaskCompletion({
      ...base,
      sessions: [session({ intent: "build-agent", messageCount: 2 })],
    });
    expect(result["start-chat"]).toBe(false);
  });

  it("waits for canonical stores to hydrate", () => {
    const result = deriveStarterTaskCompletion({
      ...base,
      sessionsHydrated: false,
      sessions: [session({ messageCount: 1 })],
      projectsFetched: false,
      projects: [{ id: "p", archivedAt: null } as never],
    });
    expect(result["start-chat"]).toBe(false);
    expect(result["create-project"]).toBe(false);
  });
});
