import type { QueuedMessageRecord } from "../stores/chatStore";
import type { MessageMetadata } from "@/shared/types/messages";

const BERDCTL_CROSS_SESSION_ORIGIN =
  "berdctl_cross_session" satisfies NonNullable<MessageMetadata["origin"]>;

/**
 * berdctl cross-session sends have their own dedicated drain
 * (`useBerdctlQueuedMessageDrain`); the chat queue drains must not claim them.
 */
export function isBerdctlCrossSessionQueuedMessage(
  record: QueuedMessageRecord | null | undefined,
): boolean {
  return (
    record?.kind === "transport-ready" &&
    record.payload.sendOptions?.userMessageMetadata?.origin ===
      BERDCTL_CROSS_SESSION_ORIGIN
  );
}
