import { beforeEach, describe, expect, it } from "vitest";
import type { AcpSessionInfo } from "@/shared/api/acp";
import {
  acpSessionToChatSession,
  mergeAcpSessionPage,
} from "../acpSessionMapping";
import type { ChatSession } from "../../stores/chatSessionStore";

function makeAcpSession(
  overrides: Partial<AcpSessionInfo> & { sessionId: string },
): AcpSessionInfo {
  const { sessionId, ...rest } = overrides;
  return {
    sessionId,
    title: "ACP Session",
    updatedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastMessageAt: null,
    archivedAt: null,
    userSetName: false,
    messageCount: 1,
    subtitle: null,
    workingDir: null,
    projectId: null,
    providerId: null,
    modelId: null,
    personaId: null,
    ...rest,
  };
}

function makeChatSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "remote-1",
    title: "Remote chat",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    messageCount: 1,
    ...overrides,
  };
}

describe("acpSessionMapping remoteHost", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("tags sessions loaded from a remote backend page", () => {
    const session = acpSessionToChatSession(
      makeAcpSession({ sessionId: "remote-1", workingDir: "/remote/dir" }),
      { remoteHost: "devbox" },
    );

    expect(session.remoteHost).toBe("devbox");
  });

  it("infers the remote host from a composite session id", () => {
    const session = acpSessionToChatSession(
      makeAcpSession({
        sessionId: "ssh:devbox#fork-1",
        workingDir: "/remote/dir",
      }),
    );

    expect(session.remoteHost).toBe("devbox");
  });

  it("leaves locally loaded sessions untagged", () => {
    const session = acpSessionToChatSession(
      makeAcpSession({ sessionId: "local-1" }),
    );

    expect("remoteHost" in session).toBe(false);
  });

  it("keeps an existing remoteHost when the local page reloads the session", () => {
    const existing = makeChatSession({
      id: "remote-1",
      remoteHost: "devbox",
    });

    const merged = mergeAcpSessionPage(
      { sessions: [existing], archiveMutationBySessionId: {} },
      {
        sessions: [makeAcpSession({ sessionId: "remote-1" })],
        nextCursor: null,
      },
      null,
    );

    expect(
      merged.sessions.find((session) => session.id === "remote-1")?.remoteHost,
    ).toBe("devbox");
  });

  it("tags sessions merged from a remote page load", () => {
    const merged = mergeAcpSessionPage(
      { sessions: [], archiveMutationBySessionId: {} },
      {
        sessions: [makeAcpSession({ sessionId: "remote-2" })],
        nextCursor: null,
      },
      null,
      { remoteHost: "devbox" },
    );

    expect(
      merged.sessions.find((session) => session.id === "remote-2")?.remoteHost,
    ).toBe("devbox");
  });
});
