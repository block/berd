import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExportSession = vi.hoisted(() => vi.fn());

vi.mock("../acpApi", () => ({
  exportSession: mockExportSession,
}));

import { searchSessionsViaExports } from "../sessionSearch";

describe("searchSessionsViaExports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["snake_case", { user_visible: false }],
    ["camelCase", { userVisible: false }],
  ])("ignores %s hidden exported messages before building snippets", async (_caseName, hiddenMetadata) => {
    mockExportSession.mockResolvedValueOnce(
      JSON.stringify({
        conversation: [
          {
            id: "hidden-message",
            role: "assistant",
            metadata: hiddenMetadata,
            content: "hidden needle should not become the snippet",
          },
          {
            id: "visible-message",
            role: "assistant",
            content: "visible needle should become the snippet",
          },
        ],
      }),
    );

    await expect(
      searchSessionsViaExports("needle", ["session-1"]),
    ).resolves.toEqual([
      {
        sessionId: "session-1",
        snippet: "visible needle should become the snippet",
        messageId: "visible-message",
        messageRole: "assistant",
        matchCount: 1,
      },
    ]);
  });
});
