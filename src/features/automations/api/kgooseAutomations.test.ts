import { describe, expect, it } from "vitest";
import {
  filterAutomationTiles,
  isBuilderBotAutomationTile,
  isGenericAutomationTile,
  normalizeKgooseJson,
} from "./kgooseAutomations";

describe("kgoose automations api helpers", () => {
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
});
