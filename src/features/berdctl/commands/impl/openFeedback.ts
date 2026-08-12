import { z } from "zod/v4";

import { defineCommand } from "../types";

const openFeedbackSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Report title to prefill in the feedback form (1-200 chars)."),
    description: z
      .string()
      .trim()
      .min(1)
      .max(50_000)
      .describe(
        "Report description to prefill in the feedback form (1-50000 chars).",
      ),
    include_logs: z
      .boolean()
      .default(false)
      .describe(
        "Prefill the explicit opt-in to attach sanitized logs and Doctor diagnostics; omitted means false.",
      ),
  })
  .strict();

export const openFeedbackCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Open the feedback form with a report prefilled",
  description:
    "Open Berd's existing feedback form with the supplied title and description ready for optional hand editing. Nothing is submitted. Logs and Doctor diagnostics are selected only when --include-logs is explicitly passed.",
  helpFooter: `Example:
  berdctl feedback open --title "Composer loses draft" \\
    --description "Steps to reproduce..." --include-logs --json

Result:
  {"opened":true,"include_logs":true} — the existing feedback form is visible
  for review and optional image attachments; nothing was submitted.`,
  schema: openFeedbackSchema,
  execute: async (args) => {
    const [{ getProfileCapabilitySnapshot }, { useFeedbackDialogStore }] =
      await Promise.all([
        import("@/shared/profile/capabilities"),
        import("@/features/feedback/feedbackDialogStore"),
      ]);
    if (!getProfileCapabilitySnapshot("feedback")) {
      const { CommandError } = await import("../types");
      throw new CommandError(
        "feedback_disabled",
        "Feedback is disabled by runtime configuration.",
      );
    }
    const opened = useFeedbackDialogStore.getState().openDialog({
      title: args.title,
      description: args.description,
      includeLogs: args.include_logs,
    });
    if (!opened) {
      const { CommandError } = await import("../types");
      throw new CommandError(
        "feedback_form_busy",
        "The feedback form is already open. Ask the user to finish or close it before opening another report.",
      );
    }
    return { opened: true as const, include_logs: args.include_logs };
  },
});
