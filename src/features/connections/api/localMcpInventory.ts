import { invoke } from "@tauri-apps/api/core";

export type McpHarnessId = "goose" | "claudeCode" | "codex";
export type McpConfigScope =
  | "user"
  | "project"
  | "localProject"
  | "profile"
  | "additional";
export type McpTransportKind =
  | "stdio"
  | "http"
  | "sse"
  | "acp"
  | "builtin"
  | "unknown";
export type McpInventoryStatus =
  | "configured"
  | "unavailable"
  | "partial"
  | "error";
export type McpSourceStatus = "found" | "missing" | "error";

export interface McpConfigSource {
  scope: McpConfigScope;
  label: string;
}

export interface McpCheckedLocation extends McpConfigSource {
  status: McpSourceStatus;
}

export interface McpConfiguredServer {
  id: string;
  harness: McpHarnessId;
  source: McpConfigSource;
  configKey: string;
  name: string;
  transport: McpTransportKind;
  identityFingerprint: string;
  enabled?: boolean | null;
}

export interface McpHarnessInventory {
  harness: McpHarnessId;
  status: McpInventoryStatus;
  checkedLocations: McpCheckedLocation[];
  servers: McpConfiguredServer[];
  message?: string | null;
}

export interface McpInventory {
  harnesses: McpHarnessInventory[];
}

export const LOCAL_MCP_INVENTORY_QUERY_KEY = ["mcp-inventory"] as const;

export async function listLocalMcpInventory(
  workspacePaths: string[] = [],
): Promise<McpInventory> {
  return invoke<McpInventory>("list_local_mcp_inventory", {
    workspacePaths,
  });
}
