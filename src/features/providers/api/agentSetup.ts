import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { FixType } from "@/shared/api/doctor";

interface AgentSetupOutput {
  providerId: string;
  line: string;
}

export async function checkAgentInstalled(
  providerId: string,
): Promise<boolean> {
  return invoke("check_agent_installed", { providerId });
}

export async function installAgent(providerId: string): Promise<void> {
  return invoke("install_agent", { providerId });
}

export async function authenticateAgent(providerId: string): Promise<void> {
  return invoke("authenticate_agent", { providerId });
}

/// Run a per-readout source-aware update command for an agent. `fixType` is
/// `'updateMain'` or `'updateBridge'` and `commandOverride` is the readout's
/// `updateCommand` (e.g. `npm install -g <pkg>@latest`).
export async function updateAgent(
  providerId: string,
  fixType: FixType,
  commandOverride: string,
): Promise<void> {
  return invoke("update_agent", { providerId, fixType, commandOverride });
}

export function onAgentSetupOutput(
  providerId: string,
  callback: (line: string) => void,
): Promise<UnlistenFn> {
  return listen<AgentSetupOutput>("agent-setup:output", (event) => {
    if (event.payload.providerId === providerId) {
      callback(event.payload.line);
    }
  });
}
