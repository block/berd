import { invoke } from "@tauri-apps/api/core";

export interface McpAppSandboxRequest {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
  scriptDomains: string[];
  colorScheme: "light" | "dark";
  documentBinding: string;
  documentDigest: string;
  ipcNonce: string;
}

export interface McpAppSandboxInfo {
  proxyUrl: string;
}

export async function createMcpAppSandbox(
  request: McpAppSandboxRequest,
): Promise<McpAppSandboxInfo> {
  return invoke<McpAppSandboxInfo>("create_mcp_app_sandbox", { request });
}
