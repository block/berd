import type { QueryClient } from "@tanstack/react-query";
import { readinessFromReport } from "@/features/providers/hooks/useAgentProviderStatus";
import { prefetchDoctorReport } from "@/shared/api/useDoctorReport";

export async function isExternalAgentReady(
  providerId: string,
  queryClient: QueryClient,
): Promise<boolean> {
  const report = await prefetchDoctorReport(queryClient);
  return readinessFromReport(report).get(providerId) === "ready";
}
