/**
 * An expected rejection at the last reversible send boundary. The prompt has
 * not committed local transcript state, so sendCore must leave runtime state
 * untouched for whichever owner currently controls the session.
 */
export class PreCommitSendRejectedError extends Error {}

export class QueuedMessageOwnershipLostError extends PreCommitSendRejectedError {
  constructor() {
    super("The queued prompt was canceled.");
    this.name = "QueuedMessageOwnershipLostError";
  }
}
