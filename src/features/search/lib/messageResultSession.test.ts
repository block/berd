import { describe, expect, it } from "vitest";
import type { MessageSearchResult } from "@/shared/api/messageSearch";
import { messageResultSession } from "./messageResultSession";

const result: MessageSearchResult = {
  sessionId: "session",
  title: "Archive",
  archivedAt: "2026-04-12T12:00:00Z",
  workingDir: "",
  updatedAt: "2026-04-12T12:00:00Z",
  messageCreatedAt: "2026-04-10T12:00:00Z",
  messageId: "message",
  messageIndex: 4,
  role: "user",
  snippet: "keyword",
  matchCount: 1,
};
describe("message result session hydration", () => {
  it("retains archive state and derives remote ownership outside the sidebar", () => {
    expect(
      messageResultSession({ ...result, sessionId: "ssh:example#session" }, []),
    ).toMatchObject({
      archivedAt: result.archivedAt,
      remoteHost: "example",
      id: "ssh:example#session",
    });
  });
  it("uses visible message activity rather than a later metadata edit", () => {
    expect(
      messageResultSession(
        { ...result, lastMessageAt: "2026-04-10T12:00:00Z" },
        [],
      ),
    ).toMatchObject({
      updatedAt: result.updatedAt,
      lastMessageAt: "2026-04-10T12:00:00Z",
    });
  });
  it("retains loaded workspace fields and refreshes archive metadata", () => {
    const loaded = {
      id: "session",
      title: "Local title",
      createdAt: result.messageCreatedAt,
      updatedAt: result.updatedAt,
      messageCount: 9,
      activeWorkspaceId: "workspace",
    };
    expect(messageResultSession(result, [loaded])).toMatchObject({
      activeWorkspaceId: "workspace",
      archivedAt: result.archivedAt,
      messageCount: 9,
    });
    expect(
      messageResultSession(result, [loaded], {
        session: {
          operationId: 1,
          desiredState: "unarchived",
          status: "pending",
        },
      }),
    ).toMatchObject({ archivedAt: undefined });
  });
});
