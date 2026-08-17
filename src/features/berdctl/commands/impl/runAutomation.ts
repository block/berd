import { z } from "zod/v4";

import { CommandError, defineCommand } from "../types";

const runAutomationSchema = z
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

interface RunAutomationResult {
  automation_id: string;
  run_session_id?: string;
}

export const runAutomationCommand = defineCommand({
  effect: "update",
  visibility: "discoverable",
  destructive: false,
  bridgeTimeoutMs: 60_000,
  summary: "Run an automation now, off schedule",
  description:
    "Trigger one immediate run of an automation without changing its " +
    "schedule. The run and its output appear in the Automations view like " +
    "any scheduled run.",
  helpFooter: `Example:
  berdctl automation run --automation-id <automation-id> --json

Result:
  {"automation_id": "...", "run_session_id": "..."} — the run's session id,
  when the backend reports one. Watch progress in the Automations view or
  read the result later with \`berdctl automation get\`.`,
  schema: runAutomationSchema,
  execute: async (args): Promise<RunAutomationResult> => {
    const [{ findAutomationOrThrow }, api] = await Promise.all([
      import("../runtime/automations"),
      import("@/features/automations/api/kgooseAutomations"),
    ]);
    // Resolve first so a bad id reads as automation_not_found, not a
    // backend refresh failure.
    const tile = await findAutomationOrThrow(args.automation_id);
    const response = await api.refreshAutomationTile(tile.id ?? "");
    if (response.success === false) {
      throw new CommandError(
        "automation_run_failed",
        response.errorMsg?.trim() ||
          "The backend refused to start the run; try again from the " +
            "Automations view.",
      );
    }
    const result: RunAutomationResult = { automation_id: tile.id ?? "" };
    if (response.refreshSessionId) {
      result.run_session_id = response.refreshSessionId;
    }
    return result;
  },
});
