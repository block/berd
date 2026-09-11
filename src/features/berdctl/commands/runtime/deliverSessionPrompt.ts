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

import { CommandError } from "../types";

interface SendSessionResult {
  session_id: string;
  send_status: "dispatched" | "steered" | "queued" | "deduplicated";
}

interface DeliverSessionPromptArgs {
  session_id: string;
  prompt: string;
  startup_name?: string;
  if_running: "refuse" | "steer" | "queue";
  from?: string;
  delivery_id?: string;
}

function runningTargetMessage(sessionId: string): string {
  return `Refusing to send to session "${sessionId}" while its agent is running; use --if-running steer or --if-running queue, or wait for the turn to finish.`;
}

export async function deliverSessionPrompt(
  args: DeliverSessionPromptArgs,
  eventType?: "notification",
): Promise<SendSessionResult> {
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
    eventType,
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
    if ((chatStore.queuedMessageBySession[args.session_id]?.length ?? 0) > 0) {
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
}
