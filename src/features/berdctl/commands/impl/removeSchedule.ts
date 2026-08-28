import { z } from "zod/v4";

import { CommandError, defineCommand } from "../types";

const removeScheduleSchema = z
  .object({
    schedule_id: z
      .string()
      .min(1)
      .describe("Id of the scheduled recipe job to remove."),
    confirm: z
      .boolean()
      .default(false)
      .describe(
        "Confirm removal of the schedule registration. The saved recipe file is kept.",
      ),
  })
  .strict();

export const removeScheduleCommand = defineCommand({
  effect: "archive",
  visibility: "discoverable",
  destructive: false,
  summary: "Remove a job from Berd's live Goose scheduler",
  description:
    "Remove a scheduled recipe job through the live Goose scheduler embedded in Berd. This updates the scheduler that is actually running jobs, so a stale in-memory copy cannot restore the deleted schedule. The saved recipe file is kept.",
  helpFooter: `Example:
  berdctl schedule remove --schedule-id daily-report --confirm

Result:
  {"ok": true, "schedule_id": "daily-report"}

If the job is currently running, use berdctl schedule kill first when you also need to stop that active run.`,
  schema: removeScheduleSchema,
  precheck: (args) => {
    if (!args.confirm) {
      throw new CommandError(
        "confirmation_required",
        `Refusing to remove schedule "${args.schedule_id}" without --confirm. The saved recipe file will be kept.`,
      );
    }
  },
  execute: async (args) => {
    const { deleteLiveSchedule } = await import("../runtime/schedules");
    await deleteLiveSchedule(args.schedule_id);
    return { ok: true as const, schedule_id: args.schedule_id };
  },
});
