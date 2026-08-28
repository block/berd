import type { GooseClient } from "@aaif/goose-sdk";
import { LOCAL_BACKEND_ID, type AcpBackendId } from "./acpBackendId";
import { getBackendClient } from "./acpConnection";

/**
 * Maps ACP session ids to the backend connection that owns them. Sessions
 * without an entry belong to the local backend.
 */
const sessionBackends = new Map<string, AcpBackendId>();

export function registerSessionBackend(
  sessionId: string,
  backendId: AcpBackendId,
): void {
  sessionBackends.set(sessionId, backendId);
}

export function getSessionBackend(sessionId: string): AcpBackendId {
  return sessionBackends.get(sessionId) ?? LOCAL_BACKEND_ID;
}

/** No-op when the source session is unregistered (implicitly local). */
export function transferSessionBackend(
  fromSessionId: string,
  toSessionId: string,
): void {
  const backendId = sessionBackends.get(fromSessionId);
  if (backendId !== undefined) {
    sessionBackends.set(toSessionId, backendId);
  }
}

export function unregisterSessionBackend(sessionId: string): void {
  sessionBackends.delete(sessionId);
}

export function getClientForSession(sessionId: string): Promise<GooseClient> {
  return getBackendClient(getSessionBackend(sessionId));
}
