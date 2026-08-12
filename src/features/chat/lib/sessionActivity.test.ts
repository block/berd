import { describe, expect, it } from "vitest";
import {
  compareSessionsByActivityDesc,
  sessionActivityAt,
  sessionNeedsWindowHandoff,
} from "./sessionActivity";

describe("sessionActivityAt", () => {
  it("uses a valid last message timestamp before updatedAt", () => {
    expect(
      sessionActivityAt({
        lastMessageAt: "2026-06-19T06:59:21.000Z",
        updatedAt: "2026-06-25T00:45:04.000Z",
      }),
    ).toBe("2026-06-19T06:59:21.000Z");
  });

  it("falls back to updatedAt when lastMessageAt is missing, blank, or invalid", () => {
    const updatedAt = "2026-06-25T00:45:04.000Z";

    expect(sessionActivityAt({ updatedAt })).toBe(updatedAt);
    expect(sessionActivityAt({ lastMessageAt: "   ", updatedAt })).toBe(
      updatedAt,
    );
    expect(sessionActivityAt({ lastMessageAt: "unknown", updatedAt })).toBe(
      updatedAt,
    );
  });
});

describe("sessionNeedsWindowHandoff", () => {
  it("includes an idle runtime while its streaming message is still live", () => {
    expect(
      sessionNeedsWindowHandoff({
        chatState: "idle",
        streamingMessageId: "message-1",
      }),
    ).toBe(true);
  });

  it("does not hand off a fully settled idle runtime", () => {
    expect(
      sessionNeedsWindowHandoff({
        chatState: "idle",
        streamingMessageId: null,
      }),
    ).toBe(false);
  });

  it("hands off any running runtime without a streaming id", () => {
    expect(
      sessionNeedsWindowHandoff({
        chatState: "thinking",
        streamingMessageId: null,
      }),
    ).toBe(true);
  });
});

describe("compareSessionsByActivityDesc", () => {
  it("orders invalid lastMessageAt values by the updatedAt fallback", () => {
    const sessions = [
      {
        id: "old-fallback",
        lastMessageAt: "unknown",
        updatedAt: "2026-06-24T00:00:00.000Z",
      },
      {
        id: "new-fallback",
        lastMessageAt: "not a date",
        updatedAt: "2026-06-25T00:00:00.000Z",
      },
    ];

    expect([...sessions].sort(compareSessionsByActivityDesc)).toEqual([
      sessions[1],
      sessions[0],
    ]);
  });
});
