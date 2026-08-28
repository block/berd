import type { ScheduledJobDto } from "@aaif/goose-sdk";

import { getClient } from "@/shared/api/acpConnection";

export interface BerdctlSchedule {
  id: string;
  source: string;
  cron: string;
  last_run: string | null;
  currently_running: boolean;
  paused: boolean;
  current_session_id: string | null;
  job_start_time: string | null;
}

function normalizeSchedule(job: ScheduledJobDto): BerdctlSchedule {
  return {
    id: job.id,
    source: job.source,
    cron: job.cron,
    last_run: job.lastRun ?? null,
    currently_running: job.currentlyRunning,
    paused: job.paused,
    current_session_id: job.currentSessionId ?? null,
    job_start_time: job.jobStartTime ?? null,
  };
}

export async function listLiveSchedules(): Promise<BerdctlSchedule[]> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableSchedulesList({});
  return response.jobs.map(normalizeSchedule);
}

export async function deleteLiveSchedule(scheduleId: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSchedulesDelete({ scheduleId });
}

export async function pauseLiveSchedule(scheduleId: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSchedulesPause({ scheduleId });
}

export async function unpauseLiveSchedule(scheduleId: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstableSchedulesUnpause({ scheduleId });
}

export async function killLiveSchedule(scheduleId: string): Promise<string> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableSchedulesRunningJobKill({
    jobId: scheduleId,
  });
  return response.message;
}
