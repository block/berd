// Ported from the prototype's Dart ACP client. A `session/update` (or
// `_goose/unstable/session/update`) notification and its update wrapper.

export interface AcpNotification {
  sessionId: string;
  update: AcpUpdate;
}

/** Tri-state for `_meta.goose.activeRunId`: absent key, explicit null, or id. */
export interface ActiveRunId {
  isPresent: boolean;
  id: string | null;
}

/** Adapter for Berd's shared ACP connection: the GooseClient notification
 *  callback hands `SessionNotification` objects ({ sessionId, update })
 *  directly — no JSON-RPC envelope (the prototype's Rust-pushed event
 *  shape is gone). Same wrapper, same downstream reducer/admission path. */
export function notificationFromSessionUpdate(
  sessionId: unknown,
  update: unknown,
): AcpNotification | null {
  if (
    typeof sessionId !== "string" ||
    typeof update !== "object" ||
    update === null
  ) {
    return null;
  }
  return {
    sessionId,
    update: new AcpUpdate(update as Record<string, unknown>),
  };
}

const asString = (v: unknown): string | null =>
  typeof v === "string" ? v : null;
const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function parseIso8601(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Wrapper for one `update` object inside a session/update notification. */
export class AcpUpdate {
  constructor(readonly raw: Record<string, unknown>) {}

  get kind(): string {
    return asString(this.raw.sessionUpdate) ?? "unknown";
  }

  get messageId(): string | null {
    return asString(this.raw.messageId);
  }

  get content(): Record<string, unknown> | null {
    return asRecord(this.raw.content);
  }

  get toolCallId(): string | null {
    return asString(this.raw.toolCallId);
  }

  get title(): string | null {
    return asString(this.raw.title);
  }

  get status(): string | null {
    return asString(this.raw.status);
  }

  private get meta(): Record<string, unknown> | null {
    return asRecord(this.raw._meta);
  }

  private get gooseMeta(): Record<string, unknown> | null {
    return asRecord(this.meta?.goose);
  }

  /** Distinguishes absent key / explicit null / string id. */
  get activeRunId(): ActiveRunId {
    const goose = this.gooseMeta;
    if (goose === null || !("activeRunId" in goose)) {
      return { isPresent: false, id: null };
    }
    const value = goose.activeRunId;
    return typeof value === "string"
      ? { isPresent: true, id: value }
      : { isPresent: true, id: null };
  }

  get updatedAt(): number | undefined {
    return parseIso8601(this.raw.updatedAt);
  }

  get lastMessageAt(): number | undefined {
    return (
      parseIso8601(this.meta?.lastMessageAt) ??
      parseIso8601(this.raw.lastMessageAt)
    );
  }

  get archivedAt(): number | undefined {
    return (
      parseIso8601(this.meta?.archivedAt) ?? parseIso8601(this.raw.archivedAt)
    );
  }
}
