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
import { createWebSocketStream } from "./createWebSocketStream";
import { perfLog } from "@/shared/lib/perfLog";

let notificationHandler: AcpNotificationHandler | null = null;

export interface AcpNotificationHandler {
  handleSessionNotification(notification: SessionNotification): Promise<void>;
}

export function setNotificationHandler(handler: AcpNotificationHandler): void {
  notificationHandler = handler;
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

let clientPromise: Promise<GooseClient> | null = null;
let resolvedClient: GooseClient | null = null;

function createClientCallbacks(): () => Client {
  return () => ({
    requestPermission: async (
      args: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      if (permissionHandler) {
        return permissionHandler(args);
      }
      const optionId = args.options?.[0]?.optionId ?? "approve";
      return {
        outcome: {
          outcome: "selected",
          optionId,
        },
      };
    },

    sessionUpdate: async (notification: SessionNotification): Promise<void> => {
      if (notificationHandler) {
        await notificationHandler.handleSessionNotification(notification);
      }
    },
  });
}

function monitorConnection(client: GooseClient): void {
  client.closed
    .then(() => {
      console.warn(
        "[acp] Connection closed. Will reconnect on next getClient().",
      );
      resolvedClient = null;
      clientPromise = null;
    })
    .catch(() => {
      console.warn(
        "[acp] Connection error. Will reconnect on next getClient().",
      );
      resolvedClient = null;
      clientPromise = null;
    });
}

async function initializeConnection(): Promise<GooseClient> {
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

  const tStart = performance.now();
  const wsUrl: string = await invoke("get_goose_serve_url");
  perfLog(
    `[perf:conn] get_goose_serve_url in ${(performance.now() - tStart).toFixed(1)}ms`,
  );

  const tStream = performance.now();
  const stream = createWebSocketStream(wsUrl);

  const client = new GooseClient(createClientCallbacks(), stream);
  perfLog(
    `[perf:conn] ws stream + client created in ${(performance.now() - tStream).toFixed(1)}ms`,
  );

  const tInit = performance.now();
  await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      _meta: {
        goose: {
          mcpHostCapabilities: DEFAULT_GOOSE_MCP_HOST_CAPABILITIES,
        },
      },
    },
    clientInfo: {
      name: packageJson.name,
      version: packageJson.version,
    },
  } satisfies GooseInitializeRequest);
  perfLog(
    `[perf:conn] client.initialize in ${(performance.now() - tInit).toFixed(1)}ms (total ${(performance.now() - tStart).toFixed(1)}ms)`,
  );

  monitorConnection(client);

  return client;
}

export async function getClient(): Promise<GooseClient> {
  if (resolvedClient) {
    return resolvedClient;
  }

  if (!clientPromise) {
    perfLog("[perf:conn] getClient() → initializing new ACP connection");
    clientPromise = initializeConnection()
      .then((client) => {
        resolvedClient = client;
        return client;
      })
      .catch((error) => {
        clientPromise = null;
        throw error;
      });
  } else {
    perfLog("[perf:conn] getClient() awaiting in-flight initializeConnection");
  }

  return clientPromise;
}

export function isClientReady(): boolean {
  return resolvedClient !== null;
}

export function getClientSync(): GooseClient | null {
  return resolvedClient;
}
