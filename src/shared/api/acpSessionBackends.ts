import type { GooseClient } from "@aaif/goose-sdk";
import {
  LOCAL_BACKEND_ID,
  splitCompositeSessionId,
  type AcpBackendId,
} from "./acpBackendId";
import { getBackendClient } from "./acpConnection";

interface SessionBackendEntry {
  backendId: AcpBackendId;
  /** Bare ACP session id understood by the owning backend. */
  wireSessionId: string;
}

/**
 * Maps renderer-side session ids to the backend connection that owns them and
 * the bare wire id that backend understands. Renderer ids for remote sessions
 * are composite (`ssh:<host>#<wireId>`); local sessions use the wire id
 * directly. Sessions without an entry fall back to parsing the composite id,
 * then to the local backend.
 */
const sessionBackends = new Map<string, SessionBackendEntry>();

export function registerSessionBackend(
  sessionId: string,
  backendId: AcpBackendId,
  wireSessionId?: string,
): void {
  sessionBackends.set(sessionId, {
    backendId,
    // Callers that only hold the renderer id may omit the wire id; a
    // composite id carries its own wire id, everything else is already bare.
    wireSessionId:
      wireSessionId ??
      splitCompositeSessionId(sessionId)?.wireSessionId ??
      sessionId,
  });
}

export function getSessionBackend(sessionId: string): AcpBackendId {
  const entry = sessionBackends.get(sessionId);
  if (entry) {
    return entry.backendId;
  }
  // Restart safety: a composite id can arrive before rehydration re-registers
  // it (or after a registry wipe). The backend is recoverable from the prefix.
  return splitCompositeSessionId(sessionId)?.backendId ?? LOCAL_BACKEND_ID;
}

/** Bare ACP id to send over the wire for a renderer-side session id. */
export function getWireSessionId(sessionId: string): string {
  const entry = sessionBackends.get(sessionId);
  if (entry) {
    return entry.wireSessionId;
  }
  return splitCompositeSessionId(sessionId)?.wireSessionId ?? sessionId;
}

/** No-op when the source session is unregistered (implicitly local). */
export function transferSessionBackend(
  fromSessionId: string,
  toSessionId: string,
): void {
  const fromEntry = sessionBackends.get(fromSessionId);
  if (fromEntry === undefined) {
    return;
  }
  // The destination keeps its own wire id: an already-registered target (e.g.
  // a composite id registered by newSession) must not inherit the source's
  // wire id, and an unregistered target derives its own from its shape.
  const existing = sessionBackends.get(toSessionId);
  const wireSessionId =
    existing?.wireSessionId ??
    splitCompositeSessionId(toSessionId)?.wireSessionId ??
    toSessionId;
  sessionBackends.set(toSessionId, {
    backendId: fromEntry.backendId,
    wireSessionId,
  });
}

export function unregisterSessionBackend(sessionId: string): void {
  sessionBackends.delete(sessionId);
}

export function getClientForSession(sessionId: string): Promise<GooseClient> {
  return getBackendClient(getSessionBackend(sessionId));
}
