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

/// Install a missing agent component. `fixType` selects which recipe runs:
/// `'command'` (the default) installs the agent's own CLI, `'bridge'` installs
/// its ACP adapter. A bridge-missing check reports `fixType="bridge"`, so the
/// serial fix chain forwards that here instead of always installing the CLI.
export async function installAgent(
  providerId: string,
  fixType: FixType = "command",
): Promise<void> {
  return invoke("install_agent", { providerId, fixType });
}

export async function authenticateAgent(providerId: string): Promise<void> {
  return invoke("authenticate_agent", { providerId });
}

/// The install recipe the agent still needs after the last install, or null.
/// Drives runInstall's install loop so a from-scratch two-binary agent installs
/// its CLI *and* its ACP bridge in one click instead of needing a second press.
export async function nextAgentInstallFix(
  providerId: string,
): Promise<FixType | null> {
  return invoke("next_agent_install_fix", { providerId });
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
