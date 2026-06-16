import { z } from "zod/v4";

import { defineCommand } from "../types";

const createAgentSchema = z
  .object({
    name: z.string().min(1).describe("Name of the new agent (persona)."),
    system_prompt: z
      .string()
      .min(1)
      .describe("System prompt that defines the agent's behavior."),
    model: z.string().optional().describe("Model the agent should use."),
    provider: z
      .string()
      .optional()
      .describe("Provider of the model the agent should use."),
  })
  .strict();

export const createAgentCommand = defineCommand({
  effect: "create",
  visibility: "discoverable",
  destructive: false,
  summary: "Create a new agent (persona)",
  description:
    "Create a new agent (persona); it is saved and becomes available in future chats.",
  helpFooter: `Example:
  goosectl agent create --name "Reviewer" \\
    --system-prompt "You review diffs for correctness; be terse."

Result:
  {"agent_id": "..."} — the agent is saved and becomes available in
  future chats; pass it as --agent-id to \`goosectl session create\`.`,
  schema: createAgentSchema,
  execute: async (args) => {
    const [{ useAgentStore }, { createPersona }] = await Promise.all([
      import("@/features/agents/stores/agentStore"),
      import("@/shared/api/agents"),
    ]);
    const persona = await createPersona({
      displayName: args.name,
      systemPrompt: args.system_prompt,
      provider: args.provider,
      model: args.model,
    });
    useAgentStore.getState().addPersona(persona);
    return { agent_id: persona.id };
  },
});
