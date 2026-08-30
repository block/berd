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
      .describe("Latest direct-message cursor returned by the voice bridge."),
  })
  .strict();

interface SendToEmissarySessionResult {
  session_id: string;
  cursor: number;
  delivery_status: "sent" | "interrupting" | "queued";
}

export const sendToEmissarySessionCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Send private guidance to a session's live voice emissary",
  description:
    "Inject a private coordination message into the OpenAI Realtime voice " +
    "emissary owned by an existing Berd session. The emissary receives the " +
    "message immediately and starts a response; active speech may be interrupted. " +
    "The command fails when the target session has no live Realtime voice conversation.",
  helpFooter: `Example:
  berdctl session send-to-emissary --session-id <session-id> --cursor 0 \\
    --message "The build failed because the signing certificate expired." --json

Result:
  {"session_id":"...","cursor":0,"delivery_status":"sent"|"interrupting"|"queued"}

A send while the pipe is carrying emissary-to-master coordination fails with
reason "pipe_busy" without consuming that pending message. Wait for Berd to
deliver it normally, then retry with the cursor included in that message.`,
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
    );
    if (!delivery.accepted) {
      throw new CommandError(
        "invalid_args",
        JSON.stringify({
          reason: delivery.reason,
          cursor: delivery.cursor,
          unread_peer_messages: delivery.unreadPeerMessages,
        }),
      );
    }

    return {
      session_id: args.session_id,
      cursor: delivery.cursor,
      delivery_status: delivery.deliveryStatus,
    };
  },
});
