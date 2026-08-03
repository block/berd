import { getVersion } from "@tauri-apps/api/app";
import { type DoctorReport, runDoctor } from "@/shared/api/doctor";
import {
  type FeedbackAttachmentFileInput,
  submitFeedbackIssue,
} from "@/shared/api/feedback";
import { getPlatform } from "@/shared/lib/platform";
import { trackFeedbackSubmitted } from "@/shared/telemetry/client";

export interface SubmitFeedbackReportInput {
  title: string;
  description: string;
  includeLogs: boolean;
  attachmentPaths?: string[];
  attachmentFiles?: FeedbackAttachmentFileInput[];
  doctorReportPromise?: Promise<DoctorReport | null> | null;
  beforeSubmit?: () => void;
}

export interface SubmitFeedbackReportResult {
  issueUrl?: string;
}

export async function submitFeedbackReport(
  input: SubmitFeedbackReportInput,
): Promise<SubmitFeedbackReportResult> {
  let version: string;
  try {
    version = await getVersion();
  } catch {
    version = "unknown";
  }

  let doctorReport: DoctorReport | null = null;
  if (input.includeLogs) {
    try {
      doctorReport = await (input.doctorReportPromise ?? runDoctor());
    } catch (error) {
      console.warn("feedback: doctor check failed", error);
    }
  }

  input.beforeSubmit?.();
  const result = await submitFeedbackIssue({
    title: input.title.trim(),
    description: buildEnhancedDescription(
      input.description.trim(),
      version,
      getPlatform(),
    ),
    attachmentPaths: input.attachmentPaths,
    attachmentFiles: input.attachmentFiles,
    includeLogs: input.includeLogs,
    doctorReport,
  });
  trackFeedbackSubmitted();
  return result;
}

export function buildEnhancedDescription(
  description: string,
  version: string,
  platform: string,
): string {
  return [
    description,
    "",
    "---",
    `App version: ${version}`,
    `Platform: ${platform}`,
  ].join("\n");
}
