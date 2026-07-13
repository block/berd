import { readinessFromReport } from "@/features/providers/hooks/useAgentProviderStatus";
import { runDoctor } from "@/shared/api/doctor";

export async function isExternalAgentReady(
  providerId: string,
): Promise<boolean> {
  const report = await runDoctor();
  return readinessFromReport(report).get(providerId) === "ready";
}
