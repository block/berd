import { z } from "zod/v4";

import { defineCommand } from "../types";

const pauseScheduleSchema = z
  .object({
    schedule_id: z
      .string()
      .min(1)
      .describe("Id of the scheduled recipe job to pause."),
  })
  .strict();

export const pauseScheduleCommand = defineCommand({
  effect: "update",
  visibility: "discoverable",
  destructive: false,
  summary: "Pause a job in Berd's live Goose scheduler",
  description:
    "Pause a scheduled recipe job through the live Goose scheduler embedded in Berd. Future scheduled runs stop until the job is unpaused; an already-running session is not killed.",
  helpFooter: `Example:
  berdctl schedule pause --schedule-id daily-report

Result:
  {"ok": true, "schedule_id": "daily-report", "paused": true}`,
  schema: pauseScheduleSchema,
  execute: async (args) => {
    const { pauseLiveSchedule } = await import("../runtime/schedules");
    await pauseLiveSchedule(args.schedule_id);
    return { ok: true as const, schedule_id: args.schedule_id, paused: true };
  },
});
