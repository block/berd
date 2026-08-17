import { z } from "zod/v4";

import { defineCommand } from "../types";
import type { AutomationSummary } from "../runtime/automations";

const listAutomationsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Case-insensitive substring filter on the automation title (1-200 chars).",
      ),
  })
  .strict();

interface ListAutomationsResult {
  automations: AutomationSummary[];
}

export const listAutomationsCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List the user's automations",
  description:
    "List the user's scheduled automations (id, title, schedule, status, and " +
    "last-run info) as the Automations view shows them; does not change " +
    'anything on screen. Read one automation\'s full detail with action "get".',
  helpFooter: `Example:
  berdctl automation list --json
  berdctl automation list --query "review" --json

Result:
  {"automations": [{"automation_id": "...", "title": "...",
                    "schedule": "0 */30 * * * *", "time_zone": "...",
                    "status": "...", "latest_run_status": "...",
                    "schedule_paused": false, "last_success_at": "..."}, ...]}
  Read one automation's instructions with \`berdctl automation get\`.`,
  schema: listAutomationsSchema,
  execute: async (args): Promise<ListAutomationsResult> => {
    const { fetchAutomationTiles, summarizeAutomationTile } = await import(
      "../runtime/automations"
    );
    const tiles = await fetchAutomationTiles();
    const query = args.query?.toLowerCase();
    const automations = tiles
      .map(summarizeAutomationTile)
      .filter(
        (automation) =>
          !query || automation.title.toLowerCase().includes(query),
      );
    return { automations };
  },
});
