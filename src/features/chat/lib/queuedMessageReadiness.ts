import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import type { SessionChatRuntime } from "@/shared/types/chat";

export class QueuedSessionNotReadyError extends PreCommitSendRejectedError {
  constructor() {
    super("The session can no longer accept a queued send.");
    this.name = "QueuedSessionNotReadyError";
  }
}

export function assertQueuedSessionReady(
  runtime: Parameters<typeof isQueuedSessionReady>[0],
  preparationReady = true,
): void {
  if (!isQueuedSessionReady(runtime, preparationReady)) {
    throw new QueuedSessionNotReadyError();
  }
}

export function isQueuedSessionReady(
  runtime:
    | Pick<
        SessionChatRuntime,
        "chatState" | "activeRunId" | "isRunCancellationPending"
      >
    | undefined,
  preparationReady = true,
): boolean {
  return (
    preparationReady &&
    (runtime?.chatState ?? "idle") === "idle" &&
    (runtime?.activeRunId ?? null) === null &&
    !(runtime?.isRunCancellationPending ?? false)
  );
}
