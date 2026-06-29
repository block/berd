import { useAgentStore } from "@/features/agents/stores/agentStore";
import { listPersonas } from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";

import { CommandError } from "../types";

export async function findPersonaOrThrow(personaId: string): Promise<Persona> {
  const cached = useAgentStore.getState().getPersonaById(personaId);
  if (cached) {
    return cached;
  }

  const personas = await listPersonas();
  useAgentStore.getState().setPersonas(personas);
  const persona = personas.find((candidate) => candidate.id === personaId);
  if (!persona) {
    throw new CommandError(
      "agent_not_found",
      `No agent "${personaId}"; list agents with \`berdctl agent list\`.`,
    );
  }
  return persona;
}
