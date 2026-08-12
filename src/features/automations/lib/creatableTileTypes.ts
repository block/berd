import creatableTileTypes from "../../../../resources/creatable-tile-types.json";

// Shared policy for kgoose TileType proto values this app can safely create.
// Berd does not currently vend generated TileType bindings, so both frontend
// and Tauri load this JSON policy instead of duplicating enum tables.
const CREATABLE_TILE_TYPES = new Set(
  creatableTileTypes.flatMap(({ id, aliases }) => [
    // The numeric enum id is accepted as a string spelling too.
    String(id),
    ...aliases,
  ]),
);

export function canCreateTileType(
  type: string | number | undefined,
): type is string | number {
  return CREATABLE_TILE_TYPES.has(String(type ?? "").toLowerCase());
}
