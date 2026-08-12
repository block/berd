import { z } from "zod/v4";

import { defineCommand } from "../types";

const listHarnessesSchema = z.object({}).strict();

interface ListHarnessesResult {
  harnesses: Array<{
    harness_id: string;
    name: string;
    is_default: boolean;
    /** "ready" harnesses can run sessions; "not_installed" / "not_ready"
     *  (sign-in or setup required) cannot until the user fixes them. */
    status: "ready" | "not_installed" | "not_ready";
  }>;
}

export const listHarnessesCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List the agent harnesses sessions can run on, with readiness",
  description:
    "List the agent harnesses sessions can run on (goose, Claude Code, Codex, ...) " +
    'with their readiness; only "ready" harnesses accept new sessions.',
  helpFooter: `Example:
  berdctl info harnesses --json

Result:
  {"harnesses": [{"harness_id": "goose", "name": "...",
                  "is_default": true,
                  "status": "ready"|"not_installed"|"not_ready"}, ...]}
  Only "ready" harnesses accept new sessions; "not_installed" and
  "not_ready" (sign-in or setup required) need the user to fix them in
  the app first.`,
  schema: listHarnessesSchema,
  execute: async (): Promise<ListHarnessesResult> => {
    const [{ GOOSE_PROVIDER_ID }, { listHarnessStatuses }] = await Promise.all([
      import("@/shared/api/acpPersonaHandoff"),
      import("../runtime/providers"),
    ]);
    const harnesses = await listHarnessStatuses();
    return {
      harnesses: harnesses.map((harness) => ({
        harness_id: harness.id,
        name: harness.label,
        is_default: harness.id === GOOSE_PROVIDER_ID,
        status: harness.readiness,
      })),
    };
  },
});
