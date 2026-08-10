import { describe, expect, it } from "vitest";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import {
  getAutoArchiveSessionCandidates,
  getPinnedChatSessionIds,
} from "./autoArchiveSessions";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function session(
  id: string,
  activityAt: string,
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id,
    title: id,
    createdAt: activityAt,
    updatedAt: activityAt,
    lastMessageAt: activityAt,
    messageCount: 1,
    ...overrides,
  };
}

describe("getPinnedChatSessionIds", () => {
  it("returns only valid chat pin session ids", () => {
    expect(
      getPinnedChatSessionIds([
        { type: "chatPin", state: { sessionId: "pinned" } },
        { type: "chatPin", state: {} },
        { type: "projectArtifactPin", state: { sessionId: "not-a-chat" } },
      ]),
    ).toEqual(new Set(["pinned"]));
  });
});

describe("getAutoArchiveSessionCandidates", () => {
  it("selects stale unpinned chats and uses last message activity", () => {
    const sessions = [
      session("stale", "2026-08-02T12:00:00.000Z"),
      session("recent-message", "2026-08-09T12:00:00.000Z", {
        updatedAt: "2026-08-01T12:00:00.000Z",
      }),
      session("pinned", "2026-08-01T12:00:00.000Z"),
      session("archived", "2026-08-01T12:00:00.000Z", {
        archivedAt: "2026-08-05T12:00:00.000Z",
      }),
      session("draft", "2026-08-01T12:00:00.000Z", {
        creationState: "pending",
      }),
    ];

    expect(
      getAutoArchiveSessionCandidates({
        sessions,
        homeWidgets: [{ type: "chatPin", state: { sessionId: "pinned" } }],
        afterMs: 7 * DAY_MS,
        nowMs: NOW,
      }).map((candidate) => candidate.id),
    ).toEqual(["stale"]);
  });

  it("is disabled when no duration is configured", () => {
    expect(
      getAutoArchiveSessionCandidates({
        sessions: [session("stale", "2026-01-01T00:00:00.000Z")],
        homeWidgets: [],
        afterMs: null,
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("ignores malformed activity timestamps", () => {
    expect(
      getAutoArchiveSessionCandidates({
        sessions: [session("bad-date", "not-a-date")],
        homeWidgets: [],
        afterMs: DAY_MS,
        nowMs: NOW,
      }),
    ).toEqual([]);
  });
});
