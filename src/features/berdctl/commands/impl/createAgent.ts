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
  .strict()
  .refine((args) => !args.model || Boolean(args.provider), {
    message: "provider is required when model is set",
    path: ["provider"],
  })
  .refine(
    (args) => !args.model || args.provider?.trim().toLowerCase() !== "goose",
    {
      message: "provider must identify the concrete model provider",
      path: ["provider"],
    },
  );

export const createAgentCommand = defineCommand({
  effect: "create",
  visibility: "discoverable",
  destructive: false,
  summary: "Create a new agent (persona)",
  description:
    "Create a new agent (persona); it is saved and becomes available in future chats.",
  helpFooter: `Example:
  berdctl agent create --name "Reviewer" \\
    --system-prompt "You review diffs for correctness; be terse."

Result:
  {"agent_id": "..."} — the agent is saved and becomes available in
  future chats; pass it as --agent-id to \`berdctl session create\`.`,
  schema: createAgentSchema,
  execute: async (args) => {
    const [{ useAgentStore }, { createPersona }] = await Promise.all([
      import("@/features/agents/stores/agentStore"),
      import("@/shared/api/agents"),
    ]);
    // Deliberately no berd_agent Create Completed telemetry: berdctl creates
    // are agent/automation-driven, and the event tracks human-driven UI
    // surfaces only — matching the documented berdctl exclusion in the chat
    // send path (fireChatSendTelemetry in useChatSessionController).
    const persona = await createPersona({
      displayName: args.name,
      systemPrompt: args.system_prompt,
      provider: args.provider,
      modelProviderId: args.model ? args.provider : undefined,
      model: args.model,
    });
    useAgentStore.getState().addPersona(persona);
    return { agent_id: persona.id };
  },
});
