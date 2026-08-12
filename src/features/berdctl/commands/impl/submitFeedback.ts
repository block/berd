import { z } from "zod/v4";

import { defineCommand } from "../types";

const submitFeedbackSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Approved report title to submit (1-200 chars)."),
    description: z
      .string()
      .trim()
      .min(1)
      .max(50_000)
      .describe("Approved report description to submit (1-50000 chars)."),
    include_logs: z
      .boolean()
      .default(false)
      .describe(
        "Explicitly opt in to attach sanitized logs and Doctor diagnostics; omitted means false.",
      ),
  })
  .strict();

export const submitFeedbackCommand = defineCommand({
  effect: "create",
  visibility: "immediate",
  destructive: false,
  summary: "Submit an approved report directly to the Berd team",
  description:
    "Submit the supplied approved report without opening the feedback form. Use this only after the user explicitly asks to file, send, or submit it. Berd immediately shows success or failure in the app. Logs and Doctor diagnostics are attached only when --include-logs is explicitly passed.",
  helpFooter: `Example:
  berdctl feedback submit --title "Composer loses draft" \\
    --description "Steps to reproduce..." --include-logs --json

Result:
  {"submitted":true,"include_logs":true,"issue_url":"https://..."}
  issue_url is omitted when the feedback service does not return one.`,
  schema: submitFeedbackSchema,
  bridgeTimeoutMs: 120_000,
  execute: async (args, ctx) => {
    const [
      { submitFeedbackReport },
      { getFeedbackSubmitErrorMessage },
      { getProfileCapabilitySnapshot },
      { refusePastDeadline },
      { i18n },
      { openUrl },
      { toast },
    ] = await Promise.all([
      import("@/features/feedback/submitFeedbackReport"),
      import("@/features/feedback/feedbackErrors"),
      import("@/shared/profile/capabilities"),
      import("../runtime/deadline"),
      import("@/shared/i18n/i18n"),
      import("@tauri-apps/plugin-opener"),
      import("sonner"),
    ]);
    if (!getProfileCapabilitySnapshot("feedback")) {
      const { CommandError } = await import("../types");
      throw new CommandError(
        "feedback_disabled",
        "Feedback is disabled by runtime configuration.",
      );
    }

    const t = i18n.getFixedT(null, "feedback");
    const toastId = toast.loading(t("direct.submittingTitle"), {
      description: t("direct.submittingBody"),
    });
    try {
      refusePastDeadline(ctx, "the feedback report was not submitted");
      const result = await submitFeedbackReport({
        title: args.title,
        description: args.description,
        includeLogs: args.include_logs,
        beforeSubmit: () =>
          refusePastDeadline(ctx, "the feedback report was not submitted"),
      });
      toast.success(t("direct.successTitle"), {
        id: toastId,
        description: result.issueUrl
          ? t("direct.successWithUrl")
          : t("direct.successBody"),
        action: result.issueUrl
          ? {
              label: t("dialog.viewTicket"),
              onClick: () => {
                void openUrl(result.issueUrl as string);
              },
            }
          : undefined,
      });
      return {
        submitted: true as const,
        include_logs: args.include_logs,
        ...(result.issueUrl ? { issue_url: result.issueUrl } : {}),
      };
    } catch (error) {
      const { CommandError } = await import("../types");
      if (error instanceof CommandError) {
        toast.error(t("direct.failureTitle"), {
          id: toastId,
          description: error.message,
        });
        throw error;
      }
      const message = getFeedbackSubmitErrorMessage(error, t);
      toast.error(t("direct.failureTitle"), {
        id: toastId,
        description: message,
      });
      throw new CommandError("feedback_submission_failed", message);
    }
  },
});
