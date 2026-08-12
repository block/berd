import type { QueryClient } from "@tanstack/react-query";
import {
  type AutomationTile,
  type GetAutomationTileResponse,
  getAutomationTile,
  getAutomationTiles,
} from "./kgooseAutomations";

/**
 * Canonical react-query keys for the `get_automation_tiles` /
 * `get_automation_tile` / `get_automation_tile_results` reads, mirroring
 * `shared/lib/gitStateQueryKey.ts`.
 *
 * Every observer and every invalidator must build its key here. The tile list
 * is read by AutomationsView, the home-screen pin widgets, Cmd-K search, and
 * the widget picker; when each site spells its own key (or caches outside
 * react-query entirely), simultaneous mounts fan out duplicate IPC calls and —
 * the reason this module exists — a mutation's invalidation lands only on the
 * spellings the mutating view happens to know about, leaving every other
 * surface stale. With `refetchOnWindowFocus` disabled globally, nothing
 * self-heals afterwards. One shared spelling makes invalidation reach every
 * observer by construction.
 */
export const AUTOMATION_TILES_QUERY_KEY = ["automation-tiles"] as const;

// Shared between the key builders and invalidateAutomationTileQueries so the
// prefix-match sweep can't silently drift from the keys it targets.
const AUTOMATION_TILE_KEY_PREFIX = "automation-tile";
const AUTOMATION_TILE_RESULTS_KEY_PREFIX = "automation-tile-results";

export function automationTileQueryKey(id: string | null | undefined) {
  return [AUTOMATION_TILE_KEY_PREFIX, id] as const;
}

export function automationTileResultsQueryKey(
  tileId: string | null | undefined,
) {
  return [AUTOMATION_TILE_RESULTS_KEY_PREFIX, tileId] as const;
}

// Single home for the constant currently copy-pasted in AutomationsView,
// AutomationHistory, and AutomationHistoryFeed.
export const AUTOMATIONS_REFETCH_INTERVAL_MS = 15_000;

// Freshness window for the passive tile observers (pin widgets, Cmd-K search,
// the widget picker): shared here for the same reason as the poll interval,
// so the "how stale may a tile read be" answer can't fork per consumer.
export const AUTOMATION_TILES_STALE_TIME_MS = 15_000;

/** Canonical list fetch: cache AutomationTile[] (post-filterAutomationTiles). */
export function fetchAutomationTilesList(): Promise<AutomationTile[]> {
  return getAutomationTiles().then((r) => r.tiles);
}

/** Canonical detail fetch: cache the GetAutomationTileResponse envelope, so
 *  every observer of automationTileQueryKey(id) — AutomationsView's detail
 *  pane and the pin widgets' parity fallback — shares one entry shape. */
export function fetchAutomationTileDetail(
  id: string,
): Promise<GetAutomationTileResponse> {
  return getAutomationTile(id);
}

/** Every tile mutation must invalidate through here so home pins, search,
 *  and the picker — not just AutomationsView — observe the change. */
export function invalidateAutomationTileQueries(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: AUTOMATION_TILES_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: [AUTOMATION_TILE_KEY_PREFIX] }),
    queryClient.invalidateQueries({
      queryKey: [AUTOMATION_TILE_RESULTS_KEY_PREFIX],
    }),
  ]);
}
