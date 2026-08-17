import { z } from "zod/v4";

import { defineCommand } from "../types";
import type { AutomationDetail } from "../runtime/automations";

const getAutomationSchema = z
  .object({
    automation_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "Automation id, as returned by `berdctl automation list` (1-200 chars).",
      ),
  })
  .strict();

export const getAutomationCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "Read one automation's full detail",
  description:
    "Read one automation's full detail — title, schedule, time zone, status, " +
    "pause state, instructions, and latest-run wiring — exactly as the " +
    "Automations view shows it; does not change anything on screen.",
  helpFooter: `Example:
  berdctl automation get --automation-id <automation-id> --json

Result:
  {"automation_id": "...", "title": "...", "schedule": "0 */30 * * * *",
   "time_zone": "...", "status": "...", "latest_run_status": "...",
   "schedule_paused": false, "instructions": ["..."],
   "human_readable_instructions": ["..."],
   "latest_chat_session_id": "...", "created": "...", "updated": "..."}
  Find ids with \`berdctl automation list\`.`,
  schema: getAutomationSchema,
  execute: async (args): Promise<AutomationDetail> => {
    const { findAutomationOrThrow, detailAutomationTile } = await import(
      "../runtime/automations"
    );
    const tile = await findAutomationOrThrow(args.automation_id);
    return detailAutomationTile(tile);
  },
});
