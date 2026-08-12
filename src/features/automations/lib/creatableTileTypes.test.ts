import { describe, expect, it } from "vitest";
import creatableTileTypes from "../../../../resources/creatable-tile-types.json";
import { canCreateTileType } from "./creatableTileTypes";

describe("creatable tile type helpers", () => {
  it.each([
    4,
    "summary",
    "TILE_TYPE_SUMMARY",
    10,
    "automation",
    "TILE_TYPE_AUTOMATION",
    12,
    "form",
    "TILE_TYPE_FORM",
  ])("allows %s", (type) => {
    expect(canCreateTileType(type)).toBe(true);
  });

  it.each([
    undefined,
    "",
    1,
    6,
    18,
    "task",
    "TILE_TYPE_TASK",
    "builderbot_automation",
    "TILE_TYPE_BUILDERBOT_AUTOMATION",
    "TILE_TYPE_EXPERIMENTAL",
  ])("rejects %s", (type) => {
    expect(canCreateTileType(type)).toBe(false);
  });

  it("keeps policy aliases lowercase", () => {
    expect(
      creatableTileTypes
        .flatMap(({ aliases }) => aliases)
        .every((alias) => alias === alias.toLowerCase()),
    ).toBe(true);
  });
});
