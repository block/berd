import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import {
  AUTOMATION_TILES_QUERY_KEY,
  AUTOMATION_TILES_STALE_TIME_MS,
  fetchAutomationTilesList,
} from "@/features/automations/api/automationTilesQuery";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { automationResultMeta } from "../lib/automationResultText";
import { filterByQuery } from "../lib/filterByQuery";

export function useAutomationSearch(query: string): AutomationTile[] {
  const automationsEnabled = useProfileCapability("automations");

  // Shares the AUTOMATION_TILES_QUERY_KEY cache entry with AutomationsView and
  // the home widgets, so tile mutations invalidate search results too — a
  // module-level snapshot here would be stale for the process lifetime.
  const { data } = useQuery({
    queryKey: AUTOMATION_TILES_QUERY_KEY,
    queryFn: fetchAutomationTilesList,
    enabled: automationsEnabled,
    staleTime: AUTOMATION_TILES_STALE_TIME_MS,
  });

  return useMemo(() => {
    if (!automationsEnabled) {
      return [];
    }

    return filterByQuery(
      (data ?? []).filter((automation) => Boolean(automation.id)),
      query,
      (automation) => [automation.title, automationResultMeta(automation)],
    );
  }, [automationsEnabled, data, query]);
}
