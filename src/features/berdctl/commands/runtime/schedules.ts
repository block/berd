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

async function requireIdleSchedule(
  scheduleId: string,
  remediation: string,
): Promise<{
  client: Awaited<ReturnType<typeof getClient>>;
  schedule: ScheduledJobDto | undefined;
}> {
  const client = await getClient();
  const response = await client.goose.GooseUnstableSchedulesList({});
  const schedule = response.jobs.find((job) => job.id === scheduleId);
  if (schedule?.currentlyRunning) {
    throw new Error(
      `Schedule "${scheduleId}" is still running. ${remediation}`,
    );
  }
  return { client, schedule };
}

export async function deleteLiveSchedule(scheduleId: string): Promise<void> {
  const { client, schedule } = await requireIdleSchedule(
    scheduleId,
    `Stop the active run with \`berdctl schedule kill --schedule-id ${scheduleId}\` before removing it.`,
  );
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

export async function pauseLiveSchedule(scheduleId: string): Promise<void> {
  const { client } = await requireIdleSchedule(
    scheduleId,
    `Stop the active run with \`berdctl schedule kill --schedule-id ${scheduleId}\` before pausing it.`,
  );
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
