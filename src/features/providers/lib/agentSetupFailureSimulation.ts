import type { ProviderDisplayInfo } from "@/shared/types/providers";

export const AGENT_SETUP_FAILURE_SIMULATION_KEY = "goose:dev:agentSetupFailure";

type AgentSetupFailureSimulationKind = "existing_file" | "unsupported_platform";

interface AgentSetupFailureSimulation {
  providerId: string;
  kind: AgentSetupFailureSimulationKind;
  path?: string;
}

function isDevRuntime() {
  return import.meta.env.DEV;
}

function parseSimulation(
  raw: string | null,
): AgentSetupFailureSimulation | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AgentSetupFailureSimulation>;
    if (!parsed.providerId) return null;
    return {
      providerId: parsed.providerId,
      kind:
        parsed.kind === "unsupported_platform"
          ? "unsupported_platform"
          : "existing_file",
      path: parsed.path,
    };
  } catch {
    return {
      providerId: raw,
      kind: "existing_file",
    };
  }
}

export function getAgentSetupFailureSimulation(
  providerId: string,
): AgentSetupFailureSimulation | null {
  if (!isDevRuntime() || typeof window === "undefined") return null;

  const simulation = parseSimulation(
    window.localStorage.getItem(AGENT_SETUP_FAILURE_SIMULATION_KEY),
  );

  return simulation?.providerId === providerId ? simulation : null;
}

export function getSimulatedAgentSetupFailureLines(
  provider: ProviderDisplayInfo,
  simulation: AgentSetupFailureSimulation,
): string[] {
  if (simulation.kind === "unsupported_platform") {
    return [
      "npm error code EBADPLATFORM",
      `npm error notsup Unsupported platform for ${provider.displayName}`,
      'npm error notsup wanted {"os":"win32","cpu":"x64"} (current: {"os":"darwin","cpu":"arm64"})',
    ];
  }

  const binaryName = provider.binaryName ?? provider.id;
  const path = simulation.path ?? `/opt/homebrew/bin/${binaryName}`;

  return [
    "npm error code EEXIST",
    `npm error path ${path}`,
    "npm error EEXIST: file already exists",
  ];
}
