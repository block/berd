import { invoke } from "@tauri-apps/api/core";
import { normalizeKgooseJson } from "@/shared/api/kgooseJson";

export interface Connection {
  name: string;
  created?: string;
  updated?: string;
  expiresAtEpochS?: number;
  previouslyConnected?: boolean;
}

export interface ListConnectionsResponse {
  connections: Connection[];
}

export const CONNECTIONS_QUERY_KEY = ["connections"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asConnection(value: unknown): Connection | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name : null;
  if (!name) return null;
  return {
    name,
    created: typeof value.created === "string" ? value.created : undefined,
    updated: typeof value.updated === "string" ? value.updated : undefined,
    expiresAtEpochS:
      typeof value.expiresAtEpochS === "number"
        ? value.expiresAtEpochS
        : undefined,
    previouslyConnected:
      typeof value.previouslyConnected === "boolean"
        ? value.previouslyConnected
        : undefined,
  };
}

function asListConnectionsResponse(value: unknown): ListConnectionsResponse {
  const normalized = normalizeKgooseJson(value);
  if (!isRecord(normalized)) return { connections: [] };

  // `extensions` is the kgoose proto field (ListOAuthExtensionsResponse.extensions).
  const list = Array.isArray(normalized.extensions)
    ? normalized.extensions
    : [];

  return {
    connections: list
      .map(asConnection)
      .filter((entry): entry is Connection => entry !== null),
  };
}

export async function listConnections(): Promise<ListConnectionsResponse> {
  const response = await invoke<unknown>("list_connections");
  return asListConnectionsResponse(response);
}

// Revokes the stored OAuth token for one provider via kgoose's
// delete-oauth-extension endpoint. The provider then lists as disconnected.
export async function disconnectConnection(provider: string): Promise<void> {
  await invoke("disconnect_connection", { extension: provider });
}
