import { useMemo } from "react";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { Persona } from "@/shared/types/agents";
import { filterByQuery } from "../lib/filterByQuery";

function sortAgents(personas: Persona[]): Persona[] {
  const builtins = personas
    .filter((persona) => persona.isBuiltin)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const custom = personas
    .filter((persona) => !persona.isBuiltin)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  return [...builtins, ...custom];
}

export function useAgentSearch(query: string): Persona[] {
  const personas = useAgentStore((state) => state.personas);

  return useMemo(
    () =>
      filterByQuery(sortAgents(personas), query, (persona) => [
        persona.displayName,
        persona.systemPrompt,
      ]),
    [personas, query],
  );
}
