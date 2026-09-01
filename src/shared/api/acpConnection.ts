import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_GOOSE_MCP_HOST_CAPABILITIES,
  GooseClient,
  type GooseInitializeRequest,
} from "@aaif/goose-sdk";
import {
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import packageJson from "../../../package.json";
import { REMOTE_SSH_SESSIONS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  getExperiment,
  subscribeToExperimentChanges,
} from "@/features/experiments/experimentPreferences";
import {
  LOCAL_BACKEND_ID,
  compositeSessionId,
  remoteHostFromBackendId,
  type AcpBackendId,
} from "./acpBackendId";
import { createWebSocketStream } from "./createWebSocketStream";
import { perfLog } from "@/shared/lib/perfLog";

let notificationHandler: AcpNotificationHandler | null = null;
const sessionNotificationInterceptors =
  new Set<SessionNotificationInterceptor>();

export interface AcpNotificationHandler {
  handleSessionNotification(notification: SessionNotification): Promise<void>;
}

export type SessionNotificationInterceptor = (
  notification: SessionNotification,
) => boolean;

export function setNotificationHandler(handler: AcpNotificationHandler): void {
  notificationHandler = handler;
}

/**
 * Registers a short-lived interceptor for private/background ACP sessions.
 * Returning true consumes the notification so it is not added to the visible
 * chat store.
 */
export function interceptSessionNotifications(
  interceptor: SessionNotificationInterceptor,
): () => void {
  sessionNotificationInterceptors.add(interceptor);
  return () => sessionNotificationInterceptors.delete(interceptor);
}

/**
 * Handles ACP permission requests. When set, `requestPermission` delegates to
 * it; otherwise the connection falls back to auto-approving (preserving the
 * default behavior for environments where no handler is registered).
 */
export type PermissionRequestHandler = (
  request: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;

let permissionHandler: PermissionRequestHandler | null = null;

export function setPermissionHandler(handler: PermissionRequestHandler): void {
  permissionHandler = handler;
}

// The handler slots above are shared by every backend connection: downstream
// routing is sessionId-keyed, so notifications from any backend flow through
// the same callbacks. Wire session ids are only unique per backend, so each
// connection rewrites inbound payloads to the composite renderer-side id
// before they reach the shared handlers; the local backend stays a
// byte-identical passthrough.
function createClientCallbacks(backendId: AcpBackendId): () => Client {
  const toRendererSessionId = <T extends { sessionId: string }>(
    payload: T,
  ): T =>
    backendId === LOCAL_BACKEND_ID
      ? payload
      : {
          ...payload,
          sessionId: compositeSessionId(backendId, payload.sessionId),
        };

  return () => ({
    requestPermission: async (
      args: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      const request = toRendererSessionId(args);
      if (permissionHandler) {
        return permissionHandler(request);
      }
      const optionId = request.options?.[0]?.optionId ?? "approve";
      return {
        outcome: {
          outcome: "selected",
          optionId,
        },
      };
    },

    sessionUpdate: async (
      wireNotification: SessionNotification,
    ): Promise<void> => {
      const notification = toRendererSessionId(wireNotification);
      for (const interceptor of sessionNotificationInterceptors) {
        if (interceptor(notification)) {
          return;
        }
      }
      if (notificationHandler) {
        await notificationHandler.handleSessionNotification(notification);
      }
    },
  });
}

export interface AcpConnection {
  getClient(): Promise<GooseClient>;
  getClientSync(): GooseClient | null;
  isReady(): boolean;
  /**
   * Abort the current transport after an ACP request exceeds its liveness
   * bound. A timed-out request leaves the connection state unknowable;
   * reconnecting is safer than allowing later mutations to race work still
   * running remotely.
   */
  invalidate(): Promise<void>;
  /** Notifies when the active transport closes. Returns an unsubscribe. */
  onClosed(cb: () => void): () => void;
}

interface ResolvedAcpEndpoint {
  wsUrl: string;
  /** Tear down only the remote transport generation this endpoint created. */
  dispose?: () => Promise<void>;
}

type AcpEndpointResolver = () => Promise<string | ResolvedAcpEndpoint>;

function invalidatedConnectionError(): Error {
  return new Error("ACP connection initialization was invalidated");
}

export function createAcpConnection(
  resolveEndpoint: AcpEndpointResolver,
  backendId: AcpBackendId = LOCAL_BACKEND_ID,
  assertAvailable?: () => void,
): AcpConnection {
  let clientPromise: Promise<GooseClient> | null = null;
  let resolvedClient: GooseClient | null = null;
  let activeStream: ReturnType<typeof createWebSocketStream> | null = null;
  let activeEndpointCleanup: (() => Promise<void>) | null = null;
  let invalidationGeneration = 0;
  const closedListeners = new Set<() => void>();
  const cleanedStreams = new WeakSet<object>();

  function assertInitializationCurrent(expectedGeneration: number): void {
    assertAvailable?.();
    if (invalidationGeneration !== expectedGeneration) {
      throw invalidatedConnectionError();
    }
  }

  function onceAsync(fn: (() => Promise<void>) | undefined) {
    if (!fn) return null;
    let called = false;
    return async () => {
      if (called) return;
      called = true;
      await fn();
    };
  }

  async function cleanupOwnedTransport(
    stream: ReturnType<typeof createWebSocketStream> | null,
    cleanupEndpoint: (() => Promise<void>) | null,
  ): Promise<void> {
    if (stream && activeStream === stream) {
      activeStream = null;
    }
    if (cleanupEndpoint && activeEndpointCleanup === cleanupEndpoint) {
      activeEndpointCleanup = null;
    }
    const cleanupTasks: Promise<unknown>[] = [];
    if (stream && !cleanedStreams.has(stream)) {
      cleanedStreams.add(stream);
      cleanupTasks.push(stream.writable.abort());
    }
    if (cleanupEndpoint) {
      cleanupTasks.push(cleanupEndpoint());
    }
    await Promise.allSettled(cleanupTasks);
  }

  function monitorConnection(
    client: GooseClient,
    stream: ReturnType<typeof createWebSocketStream>,
  ): void {
    const clearCurrentConnection = () => {
      if (activeStream !== stream) {
        return;
      }
      resolvedClient = null;
      clientPromise = null;
      activeStream = null;
      activeEndpointCleanup = null;
      for (const listener of closedListeners) {
        listener();
      }
    };
    client.closed
      .then(() => {
        console.warn(
          "[acp] Connection closed. Will reconnect on next getClient().",
        );
        clearCurrentConnection();
      })
      .catch(() => {
        console.warn(
          "[acp] Connection error. Will reconnect on next getClient().",
        );
        clearCurrentConnection();
      });
  }

  async function invalidate(): Promise<void> {
    invalidationGeneration += 1;
    const stream = activeStream;
    const cleanupEndpoint = activeEndpointCleanup;
    activeStream = null;
    activeEndpointCleanup = null;
    resolvedClient = null;
    clientPromise = null;
    await cleanupOwnedTransport(stream, cleanupEndpoint);
  }

  async function initializeConnection(
    expectedGeneration: number,
  ): Promise<GooseClient> {
    assertInitializationCurrent(expectedGeneration);
    const tStart = performance.now();
    const resolvedEndpoint = await resolveEndpoint();
    const endpoint =
      typeof resolvedEndpoint === "string"
        ? { wsUrl: resolvedEndpoint }
        : resolvedEndpoint;
    const cleanupEndpoint = onceAsync(endpoint.dispose);
    try {
      assertInitializationCurrent(expectedGeneration);
    } catch (error) {
      await cleanupOwnedTransport(null, cleanupEndpoint);
      throw error;
    }
    perfLog(
      `[perf:conn] get_goose_serve_url in ${(performance.now() - tStart).toFixed(1)}ms`,
    );

    const tStream = performance.now();
    const stream = createWebSocketStream(endpoint.wsUrl);
    activeStream = stream;
    activeEndpointCleanup = cleanupEndpoint;

    const client = new GooseClient(createClientCallbacks(backendId), stream);
    perfLog(
      `[perf:conn] ws stream + client created in ${(performance.now() - tStream).toFixed(1)}ms`,
    );

    const tInit = performance.now();
    try {
      await client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          _meta: {
            goose: {
              mcpHostCapabilities: DEFAULT_GOOSE_MCP_HOST_CAPABILITIES,
              toolCallLabelEnrichment: true,
            },
          },
        },
        clientInfo: {
          name: packageJson.name,
          version: packageJson.version,
        },
      } satisfies GooseInitializeRequest);
      assertInitializationCurrent(expectedGeneration);
    } catch (error) {
      await cleanupOwnedTransport(stream, cleanupEndpoint);
      throw error;
    }
    perfLog(
      `[perf:conn] client.initialize in ${(performance.now() - tInit).toFixed(1)}ms (total ${(performance.now() - tStart).toFixed(1)}ms)`,
    );

    monitorConnection(client, stream);

    return client;
  }

  async function getClient(): Promise<GooseClient> {
    assertAvailable?.();
    if (resolvedClient) {
      return resolvedClient;
    }

    if (!clientPromise) {
      perfLog("[perf:conn] getClient() → initializing new ACP connection");
      const expectedGeneration = invalidationGeneration;
      const initialization = initializeConnection(expectedGeneration)
        .then((client) => {
          resolvedClient = client;
          return client;
        })
        .catch((error) => {
          if (clientPromise === initialization) {
            clientPromise = null;
          }
          throw error;
        });
      clientPromise = initialization;
    } else {
      perfLog(
        "[perf:conn] getClient() awaiting in-flight initializeConnection",
      );
    }

    return clientPromise;
  }

  return {
    getClient,
    getClientSync: () => resolvedClient,
    isReady: () => resolvedClient !== null,
    invalidate,
    onClosed: (cb: () => void) => {
      closedListeners.add(cb);
      return () => closedListeners.delete(cb);
    },
  };
}

