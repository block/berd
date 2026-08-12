import { describe, expect, it } from "vitest";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { Persona } from "@/shared/types/agents";
import { deriveStarterTaskCompletion } from "./starterTaskCompletion";

const session = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: "chat-1",
  title: "Chat",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  messageCount: 0,
  ...overrides,
});
const persona = (overrides: Partial<Persona> = {}): Persona => ({
  id: "agent-1",
  displayName: "Agent",
  systemPrompt: "Help",
  isBuiltin: false,
  writable: true,
  ...overrides,
});

const base = {
  providerReady: false,
  sessionsHydrated: true,
  sessions: [] as ChatSession[],
  messagesBySession: {},
  projectsFetched: true,
  projects: [],
  personasLoaded: true,
  personas: [] as Persona[],
};

describe("deriveStarterTaskCompletion", () => {
  it("derives provider, chat, project, and agent completion", () => {
    expect(
      deriveStarterTaskCompletion({
        ...base,
        providerReady: true,
        sessions: [session({ messageCount: 1 })],
        projects: [{ id: "p", archivedAt: null } as never],
        personas: [persona()],
      }),
    ).toEqual({
      "connect-provider": true,
      "start-chat": true,
      "create-project": true,
      "build-agent": true,
      "add-widget": false,
    });
  });

  it("does not count agent-builder chats or bundled agents", () => {
    const result = deriveStarterTaskCompletion({
      ...base,
      sessions: [session({ intent: "build-agent", messageCount: 2 })],
      personas: [
        persona({ sourceProperties: { metadata: { berdBundled: true } } }),
      ],
    });
    expect(result["start-chat"]).toBe(false);
    expect(result["build-agent"]).toBe(false);
  });

  it("waits for canonical stores to hydrate", () => {
    const result = deriveStarterTaskCompletion({
      ...base,
      sessionsHydrated: false,
      sessions: [session({ messageCount: 1 })],
      projectsFetched: false,
      projects: [{ id: "p", archivedAt: null } as never],
      personasLoaded: false,
      personas: [persona()],
    });
    expect(result["start-chat"]).toBe(false);
    expect(result["create-project"]).toBe(false);
    expect(result["build-agent"]).toBe(false);
  });
});
