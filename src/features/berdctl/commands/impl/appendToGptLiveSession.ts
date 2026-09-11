import { z } from "zod/v4";

import { CommandError, defineCommand } from "../types";

const appendToGptLiveSessionSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .describe("Session with an active GPT Live call."),
    message: z
      .string()
      .trim()
      .min(1)
      .max(1_500)
      .describe("Result or context to append to GPT Live."),
    cursor: z
      .number()
      .int()
      .min(0)
      .max(4_294_967_295)
      .describe("Newest cursor supplied with the delegation."),
    channel: z
      .enum(["commentary", "thinking"])
      .default("commentary")
      .describe("Commentary is spoken; thinking is silent context."),
    delegation_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Opaque delegation id supplied by GPT Live."),
  })
  .strict();

interface AppendToGptLiveSessionResult {
  session_id: string;
  cursor: number;
  channel: "commentary" | "thinking";
  delegation_id?: string;
}

export const appendToGptLiveSessionCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Return a delegated result to GPT Live",
  description:
    "Append a backend result to an active GPT Live conversation. Commentary is " +
    "spoken to the user; thinking updates GPT Live silently. Preserve the opaque " +
    "delegation id when answering a delegation.",
  helpFooter: `Example:
  berdctl session append-to-gpt-live --session-id <session-id> --cursor <cursor> \\
    --channel commentary --delegation-id <delegation-id> \\
    --message "The build passed." --json

Use commentary for a result GPT Live should deliver to the user. Use thinking for
private context that should influence a later response.`,
  schema: appendToGptLiveSessionSchema,
  execute: async (args): Promise<AppendToGptLiveSessionResult> => {
    const { appendToActiveGptLive } = await import(
      "@/features/voice-conversation/lib/gptLiveBridge"
    );
    const result = await appendToActiveGptLive(
      args.session_id,
      args.message,
      args.cursor,
      args.channel,
      args.delegation_id,
    );
    if (!result) {
      throw new CommandError(
        "invalid_args",
        `Session "${args.session_id}" has no active GPT Live conversation.`,
      );
    }
    if (!result.accepted) {
      throw new CommandError(
        "invalid_args",
        JSON.stringify({ reason: result.reason, cursor: result.cursor }),
      );
    }
    return {
      session_id: args.session_id,
      cursor: result.cursor,
      channel: args.channel,
      ...(args.delegation_id ? { delegation_id: args.delegation_id } : {}),
    };
  },
});
