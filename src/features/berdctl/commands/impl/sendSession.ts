import { z } from "zod/v4";

import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import {
  assertQueuedSessionReady,
  isQueuedSessionReady,
} from "@/features/chat/lib/queuedMessageReadiness";
import { steerPromptInSession } from "@/features/chat/lib/steerCore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  admitSystemInheritedQueuedMessage,
  createDeferredQueuedMessagePayload,
} from "@/features/chat/lib/admittedSend";
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

interface SendSessionResult {
  session_id: string;
  send_status: "dispatched" | "steered" | "queued" | "deduplicated";
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
  execute: async (args): Promise<SendSessionResult> => {
    const [
      { acceptFirstSend },
      { loadSessionForBerdctl, requireSession },
      { findProjectOrThrow },
      {
        berdctlCrossSessionSendOptions,
        BerdctlDeliveryAlreadyAcceptedError,
        hasAcceptedBerdctlDelivery,
        reserveBerdctlDelivery,
        sendPromptToExistingSessionInBackground,
        SessionDispatchContentionError,
        SessionDispatchUnresolvedError,
      },
    ] = await Promise.all([
      import("@/features/chat/lib/firstWorkspaceSend"),
      import("../runtime/sessions"),
      import("../runtime/projects"),
      import("../runtime/sessionSend"),
    ]);
    const sendOptions = berdctlCrossSessionSendOptions({
      senderLabel: args.from,
      deliveryId: args.delivery_id,
    });

    await loadSessionForBerdctl(args.session_id);
    const session = requireSession(args.session_id);

    const releaseDeliveryReservation = args.delivery_id
      ? reserveBerdctlDelivery(args.session_id, args.delivery_id)
      : undefined;
    if (args.delivery_id && !releaseDeliveryReservation) {
      return { session_id: session.id, send_status: "deduplicated" };
    }

    try {
      if (useSessionWindowStore.getState().isOpenInWindow(args.session_id)) {
        throw new CommandError(
          "target_session_running",
          `Refusing to send to session "${args.session_id}" while it is open in a separate window; close that window first or ask the user.`,
        );
      }

      const chatStore = useChatStore.getState();
      const runtime = chatStore.getSessionRuntime(args.session_id);
      if (
        args.startup_name &&
        ((chatStore.queuedMessageBySession[args.session_id]?.length ?? 0) > 0 ||
          session.messageCount > 0)
      ) {
        throw new CommandError(
          "invalid_args",
          "startup_name is only valid for the first send when workspace setup is available.",
        );
      }
      if (!isQueuedSessionReady(runtime)) {
        switch (args.if_running) {
          case "refuse":
            throw new CommandError(
              "target_session_running",
              runningTargetMessage(args.session_id),
            );

          case "steer":
            if (runtime.isRunCancellationPending) {
              throw new CommandError(
                "target_session_running",
                `Refusing to steer session "${args.session_id}" while cancellation is pending; use --if-running queue or wait for cancellation to finish.`,
              );
            }
            await steerPromptInSession(
              args.session_id,
              args.prompt,
              undefined,
              sendOptions,
              { throwOnError: true },
            );
            return { session_id: session.id, send_status: "steered" };

          case "queue":
            chatStore.enqueueTransportReadyMessage(
              args.session_id,
              admitSystemInheritedQueuedMessage({
                text: args.prompt,
                sendOptions,
              }),
            );
            return { session_id: session.id, send_status: "queued" };

          default:
            throw new Error(
              `Unhandled if_running mode: ${String(args.if_running satisfies never)}`,
            );
        }
      }

      const project = session.projectId
        ? await findProjectOrThrow(session.projectId)
        : null;
      const firstSend = acceptFirstSend(
        args.session_id,
        createDeferredQueuedMessagePayload({
          text: args.prompt,
          persona: { kind: "inherit" },
          sendOptions,
        }),
        { startupName: args.startup_name, project },
      );
      if (firstSend.needsName) {
        throw new CommandError(
          "workspace_name_required",
          "This session needs a workspace startup name before its first send.",
        );
      }
      if (firstSend.accepted) {
        return { session_id: session.id, send_status: "queued" };
      }
      if (
        (chatStore.queuedMessageBySession[args.session_id]?.length ?? 0) > 0
      ) {
        chatStore.enqueueTransportReadyMessage(
          args.session_id,
          admitSystemInheritedQueuedMessage({
            text: args.prompt,
            sendOptions,
          }),
        );
        return { session_id: session.id, send_status: "queued" };
      }

      try {
        await sendPromptToExistingSessionInBackground(
          args.session_id,
          args.prompt,
          () => {
            const liveChatStore = useChatStore.getState();
            assertQueuedSessionReady(
              liveChatStore.getSessionRuntime(args.session_id),
              (liveChatStore.queuedMessageBySession[args.session_id]?.length ??
                0) === 0,
            );
          },
          {
            returnOnDispatch: true,
            sendOptions,
            validateHydratedTranscript: () => {
              if (
                args.delivery_id &&
                hasAcceptedBerdctlDelivery(args.session_id, args.delivery_id)
              ) {
                throw new BerdctlDeliveryAlreadyAcceptedError();
              }
            },
          },
        );
      } catch (error) {
        if (error instanceof BerdctlDeliveryAlreadyAcceptedError) {
          return { session_id: session.id, send_status: "deduplicated" };
        }
        if (error instanceof SessionDispatchContentionError) {
          if (args.if_running === "queue") {
            useChatStore.getState().enqueueTransportReadyMessage(
              args.session_id,
              admitSystemInheritedQueuedMessage({
                text: args.prompt,
                sendOptions,
              }),
            );
            return { session_id: session.id, send_status: "queued" };
          }
          throw new CommandError(
            "target_session_running",
            runningTargetMessage(args.session_id),
          );
        }
        if (error instanceof SessionDispatchUnresolvedError) {
          throw new CommandError("invalid_args", error.message);
        }
        if (error instanceof PreCommitSendRejectedError) {
          if (args.if_running === "queue") {
            useChatStore.getState().enqueueTransportReadyMessage(
              args.session_id,
              admitSystemInheritedQueuedMessage({
                text: args.prompt,
                sendOptions,
              }),
            );
            return { session_id: session.id, send_status: "queued" };
          }
          throw new CommandError(
            "target_session_running",
            runningTargetMessage(args.session_id),
          );
        }
        if (error instanceof CommandError) {
          throw error;
        }
        throw new Error(formatAcpErrorMessage(error));
      }
      return { session_id: session.id, send_status: "dispatched" };
    } finally {
      releaseDeliveryReservation?.();
    }
  },
});
