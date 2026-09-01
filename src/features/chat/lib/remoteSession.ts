/**
 * A remote session runs its backend on an SSH host instead of the local
 * `goose serve` sidecar. Local filesystem checks (missing-dir probes, path
 * resolution, artifact cwd fallbacks) are meaningless for its paths, so
 * load-path code guards on this predicate and passes the session's
 * `workingDir` through verbatim.
 */
export function isRemoteSession(
  session: { remoteHost?: string | null } | null | undefined,
): boolean {
  return Boolean(session?.remoteHost?.trim());
}

/**
 * Ensures the SSH backend for `host` is connected before session traffic is
 * routed to it. Lazily imports the remote-host store so chat modules do not
 * take a static dependency on the remoteHosts feature.
 */
export async function ensureRemoteHostConnected(host: string): Promise<void> {
  const { ensureHostConnected } = await import(
    "@/features/remoteHosts/stores/remoteHostStore"
  );
  await ensureHostConnected(host);
}
