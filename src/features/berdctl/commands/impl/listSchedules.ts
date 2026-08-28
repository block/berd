import { z } from "zod/v4";

import { defineCommand } from "../types";

const listSchedulesSchema = z.object({}).strict();

export const listSchedulesCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List scheduled recipe jobs from Berd's live Goose scheduler",
  description:
    "List scheduled recipe jobs from the live Goose scheduler embedded in Berd. Unlike a separate goose schedule process, this reads the scheduler instance that is actually running the jobs and does not change app state.",
  helpFooter: `Example:
  berdctl schedule list --json

Result:
  {"schedules": [{"id": "daily-report", "cron": "0 9 * * *",
                   "paused": false, "currently_running": false,
                   "source": "...", "last_run": null,
                   "current_session_id": null, "job_start_time": null}]}`,
  schema: listSchedulesSchema,
  execute: async () => {
    const { listLiveSchedules } = await import("../runtime/schedules");
    return { schedules: await listLiveSchedules() };
  },
});
