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

const COMPOSITE_SEPARATOR = "#";

/**
 * Renderer-side session id. Goose session ids ("wire ids", e.g. `20260828_2`)
 * are only unique per backend, so a remote session's renderer id embeds its
 * backend: `ssh:<host>#<wireId>`. Local sessions keep their bare wire id.
 * `#` cannot appear in a host: the Rust side restricts hosts to
 * alphanumerics plus `.-_@:`.
 */
export function compositeSessionId(
  backendId: AcpBackendId,
  wireSessionId: string,
): string {
  return backendId === LOCAL_BACKEND_ID
    ? wireSessionId
    : `${backendId}${COMPOSITE_SEPARATOR}${wireSessionId}`;
}

export function isCompositeSessionId(id: string): boolean {
  return id.startsWith(SSH_PREFIX) && id.includes(COMPOSITE_SEPARATOR);
}

/**
 * Splits a composite renderer session id into its backend and wire parts, or
 * returns null for a bare (local) id.
 */
export function splitCompositeSessionId(
  id: string,
): { backendId: AcpBackendId; wireSessionId: string } | null {
  if (!isCompositeSessionId(id)) {
    return null;
  }
  const separatorIndex = id.lastIndexOf(COMPOSITE_SEPARATOR);
  return {
    backendId: id.slice(0, separatorIndex) as AcpBackendId,
    wireSessionId: id.slice(separatorIndex + 1),
  };
}
