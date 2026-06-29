import { z } from "zod/v4";

import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { steerPromptInSession } from "@/features/chat/lib/steerCore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";

import { CommandError, defineCommand } from "../types";

const sendSessionSchema = z
  .object({
    session_id: z
      .string()
      .describe("Id of the existing session to send the prompt into."),
    prompt: z
      .string()
      .min(1)
      .max(50_000)
      .describe("The message to send in the existing session (1-50000 chars)."),
    if_running: z
      .enum(["refuse", "steer", "queue"])
      .default("refuse")
      .describe(
        "What to do if the target session is running: refuse, steer, or queue.",
      ),
  })
  .strict();

interface SendSessionResult {
  session_id: string;
  send_status: "dispatched" | "steered" | "queued";
}

function runningTargetMessage(sessionId: string): string {
  return `Refusing to send to session "${sessionId}" while its agent is running; use --if-running steer or --if-running queue, or wait for the turn to finish.`;
}

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
    "to send one follow-up after the current run finishes.",
  helpFooter: `Example:
  berdctl session send --session-id <session-id> \\
    --prompt "Check the latest CI failure" --if-running queue --json

Result:
  {"session_id": "...", "send_status": "dispatched"|"steered"|"queued"}
  The user's current view does not change.`,
  schema: sendSessionSchema,
  bridgeTimeoutMs: 60_000,
  execute: async (args): Promise<SendSessionResult> => {
    const [
      { loadSessionForBerdctl, requireSession },
      {
        berdctlCrossSessionSendOptions,
        sendPromptToExistingSessionInBackground,
      },
    ] = await Promise.all([
      import("../runtime/sessions"),
      import("../runtime/sessionSend"),
    ]);

    await loadSessionForBerdctl(args.session_id);
    const session = requireSession(args.session_id);

    if (useSessionWindowStore.getState().isOpenInWindow(args.session_id)) {
      throw new CommandError(
        "target_session_running",
        `Refusing to send to session "${args.session_id}" while it is open in a separate window; close that window first or ask the user.`,
      );
    }

    const chatStore = useChatStore.getState();
    const runtime = chatStore.getSessionRuntime(args.session_id);
    if (isSessionRunning(runtime.chatState)) {
      switch (args.if_running) {
        case "refuse":
          throw new CommandError(
            "target_session_running",
            runningTargetMessage(args.session_id),
          );

        case "steer":
          await steerPromptInSession(
            args.session_id,
            args.prompt,
            undefined,
            berdctlCrossSessionSendOptions(),
            { throwOnError: true },
          );
          return { session_id: session.id, send_status: "steered" };

        case "queue":
          if (chatStore.queuedMessageBySession[args.session_id]) {
            throw new CommandError(
              "queue_full",
              `Session "${args.session_id}" already has a queued message; wait for it to send or ask the user to dismiss it.`,
            );
          }
          chatStore.enqueueMessage(args.session_id, {
            text: args.prompt,
            sendOptions: berdctlCrossSessionSendOptions(),
          });
          return { session_id: session.id, send_status: "queued" };

        default:
          throw new Error(
            `Unhandled if_running mode: ${String(args.if_running satisfies never)}`,
          );
      }
    }

    try {
      await sendPromptToExistingSessionInBackground(
        args.session_id,
        args.prompt,
      );
    } catch (error) {
      if (error instanceof CommandError) {
        throw error;
      }
      throw new Error(formatAcpErrorMessage(error));
    }
    return { session_id: session.id, send_status: "dispatched" };
  },
});
