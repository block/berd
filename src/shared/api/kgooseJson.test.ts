import { describe, expect, it } from "vitest";
import { normalizeKgooseJson } from "./kgooseJson";

describe("kgoose json helpers", () => {
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
});
