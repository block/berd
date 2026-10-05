export const CONTEXT_LIMIT_CONFIG_KEY = "GOOSE_CONTEXT_LIMIT";
export const DEFAULT_CONTEXT_LIMIT = 272_000;
export const MIN_CONTEXT_LIMIT_SLIDER = 1_000;
export const MAX_CONTEXT_LIMIT_SLIDER = 1_000_000;
export const CONTEXT_LIMIT_SLIDER_STEP = 1_000;

export function parseContextLimit(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
