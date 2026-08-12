import type { SessionDispatchReleaseWaiter } from "@/features/chat/lib/sessionTargetCoordinator";

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
