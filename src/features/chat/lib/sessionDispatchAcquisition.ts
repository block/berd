import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import type { SessionDispatchReleaseWaiter } from "@/features/chat/lib/sessionTargetCoordinator";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";

export type SessionCreationState = NonNullable<ChatSession["creationState"]>;

/**
 * The target session has not finished backend creation, so its id is still a
 * renderer-local draft the backend has never seen. This is a hold, not a
 * failure: the queued head stays put and drains once creation settles and
 * promotion publishes the backend id.
 */
export class SessionDispatchCreationIncompleteError extends PreCommitSendRejectedError {
  constructor(readonly creationState: SessionCreationState) {
    super(
      creationState === "failed"
        ? "This chat failed to be created, so it cannot accept a message."
        : "This chat is still being created, so it cannot accept a message yet.",
    );
    this.name = "SessionDispatchCreationIncompleteError";
  }
}

export class SessionDispatchContentionError extends Error {
  constructor(readonly waiter: SessionDispatchReleaseWaiter) {
    super("Another send owns this session's dispatch target.");
    this.name = "SessionDispatchContentionError";
  }
}

export class SessionDispatchUnresolvedError extends Error {
  constructor() {
    super("Select a model before sending to this unresolved session.");
    this.name = "SessionDispatchUnresolvedError";
  }
}

export class SessionDispatchMissingError extends Error {
  constructor(sessionId: string) {
    super(`No session "${sessionId}".`);
    this.name = "SessionDispatchMissingError";
  }
}
