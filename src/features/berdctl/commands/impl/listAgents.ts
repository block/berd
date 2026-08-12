import { z } from "zod/v4";

import { truncate } from "../helpers";
import { defineCommand } from "../types";

const listAgentsSchema = z.object({}).strict();

const SUMMARY_LENGTH = 100;

function summarize(systemPrompt: string): string {
  return truncate(systemPrompt.split("\n", 1)[0], SUMMARY_LENGTH);
}

interface ListAgentsResult {
  agents: Array<{
    agent_id: string;
    name: string;
    summary: string;
    builtin: boolean;
  }>;
}

export const listAgentsCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List the user's agents (personas)",
  description:
    "List the user's agents (personas) usable as agent_id when creating a session; " +
    "does not change anything on screen.",
  helpFooter: `Example:
  berdctl agent list --json

Result:
  {"agents": [{"agent_id": "...", "name": "...",
               "summary": "...", "builtin": false}, ...]}
  Use an agent_id as --agent-id when creating a session.`,
  schema: listAgentsSchema,
  execute: async (): Promise<ListAgentsResult> => {
    const { listPersonas } = await import("@/shared/api/agents");
    const personas = await listPersonas();
    return {
      agents: personas.map((persona) => ({
        agent_id: persona.id,
        name: persona.displayName,
        summary: summarize(persona.systemPrompt),
        builtin: persona.isBuiltin,
      })),
    };
  },
});
