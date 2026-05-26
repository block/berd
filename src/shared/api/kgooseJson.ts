export type KgooseJson =
  | null
  | boolean
  | number
  | string
  | KgooseJson[]
  | {
      [key: string]: KgooseJson;
    };

const PRESERVE_NESTED_KEYS = new Set([
  "latest_rendered_data",
  "latestRenderedData",
  "tile_data",
  "tileData",
]);

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

export function normalizeKgooseJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeKgooseJson);
  }

  if (typeof value !== "object") {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const camelKey = snakeToCamel(key);
    normalized[camelKey] = PRESERVE_NESTED_KEYS.has(key)
      ? nestedValue
      : normalizeKgooseJson(nestedValue);
  }
  return normalized;
}
