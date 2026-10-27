import type { ScheduledJobDto } from "@aaif/goose-sdk";
import { getClient } from "@/shared/api/acpConnection";

export const LOCAL_SCHEDULES_QUERY_KEY = ["local-goose-schedules"] as const;
export const LOCAL_SCHEDULES_REFETCH_INTERVAL_MS = 15_000;

export async function listLocalSchedules(): Promise<ScheduledJobDto[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableSchedulesList({});
  return response.jobs;
}
