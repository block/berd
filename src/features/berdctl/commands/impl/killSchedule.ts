import { z } from "zod/v4";

import { defineCommand } from "../types";

const killScheduleSchema = z
  .object({
    schedule_id: z
      .string()
      .min(1)
      .describe("Id of the scheduled recipe job whose active run should stop."),
  })
  .strict();

export const killScheduleCommand = defineCommand({
  effect: "update",
  visibility: "discoverable",
  destructive: false,
  summary: "Stop the active run of a scheduled recipe job",
  description:
    "Stop the current run of a scheduled recipe job through Berd's live Goose scheduler. The schedule itself remains registered and can run again later; use remove or pause when future runs must also stop.",
  helpFooter: `Examples:
  berdctl schedule kill --schedule-id daily-report
  berdctl schedule kill --schedule-id daily-report && \\
    berdctl schedule remove --schedule-id daily-report

Result:
  {"ok": true, "schedule_id": "daily-report", "message": "..."}`,
  schema: killScheduleSchema,
  execute: async (args) => {
    const { killLiveSchedule } = await import("../runtime/schedules");
    const message = await killLiveSchedule(args.schedule_id);
    return { ok: true as const, schedule_id: args.schedule_id, message };
  },
});