async function resolveLocalWsUrl(): Promise<string> {
  // Dev-only: inject a real failure into startup so the WARP probe runs
  // for real against kgoose. `VITE_DEV_STARTUP_ERROR=warp just dev` lets
  // us experience the diagnostic UI with whatever real WARP state the
  // machine has, rather than simulating the probe result.
  if (import.meta.env.DEV) {
    const variant = import.meta.env.VITE_DEV_STARTUP_ERROR;
    // Treat empty string as unset so an accidental `VITE_DEV_STARTUP_ERROR=`
    // in a shell profile or `.env.local` doesn't lock the app into the
    // diagnostic UI with no way out.
    if (typeof variant === "string" && variant !== "") {
      if (variant === "goose-serve") {
        throw new Error(
          "Failed to spawn goose serve (binary: goosed): simulated dev failure",
        );
      }
      if (variant === "unknown") {
        throw new Error("Simulated dev startup failure");
      }
      // Default ("warp" or anything else non-empty) mimics the upstream
      // "Invalid params" we saw in the wild — the probe decides the copy.
      throw new Error("Invalid params (simulated dev failure)");
    }
  }

  return await invoke("get_goose_serve_url");
}

const connections = new Map<AcpBackendId, AcpConnection>();

function remoteSessionsEnabled(): boolean {
  return getExperiment(REMOTE_SSH_SESSIONS_EXPERIMENT_ID)?.enabled === true;
}

