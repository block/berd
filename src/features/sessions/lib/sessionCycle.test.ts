import { describe, expect, it } from "vitest";

import {
  getSessionCycleProjectScope,
  resolveSessionCycleTarget,
  scopeSessionCycleCandidates,
  type CycleSession,
} from "./sessionCycle";

function session(
  id: string,
  updatedAt: string,
  lastMessageAt?: string,
): CycleSession {
  return { id, updatedAt, lastMessageAt };
}

// Recency order: a (newest) → b → c (oldest).
const sessions = [
  session("b", "2026-07-08T10:00:00.000Z"),
  session("a", "2026-07-08T12:00:00.000Z"),
  session("c", "2026-07-08T08:00:00.000Z"),
];

describe("getSessionCycleProjectScope", () => {
  it("uses the active project only in refreshed navigation", () => {
    const projectSession = { ...sessions[0], projectId: "project-a" };
    expect(getSessionCycleProjectScope(projectSession, true)).toBe("project-a");
    expect(getSessionCycleProjectScope(projectSession, false)).toBeUndefined();
  });

  it("uses the loose chats context for an unprojected session", () => {
    expect(getSessionCycleProjectScope(sessions[0], true)).toBeNull();
  });

  it("does not scope when no session is active", () => {
    expect(getSessionCycleProjectScope(null, true)).toBeUndefined();
  });
});

describe("scopeSessionCycleCandidates", () => {
  const projectSessions: CycleSession[] = [
    { ...sessions[0], projectId: "project-a" },
    { ...sessions[1], projectId: "project-b" },
    { ...sessions[2], projectId: null },
  ];

  it("keeps all sessions when there is no project context", () => {
    expect(scopeSessionCycleCandidates(projectSessions, undefined)).toEqual(
      projectSessions,
    );
  });

  it("keeps cycling inside the active project", () => {
    expect(scopeSessionCycleCandidates(projectSessions, "project-a")).toEqual([
      projectSessions[0],
    ]);
  });

  it("keeps cycling inside loose chats when that is the active context", () => {
    expect(scopeSessionCycleCandidates(projectSessions, null)).toEqual([
      projectSessions[2],
    ]);
  });
});

describe("resolveSessionCycleTarget", () => {
  it("moves to the next most recent session and wraps at the end", () => {
    expect(resolveSessionCycleTarget(sessions, "a", 1)).toBe("b");
    expect(resolveSessionCycleTarget(sessions, "b", 1)).toBe("c");
    expect(resolveSessionCycleTarget(sessions, "c", 1)).toBe("a");
  });

  it("moves backward and wraps at the start", () => {
    expect(resolveSessionCycleTarget(sessions, "c", -1)).toBe("b");
    expect(resolveSessionCycleTarget(sessions, "b", -1)).toBe("a");
    expect(resolveSessionCycleTarget(sessions, "a", -1)).toBe("c");
  });

  it("enters at the most recent session when none is active", () => {
    expect(resolveSessionCycleTarget(sessions, null, 1)).toBe("a");
    expect(resolveSessionCycleTarget(sessions, null, -1)).toBe("a");
    expect(resolveSessionCycleTarget(sessions, "not-in-list", 1)).toBe("a");
  });

  it("prefers lastMessageAt over updatedAt for recency", () => {
    const withMessageActivity = [
      session(
        "stale-update",
        "2026-07-08T06:00:00.000Z",
        "2026-07-08T13:00:00.000Z",
      ),
      ...sessions,
    ];
    expect(resolveSessionCycleTarget(withMessageActivity, null, 1)).toBe(
      "stale-update",
    );
    expect(resolveSessionCycleTarget(withMessageActivity, "a", -1)).toBe(
      "stale-update",
    );
  });

  it("returns null with no candidates or only the active session", () => {
    expect(resolveSessionCycleTarget([], null, 1)).toBeNull();
    expect(resolveSessionCycleTarget([sessions[0]], "b", 1)).toBeNull();
  });

  it("returns the single candidate when it is not active", () => {
    expect(resolveSessionCycleTarget([sessions[0]], null, 1)).toBe("b");
  });

  it("preserves an explicit sidebar order", () => {
    expect(
      resolveSessionCycleTarget(sessions, "b", 1, { preserveOrder: true }),
    ).toBe("a");
    expect(
      resolveSessionCycleTarget(sessions, "b", -1, { preserveOrder: true }),
    ).toBe("c");
  });
});
