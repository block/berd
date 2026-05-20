import { useEffect, useMemo, useState } from "react";
import {
  getAutomationTiles,
  type AutomationTile,
} from "@/features/automations/api/kgooseAutomations";
import { filterByQuery } from "../lib/filterByQuery";

let automationCache: AutomationTile[] | null = null;
let automationRequest: Promise<AutomationTile[]> | null = null;

function loadAutomations(): Promise<AutomationTile[]> {
  automationRequest ??= getAutomationTiles()
    .then((response) => {
      automationCache = response.tiles;
      return response.tiles;
    })
    .finally(() => {
      automationRequest = null;
    });

  return automationRequest;
}

export function useAutomationSearch(query: string): AutomationTile[] {
  const [automations, setAutomations] = useState<AutomationTile[]>(
    () => automationCache ?? [],
  );

  useEffect(() => {
    let cancelled = false;

    void loadAutomations()
      .then((loadedAutomations) => {
        if (!cancelled) {
          setAutomations(loadedAutomations);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAutomations([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(
    () =>
      filterByQuery(automations, query, (automation) => [
        automation.title,
        automation.schedule,
        ...(automation.humanReadableInstructions ?? []),
        ...(automation.instructions ?? []),
      ]),
    [automations, query],
  );
}