function assertRemoteSessionsEnabled(): void {
  if (!remoteSessionsEnabled()) {
    throw new Error(
      "Remote SSH sessions are disabled in Experimental Features",
    );
  }
}

function createBackendConnection(backendId: AcpBackendId): AcpConnection {
  if (backendId === LOCAL_BACKEND_ID) {
    return createAcpConnection(resolveLocalWsUrl);
  }
  const host = remoteHostFromBackendId(backendId);
  if (!host) {
    throw new Error(`Unknown ACP backend id: ${backendId}`);
  }
  return createAcpConnection(
    async () => {
      const { connectRemoteHost, disconnectRemoteHost } = await import(
        "./remoteHosts"
      );
      const remote = await connectRemoteHost(host);
      return {
        wsUrl: remote.wsUrl,
        dispose: () => disconnectRemoteHost(host, remote.generation),
      };
    },
    backendId,
    assertRemoteSessionsEnabled,
  );
}

export function getBackendConnection(backendId: AcpBackendId): AcpConnection {
  if (backendId !== LOCAL_BACKEND_ID) {
    assertRemoteSessionsEnabled();
  }
  let connection = connections.get(backendId);
  if (!connection) {
    connection = createBackendConnection(backendId);
    connections.set(backendId, connection);
  }
  return connection;
}

export function getBackendClient(
  backendId: AcpBackendId,
): Promise<GooseClient> {
  return getBackendConnection(backendId).getClient();
}

export async function invalidateBackendConnection(
  backendId: AcpBackendId,
): Promise<void> {
  await connections.get(backendId)?.invalidate();
}

// Renderer reconciliation removes remote sessions and tunnels, while this
// lower-level subscription makes the transport itself authoritative. It also
// closes clients already cached by non-React callers in this window.
subscribeToExperimentChanges(() => {
  if (remoteSessionsEnabled()) return;
  for (const [backendId, connection] of connections) {
    if (backendId !== LOCAL_BACKEND_ID) {
      void connection.invalidate();
    }
  }
});

/**
 * Abort the current transport after an ACP request exceeds its liveness bound.
 * A timed-out request leaves the connection state unknowable; reconnecting is
 * safer than allowing later mutations to race work still running remotely.
 */
export async function invalidateClientConnection(): Promise<void> {
  await invalidateBackendConnection(LOCAL_BACKEND_ID);
}

export async function getClient(): Promise<GooseClient> {
  return getBackendConnection(LOCAL_BACKEND_ID).getClient();
}

export function isClientReady(): boolean {
  return getBackendConnection(LOCAL_BACKEND_ID).isReady();
}

export function getClientSync(): GooseClient | null {
  return getBackendConnection(LOCAL_BACKEND_ID).getClientSync();
}
