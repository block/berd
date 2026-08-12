import type { PillTone } from "./pillTones";

/**
 * Default project color tone. Stored on `ProjectInfo.color` as a tone name;
 * consumers map to a `bg-pill-*` class or CSS color via `pillTones.ts`.
 * Legacy projects may have a hex string here — callers must handle both.
 */
export const DEFAULT_PROJECT_COLOR: PillTone = "olive";
