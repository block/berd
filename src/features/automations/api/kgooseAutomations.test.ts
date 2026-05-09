import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterAutomationTiles,
  getAutomationSessionMessages,
  isBuilderBotAutomationTile,
  isGenericAutomationTile,
  normalizeKgooseJson,
} from "./kgooseAutomations";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("kgoose automations api helpers", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("normalizes snake case response envelopes without changing rendered data payloads", () => {
    expect(
      normalizeKgooseJson({
        tile_info: {
          latest_run_status: "TILE_RUN_STATUS_SUCCESS",
          latest_rendered_data: { nested_value: true },
        },
        tiles_results: [{ session_id: "session-1", tile_data: { raw_key: 1 } }],
      }),
    ).toEqual({
      tileInfo: {
        latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
        latestRenderedData: { nested_value: true },
      },
      tilesResults: [{ sessionId: "session-1", tileData: { raw_key: 1 } }],
    });
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

  it("maps raw session message envelopes into timeline messages", async () => {
    mockInvoke.mockResolvedValue({
      get_messages_response: {
        status: "CHAT_SESSION_STATUS_IDLE",
        session_name: "Daily revenue digest run",
        messages: [
          {
            id: "message-1",
            role: "ROLE_USER",
            created: "1714568300000",
            content: [
              {
                type: "MESSAGE_TYPE_TEXT",
                text: { text: "Run now" },
              },
            ],
          },
          {
            id: "message-2",
            role: "ROLE_ASSISTANT",
            created: "1714568400000",
            content: [
              {
                type: "MESSAGE_TYPE_TOOL_REQUEST",
                tool_request: {
                  id: "tool-1",
                  status: "success",
                  value: {
                    name: "slack",
                    arguments: JSON.stringify({ channel: "revenue" }),
                  },
                },
              },
            ],
          },
          {
            id: "message-3",
            role: "ROLE_ASSISTANT",
            created: "1714568401000",
            content: [
              {
                type: "MESSAGE_TYPE_TOOL_RESPONSE",
                tool_response: {
                  id: "tool-1",
                  status: "success",
                  extension_name: "slack",
                  results: [
                    {
                      text: {
                        text: "Fetched 3 Slack messages from #revenue.",
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    await expect(getAutomationSessionMessages("session-1")).resolves.toEqual({
      sessionName: "Daily revenue digest run",
      status: "idle",
      messages: [
        expect.objectContaining({
          id: "message-1",
          role: "user",
          created: 1714568300000,
          content: [{ type: "text", text: "Run now" }],
        }),
        expect.objectContaining({
          id: "message-2",
          role: "assistant",
          created: 1714568400000,
          content: [
            expect.objectContaining({
              type: "toolRequest",
              id: "tool-1",
              name: "slack",
              arguments: { channel: "revenue" },
              status: "completed",
            }),
            expect.objectContaining({
              type: "toolResponse",
              id: "tool-1",
              name: "slack",
              result: "Fetched 3 Slack messages from #revenue.",
            }),
          ],
        }),
      ],
    });
    expect(mockInvoke).toHaveBeenCalledWith("get_automation_session_messages", {
      sessionId: "session-1",
    });
  });
});
