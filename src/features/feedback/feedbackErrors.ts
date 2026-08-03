import type { TFunction } from "i18next";
import { FeedbackSubmissionError } from "@/shared/api/feedback";

export function getFeedbackSubmitErrorMessage(
  error: unknown,
  t: TFunction<"feedback">,
): string {
  if (
    error instanceof FeedbackSubmissionError &&
    error.code === "networkAccess"
  ) {
    return t("dialog.networkAccessError");
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return t("dialog.submitError");
}
