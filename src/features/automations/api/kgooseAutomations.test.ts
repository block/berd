import { describe, expect, it } from "vitest";
import {
  filterAutomationTiles,
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

  it("keeps only tiles without a space id as automations", () => {
    expect(
      filterAutomationTiles([
        { id: "automation-1" },
        { id: "automation-2", spaceId: null },
        { id: "tile-1", spaceId: "space-1" },
      ]),
    ).toEqual([{ id: "automation-1" }, { id: "automation-2", spaceId: null }]);
  });
});
