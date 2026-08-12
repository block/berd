import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterAutomationTiles,
  getAutomationSessionMessages,
  isBuilderBotAutomationTile,
  isGenericAutomationTile,
  refreshAutomationTile,
} from "./kgooseAutomations";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("kgoose automations api helpers", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("keeps only generic tiles without a space id as automations", () => {
    expect(
      filterAutomationTiles([
        { id: "automation-1" },
        { id: "automation-2", spaceId: null },
        { id: "builderbot-1", type: 18 },
        { id: "builderbot-2", type: "18" },
        {
          id: "builderbot-3",
          type: "TILE_TYPE_BUILDERBOT_AUTOMATION",
        },
        { id: "builderbot-4", type: "builderbot_automation" },
        { id: "tile-1", spaceId: "space-1" },
      ]),
    ).toEqual([{ id: "automation-1" }, { id: "automation-2", spaceId: null }]);
  });

  it("classifies builderbot and generic automations", () => {
    expect(isBuilderBotAutomationTile({ id: "builderbot", type: 18 })).toBe(
      true,
    );
    expect(
      isGenericAutomationTile({
        id: "builderbot",
        type: "TILE_TYPE_BUILDERBOT_AUTOMATION",
      }),
    ).toBe(false);
    expect(isGenericAutomationTile({ id: "automation", type: 10 })).toBe(true);
    expect(
      isGenericAutomationTile({ id: "tile", type: 10, spaceId: "space-1" }),
    ).toBe(false);
  });

  it("unwraps session message envelopes from the automation command", async () => {
    mockInvoke.mockResolvedValue({
      get_messages_response: {
        status: "CHAT_SESSION_STATUS_IDLE",
        session_name: "Daily run",
        messages: [
          {
            id: "message-1",
            role: "ROLE_USER",
            created: "1714568300000",
            content: [{ type: "MESSAGE_TYPE_TEXT", text: { text: "Run now" } }],
          },
        ],
      },
    });

    await expect(getAutomationSessionMessages("session-1")).resolves.toEqual({
      sessionName: "Daily run",
      status: "idle",
      messages: [
        expect.objectContaining({
          id: "message-1",
          role: "user",
          created: 1714568300000,
          content: [{ type: "text", text: "Run now" }],
        }),
      ],
    });
    expect(mockInvoke).toHaveBeenCalledWith("get_automation_session_messages", {
      sessionId: "session-1",
    });
  });

  it("refreshes an automation tile by id", async () => {
    mockInvoke.mockResolvedValue({
      success: true,
      refresh_session_id: "session-1",
    });

    await expect(refreshAutomationTile("automation-1")).resolves.toEqual({
      success: true,
      refreshSessionId: "session-1",
    });
    expect(mockInvoke).toHaveBeenCalledWith("refresh_automation_tile", {
      id: "automation-1",
    });
  });
});
