import type { ScheduledJobDto } from "@aaif/goose-sdk";
import { LocalScheduleRequestError } from "@/features/automations/lib/localScheduleErrors";
import {
  captureBackendConnectionGeneration,
  getClient,
} from "@/shared/api/acpConnection";
import { LOCAL_BACKEND_ID } from "@/shared/api/acpBackendId";

export const LOCAL_SCHEDULES_QUERY_KEY = ["local-goose-schedules"] as const;
export const LOCAL_SCHEDULES_REFETCH_INTERVAL_MS = 15_000;
export const LOCAL_SCHEDULE_UPDATE_TIMEOUT_MS = 60_000;
export const LOCAL_SCHEDULE_READ_TIMEOUT_MS = 15_000;

/** Follow the session mutation fence: abandon local work before retiring transport. */
async function runScheduleRequest<T>(
  kind: "update" | "list",
  request: (client: Awaited<ReturnType<typeof getClient>>) => Promise<T>,
): Promise<T> {
  // Capture before initialization too: a delayed client must not send on a
  // replacement after this operation's deadline has already expired.
  const generation = captureBackendConnectionGeneration(LOCAL_BACKEND_ID);
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const assertActive = () => {
    if (abandoned || !generation.isCurrent()) {
      throw new LocalScheduleRequestError("connectionChanged");
    }
  };
  try {
    return await Promise.race([
      (async () => {
        const client = await getClient();
        assertActive();
        const result = await request(client);
        assertActive();
        return result;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            abandoned = true;
            if (kind === "update") {
              // Detachment is synchronous; cleanup may never settle. The captured
              // generation cannot detach a newer replacement. Never await cleanup.
              void generation.invalidate().catch((error) => {
                console.error(
                  "Failed to retire timed-out schedule transport:",
                  error,
                );
              });
            }
            reject(
              new LocalScheduleRequestError(
                kind === "update" ? "updateTimeout" : "listTimeout",
              ),
            );
          },
          kind === "update"
            ? LOCAL_SCHEDULE_UPDATE_TIMEOUT_MS
            : LOCAL_SCHEDULE_READ_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function listLocalSchedules(): Promise<ScheduledJobDto[]> {
  return runScheduleRequest("list", async (client) => {
    const response = await client.goose.GooseUnstableSchedulesList({});
    return response.jobs;
  });
}

export async function updateLocalScheduleCron(
  scheduleId: string,
  cron: string,
): Promise<ScheduledJobDto> {
  return runScheduleRequest("update", async (client) => {
    const response = await client.goose.GooseUnstableSchedulesUpdate({
      scheduleId,
      cron,
    });
    return response.job;
  });
}
