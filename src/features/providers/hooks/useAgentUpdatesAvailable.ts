import { describeAgentVersion } from "@/features/settings/lib/agentVersionDisplay";
import { useAgentProviderStatus } from "./useAgentProviderStatus";

export function useAgentUpdatesAvailable(): boolean {
  const { agentChecks } = useAgentProviderStatus();
  for (const check of agentChecks.values()) {
    if (describeAgentVersion(check)?.hasActionableUpdate) return true;
  }
  return false;
}
