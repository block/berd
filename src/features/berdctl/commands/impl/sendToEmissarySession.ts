import { z } from "zod/v4";

import { CommandError, defineCommand } from "../types";

const sendToEmissarySessionSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .describe("Id of the session that owns the live Realtime emissary."),
    message: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .describe("Private coordination message to inject into the emissary."),
    cursor: z
      .number()
      .int()
      .min(0)
      .max(4_294_967_295)
      .describe(
        "Newest cursor from any Master-bound voice transcript, handoff, reminder, or bridge result.",
      ),
    mode: z
      .enum(["context", "say"])
      .default("say")
      .describe(
        "Delivery mode: context updates future turns silently; say asks the emissary to speak now.",
      ),
    resolves: z
      .array(z.string().trim().min(1).max(100))
      .max(100)
      .default([])
      .describe(
        "Open handoff id resolved by this say message; repeat for multiple handoffs.",
      ),
  })
  .strict();

interface SendToEmissarySessionResult {
  session_id: string;
  cursor: number;
  delivery_status: "sent" | "interrupting" | "queued";
  mode: "context" | "say";
  resolved_handoff_ids: string[];
}

export const sendToEmissarySessionCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Send private guidance to a session's live voice emissary",
  description:
    "Inject a private coordination message into the OpenAI Realtime voice " +
    "emissary owned by an existing Berd session. The emissary receives the " +
    "message either as silent context for future turns or as a request to speak now. " +
    "The command fails when the target session has no live Realtime voice conversation.",
  helpFooter: `Example:
  berdctl session send-to-emissary --session-id <session-id> --cursor 0 \\
    --mode say --resolves handoff-1 \\
    --message "The build failed because the signing certificate expired." --json

Result:
  {"session_id":"...","cursor":0,"delivery_status":"sent"|"interrupting"|"queued","mode":"context"|"say","resolved_handoff_ids":["handoff-1"]}

Use --mode context to update the emissary's future context without starting a
response. Use --mode say when the emissary should speak the message now.
Repeat --resolves to close every handoff answered by one say. Context messages
cannot resolve handoffs. A say may omit --resolves when volunteering information.

A send while the pipe contains a newer Master-bound transcript, handoff, or
reminder fails with reason "pipe_busy" without consuming that pending event.
Wait for Berd to deliver it normally, then retry with its cursor.`,
  schema: sendToEmissarySessionSchema,
  execute: async (args): Promise<SendToEmissarySessionResult> => {
    const { getActiveRealtimeEmissary } = await import(
      "@/features/voice-conversation/lib/realtimeEmissaryBridge"
    );
    const emissary = getActiveRealtimeEmissary();
    if (!emissary || emissary.sessionId !== args.session_id) {
      throw new CommandError(
        "invalid_args",
        `Session "${args.session_id}" has no live OpenAI Realtime voice emissary. Start Realtime voice in that session and retry.`,
      );
    }

    const delivery = await emissary.sendMasterMessage(
      args.message,
      args.cursor,
      args.mode,
      args.resolves,
    );
    if (!delivery.accepted) {
      throw new CommandError(
        "invalid_args",
        JSON.stringify({
          reason: delivery.reason,
          cursor: delivery.cursor,
          unread_peer_messages: delivery.unreadPeerMessages,
          ...(delivery.reason === "unknown_handoff" ||
          delivery.reason === "context_cannot_resolve"
            ? { handoff_ids: delivery.handoffIds }
            : {}),
        }),
      );
    }

    return {
      session_id: args.session_id,
      cursor: delivery.cursor,
      delivery_status: delivery.deliveryStatus,
      mode: args.mode,
      resolved_handoff_ids: args.resolves,
    };
  },
});
