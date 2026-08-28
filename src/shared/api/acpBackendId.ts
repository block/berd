/**
 * Identifies which ACP backend a connection or session belongs to. The local
 * `goose serve` sidecar is `"local"`; SSH-remote backends are keyed by host.
 */
export type AcpBackendId = "local" | `ssh:${string}`;

export const LOCAL_BACKEND_ID: AcpBackendId = "local";

const SSH_PREFIX = "ssh:";

export function sshBackendId(host: string): AcpBackendId {
  return `${SSH_PREFIX}${host.trim()}`;
}

/** Host component of an SSH backend id, or null for the local backend. */
export function remoteHostFromBackendId(id: AcpBackendId): string | null {
  return id === LOCAL_BACKEND_ID ? null : id.slice(SSH_PREFIX.length);
}

export function backendIdForSession(
  session: { remoteHost?: string | null } | null | undefined,
): AcpBackendId {
  const host = session?.remoteHost?.trim();
  return host ? sshBackendId(host) : LOCAL_BACKEND_ID;
}
