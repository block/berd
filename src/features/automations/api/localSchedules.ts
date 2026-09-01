import { getClient } from "@/shared/api/acpConnection";
import type { ScheduledJobDto } from "@aaif/goose-sdk";

export const LOCAL_SCHEDULES_QUERY_KEY = ["local-goose-schedules"] as const;

export async function listLocalSchedules(): Promise<ScheduledJobDto[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableSchedulesList({});
  return response.jobs;
}

export async function pauseLocalSchedule(scheduleId: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSchedulesPause({ scheduleId });
}

export async function unpauseLocalSchedule(scheduleId: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSchedulesUnpause({ scheduleId });
}

export async function removeLocalSchedule(scheduleId: string): Promise<void> {
  const client = await getClient();
  const { jobs } = await client.goose.GooseUnstableSchedulesList({});
  const schedule = jobs.find((job) => job.id === scheduleId);
  if (schedule?.currentlyRunning) {
    throw new Error(
      `Schedule "${scheduleId}" is still running. Stop the active run before removing it.`,
    );
  }
  const pausedForRemoval = schedule != null && !schedule.paused;
  if (pausedForRemoval) {
    await client.goose.GooseUnstableSchedulesPause({ scheduleId });
  }
  try {
    await client.goose.GooseUnstableSchedulesDelete({ scheduleId });
  } catch (error) {
    if (pausedForRemoval) {
      await client.goose.GooseUnstableSchedulesUnpause({ scheduleId });
    }
    throw error;
  }
}

export async function killLocalScheduleRun(scheduleId: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSchedulesRunningJobKill({
    jobId: scheduleId,
  });
}
