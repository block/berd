import { z } from "zod/v4";

import { defineCommand } from "../types";

const unpauseScheduleSchema = z
  .object({
    schedule_id: z
      .string()
      .min(1)
      .describe("Id of the scheduled recipe job to unpause."),
  })
  .strict();

export const unpauseScheduleCommand = defineCommand({
  effect: "update",
  visibility: "discoverable",
  destructive: false,
  summary: "Resume a paused job in Berd's live Goose scheduler",
  description:
    "Unpause a scheduled recipe job through the live Goose scheduler embedded in Berd. Future runs resume on the job's existing cron schedule.",
  helpFooter: `Example:
  berdctl schedule unpause --schedule-id daily-report

Result:
  {"ok": true, "schedule_id": "daily-report", "paused": false}`,
  schema: unpauseScheduleSchema,
  execute: async (args) => {
    const { unpauseLiveSchedule } = await import("../runtime/schedules");
    await unpauseLiveSchedule(args.schedule_id);
    return { ok: true as const, schedule_id: args.schedule_id, paused: false };
  },
});
