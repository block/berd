import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getGoosePathForHost } from "@/features/remoteHosts/lib/gooseBinaryOverride";

/**
 * Error shape thrown by the remote-backend Tauri commands. `kind` is a
 * kebab-case discriminator such as "auth-failed", "goose-not-installed",
 * "invalid-host", "host-key-unverified", "host-unreachable", "ssh-not-found",
 * "ready-timeout", "tunnel-closed", "remote-script-failed",
 * "local-port-bind-failed", "remote-port-bind-failed", "daemon-conflict",
 * or "internal".
 */
export interface RemoteBackendErrorLike {
  kind: string;
  message: string;
  daemonInstance?: {
    pid: number;
    startedAt: string;
    gooseVersion: string;
    binary?: string;
    instanceToken: string;
  };
}

export function isRemoteBackendError(x: unknown): x is RemoteBackendErrorLike {
  if (!x || typeof x !== "object") return false;
  const candidate = x as Partial<RemoteBackendErrorLike>;
  return (
    typeof candidate.kind === "string" && typeof candidate.message === "string"
  );
}

export interface RemoteBackendConnection {
  wsUrl: string;
  httpBaseUrl: string;
  secretKey: string;
  localPort: number;
  gooseVersion: string;
  daemonReused: boolean;
  generation: number;
}

export type RemoteBackendState =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "disconnected"
  | "failed";

// Mirrors the `berd:remote-backend-status` event emitted by the Rust
// remote-backend manager. `state` discriminates the flattened tagged union.
export const REMOTE_BACKEND_STATUS_EVENT = "berd:remote-backend-status";

export interface RemoteBackendStatusPayload {
  host: string;
  state: RemoteBackendState;
  wsUrl?: string;
  httpBaseUrl?: string;
  localPort?: number;
  attempt?: number;
  error?: RemoteBackendErrorLike;
}

/** One entry from the `list_remote_backends` snapshot. */
export interface RemoteBackendSnapshotEntry {
  host: string;
  state: RemoteBackendState;
  wsUrl?: string;
  httpBaseUrl?: string;
  localPort?: number;
  attempt?: number;
  error?: RemoteBackendErrorLike;
}

/** Result of probing one agent binary on the remote host. */
export interface RemoteToolProbe {
  binary: string;
  found: boolean;
  version?: string;
  /** Path that answered the probe (an override, or the PATH resolution). */
  path?: string;
}

export interface RemoteDirEntry {
  name: string;
  isDir: boolean;
}

export interface RemoteDirListing {
  resolvedPath: string;
  entries: RemoteDirEntry[];
}

/** Concrete `Host` aliases from `~/.ssh/config` (no wildcards). */
export async function listSshConfigHosts(): Promise<string[]> {
  return await invoke("list_ssh_config_hosts");
}

/**
 * Connect (or reuse the connection) to the Goose daemon on `host`. Idempotent
 * per host; the Rust side serializes concurrent connects.
 *
 * The persisted per-host goose binary override is looked up here rather than
 * threaded through callers, so every connect path (settings, session routing,
 * reconnects) agrees on which binary the host should run.
 */
export async function connectRemoteHost(
  host: string,
): Promise<RemoteBackendConnection> {
  return await invoke("remote_backend_connect", {
    host,
    goosePath: getGoosePathForHost(host) ?? null,
  });
}

/** Tear down the local tunnel to `host`, leaving the remote daemon running. */
export async function disconnectRemoteHost(
  host: string,
  expectedGeneration?: number,
): Promise<void> {
  await invoke("remote_backend_disconnect", {
    host,
    expectedGeneration: expectedGeneration ?? null,
  });
}

/** Stop the remote daemon on `host` and tear down the tunnel. */
export async function shutdownRemoteHost(
  host: string,
  expectedInstanceToken?: string,
): Promise<void> {
  await invoke("remote_backend_shutdown", {
    host,
    expectedInstanceToken: expectedInstanceToken ?? null,
  });
}

/** Snapshot of all known remote backends and their current states. */
export async function listRemoteBackends(): Promise<
  RemoteBackendSnapshotEntry[]
> {
  return await invoke("list_remote_backends");
}

/**
 * Probe `host` for the agent binaries (goose, claude-agent-acp, codex-acp).
 * When the host has a goose binary override, that binary is probed instead of
 * the PATH lookup so the report shows the build Berd would actually run.
 */
export async function checkRemoteHost(
  host: string,
): Promise<RemoteToolProbe[]> {
  return await invoke("check_remote_host", {
    host,
    goosePath: getGoosePathForHost(host) ?? null,
  });
}

/**
 * List directories on `host`. `path` must be absolute or start with `~`.
 */
export async function listRemoteDirs(
  host: string,
  path: string,
): Promise<RemoteDirListing> {
  return await invoke("list_remote_dirs", { host, path });
}

// Fires whenever a remote backend transitions state (connecting, ready,
// reconnecting, disconnected, failed).
export function listenRemoteBackendStatus(
  handler: (payload: RemoteBackendStatusPayload) => void,
): Promise<UnlistenFn> {
  if (!window.__TAURI_INTERNALS__) {
    return Promise.resolve(() => {});
  }

  return listen<RemoteBackendStatusPayload>(
    REMOTE_BACKEND_STATUS_EVENT,
    (event) => handler(event.payload),
  );
}
