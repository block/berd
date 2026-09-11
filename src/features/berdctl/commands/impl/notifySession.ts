import { defineCommand } from "../types";
import { sendSessionSchema } from "./sendSession";

export const notifySessionCommand = defineCommand({
  effect: "update",
  visibility: "discoverable",
  destructive: false,
  summary: "Deliver an automated event to an existing chat session",
  description:
    "Deliver an automated event as a collapsed activity entry in the transcript. " +
    "The event reaches the agent as context and can start a turn. This does not " +
    "open the session or create an operating-system notification. Running sessions " +
    "are refused by default; use --if-running steer or --if-running queue. " +
    "Use --from to identify the event source and --delivery-id to make retries idempotent. " +
    "Use session send for ordinary messages from another session.",
  helpFooter: `Example:
  berdctl session notify --session-id <session-id> --prompt "Deployment completed" --from berd-monitor --if-running queue --delivery-id <stable-id> --json

Result:
  {"session_id": "...", "send_status": "dispatched"|"steered"|"queued"|"deduplicated"}
  The event stays visible in the transcript and does not change the user's current view.`,
  schema: sendSessionSchema.omit({ startup_name: true }),
  bridgeTimeoutMs: 60_000,
  execute: async (args) => {
    const { deliverSessionPrompt } = await import(
      "../runtime/deliverSessionPrompt"
    );
    return deliverSessionPrompt(args, "notification");
  },
});
