import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { groupSessionsByDate } from "./groupSessionsByDate";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";

function makeSession(
  id: string,
  updatedAt: string,
  lastMessageAt?: string,
): ChatSession {
  return {
    id,
    title: `Session ${id}`,
    createdAt: updatedAt,
    updatedAt,
    lastMessageAt,
    messageCount: 5,
  };
}

describe("groupSessionsByDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("groups sessions into Today, Yesterday, and dated buckets", () => {
    const sessions = [
      makeSession("a", "2026-04-07T10:00:00Z"),
      makeSession("b", "2026-04-07T08:00:00Z"),
      makeSession("c", "2026-04-06T15:00:00Z"),
      makeSession("d", "2026-03-28T12:00:00Z"),
    ];

    const groups = groupSessionsByDate(sessions);

    expect(groups).toHaveLength(3);
    expect(groups[0].label).toBe("Today");
    expect(groups[0].sessions).toHaveLength(2);
    expect(groups[0].sessions[0].id).toBe("a");
    expect(groups[1].label).toBe("Yesterday");
    expect(groups[1].sessions).toHaveLength(1);
    expect(groups[2].label).toBe("March 28, 2026");
    expect(groups[2].sessions).toHaveLength(1);
  });

  it("returns empty array for no sessions", () => {
    expect(groupSessionsByDate([])).toEqual([]);
  });

  it("keeps backend activity order and groups by last message date", () => {
    const sessions = [
      makeSession("active", "2026-03-01T00:00:00Z", "2026-04-07T11:00:00Z"),
      makeSession(
        "metadata-only",
        "2026-04-07T12:00:00Z",
        "2026-04-06T09:00:00Z",
      ),
      makeSession("fallback", "2026-04-07T08:00:00Z"),
    ];

    const groups = groupSessionsByDate(sessions);

    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["active", "fallback"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["metadata-only"]);
  });
});
