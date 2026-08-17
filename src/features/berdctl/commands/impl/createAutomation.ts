import { z } from "zod/v4";

import { CommandError, defineCommand } from "../types";

const createAutomationSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "Automation title, shown in the Automations view (1-200 chars).",
      ),
    schedule: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe(
        'Cron schedule for the run cadence (e.g. "0 */30 * * * *"); the ' +
          "backend interprets it in --time-zone.",
      ),
    instruction: z
      .array(z.string().trim().min(1).max(10_000))
      .min(1)
      .max(50)
      .describe(
        "One instruction step the automation runs each time (repeat the flag " +
          "for multiple steps; 1-50 steps, each 1-10000 chars).",
      ),
    time_zone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'IANA time zone for the schedule (e.g. "America/New_York"); defaults ' +
          "to the app's current time zone.",
      ),
    enable_notifications: z
      .boolean()
      .default(false)
      .describe(
        "Notify the user when runs complete; omitted means no notifications.",
      ),
  })
  .strict();

interface CreateAutomationResult {
  automation_id: string;
  title: string;
  schedule: string;
}

export const createAutomationCommand = defineCommand({
  effect: "create",
  visibility: "immediate",
  destructive: false,
  bridgeTimeoutMs: 60_000,
  summary: "Create a scheduled automation",
  description:
    "Create a scheduled automation that runs the given instruction steps on " +
    "the given cron cadence. The new automation appears in the Automations " +
    "view immediately and can be edited, paused, or deleted there.",
  helpFooter: `Example:
  berdctl automation create --title "Morning digest" \\
    --schedule "0 0 9 * * *" --time-zone "America/New_York" \\
    --instruction "Summarize my unread Slack messages" \\
    --instruction "Post the summary to my notes" --json

Result:
  {"automation_id": "...", "title": "Morning digest",
   "schedule": "0 0 9 * * *"} — visible in the Automations view.
  Inspect it with \`berdctl automation get\`; run it now with
  \`berdctl automation run\`.`,
  schema: createAutomationSchema,
  execute: async (args): Promise<CreateAutomationResult> => {
    const [{ requireAutomationsCapability }, api] = await Promise.all([
      import("../runtime/automations"),
      import("@/features/automations/api/kgooseAutomations"),
    ]);
    requireAutomationsCapability();
    const timeZone =
      args.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const response = await api.createAutomationTile({
      // 4 is the generic "summary" automation tile type the Automations
      // builder creates (automationBuilder.ts SUMMARY_TILE_TYPE); dashboard
      // and Builderbot tile types are deliberately out of scope here.
      type: 4,
      title: args.title,
      schedule: args.schedule,
      instructions: args.instruction,
      timeZone,
      enableNotifications: args.enable_notifications,
    });
    const automationId = response.automationId ?? response.tileId;
    if (response.success === false || !automationId) {
      throw new CommandError(
        "automation_create_failed",
        response.errorMsg?.trim() ||
          "The backend rejected the automation; check the schedule cron " +
            "expression and try again.",
      );
    }
    return {
      automation_id: automationId,
      title: args.title,
      schedule: args.schedule,
    };
  },
});
