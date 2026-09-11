import { z } from "zod/v4";
import { defineCommand } from "../types";

export const sendSessionSchema = z
  .object({
    session_id: z
      .string()
      .describe("Id of the existing session to send the prompt into."),
    prompt: z
      .string()
      .min(1)
      .max(50_000)
      .describe("The message to send in the existing session (1-50000 chars)."),
    startup_name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Branch/worktree name when this is the first send."),
    if_running: z
      .enum(["refuse", "steer", "queue"])
      .default("refuse")
      .describe(
        "What to do if the target session is running: refuse, steer, or queue.",
      ),
    from: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\r\n]*$/, "Sender label must be a single line.")
      .optional()
      .describe(
        "Optional visible sender label for this message (1-120 chars).",
      ),
    delivery_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]*$/, "Delivery id must be a single line.")
      .optional()
      .describe(
        "Optional idempotency id; a repeated id for this session is accepted without creating another user turn (1-200 chars).",
      ),
  })
  .strict();

export type SendSessionArgs = z.infer<typeof sendSessionSchema>;

export const sendSessionCommand = defineCommand({
  effect: "update",
  visibility: "discoverable",
  destructive: false,
  summary: "Send a prompt into an existing chat session",
  description:
    "Send a prompt into an existing chat session without opening or focusing it. " +
    "Idle sends are fire-and-forget and visibly add a user message marked as sent " +
    "by Berd from another session. Running sessions are refused by default; use " +
    "--if-running steer to add context to the active run, or --if-running queue " +
    "to send one follow-up after the current run finishes. Use --from to give " +
    "the sending session or tool a concise visible label in the transcript. " +
    "Use --delivery-id when retries must create at most one user turn.",
  helpFooter: `Example:
  berdctl session send --session-id <session-id> \\
    --prompt "Check the latest CI failure" --if-running queue \\
    --from "the Berd session handling CI" --delivery-id <stable-id> --json

Result:
  {"session_id": "...", "send_status": "dispatched"|"steered"|"queued"|"deduplicated"}
  The user's current view does not change.`,
  schema: sendSessionSchema,
  bridgeTimeoutMs: 60_000,
  execute: async (args) => {
    const { deliverSessionPrompt } = await import(
      "../runtime/deliverSessionPrompt"
    );
    return deliverSessionPrompt(args);
  },
});
