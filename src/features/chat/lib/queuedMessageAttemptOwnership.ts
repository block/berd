import type { ChatSession } from "../stores/chatSessionStore";
import type { QueuedMessageRecord } from "../stores/chatStore";
import { QueuedMessageOwnershipLostError } from "./preCommitSendRejection";

export function isQueuedMessageAttemptable(
  record: QueuedMessageRecord | null | undefined,
): record is QueuedMessageRecord & { kind: "transport-ready" } {
  return record?.kind === "transport-ready" && !record.editing;
}

export function isQueuedMessageTargetAttemptable(
  record: QueuedMessageRecord | null | undefined,
  session: ChatSession | null | undefined,
): record is QueuedMessageRecord & { kind: "transport-ready" } {
  return (
    isQueuedMessageAttemptable(record) &&
    Boolean(session?.executionTarget) &&
    // A draft session's id is renderer-local until promotion, so dispatching
    // against it reaches the backend with an id it never created. Hold the
    // head instead; promotion clears `creationState` and swaps in the backend
    // id, which notifies the session store and wakes every drain.
    session?.creationState == null
  );
}

export function becameQueuedMessageTargetAttemptable(
  record: QueuedMessageRecord | null | undefined,
  previousRecord: QueuedMessageRecord | null | undefined,
  session: ChatSession | null | undefined,
  previousSession: ChatSession | null | undefined,
): record is QueuedMessageRecord & { kind: "transport-ready" } {
  return (
    record === previousRecord &&
    !isQueuedMessageTargetAttemptable(previousRecord, previousSession) &&
    isQueuedMessageTargetAttemptable(record, session)
  );
}

export function assertQueuedMessageAttemptOwned(
  current: QueuedMessageRecord | null | undefined,
  expected: QueuedMessageRecord & { kind: "transport-ready" },
): void {
  if (
    !isQueuedMessageAttemptable(current) ||
    current.recordId !== expected.recordId ||
    current.payload !== expected.payload
  ) {
    throw new QueuedMessageOwnershipLostError();
  }
}
