import { getVersion } from "@tauri-apps/api/app";
import { type DoctorReport, runDoctor } from "@/shared/api/doctor";
import {
  type FeedbackAttachmentFileInput,
  submitFeedbackIssue,
} from "@/shared/api/feedback";
import { getPlatform } from "@/shared/lib/platform";

export interface SubmitFeedbackReportInput {
  title: string;
  description: string;
  includeLogs: boolean;
  attachmentPaths?: string[];
  attachmentFiles?: FeedbackAttachmentFileInput[];
  doctorReportPromise?: Promise<DoctorReport | null> | null;
  titleSuffix?: string;
  metadata?: Record<string, string>;
  labelIds?: string[];
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
  return await submitFeedbackIssue({
    title: `${input.title.trim()}${input.titleSuffix ?? ""}`,
    description: buildEnhancedDescription(
      input.description.trim(),
      version,
      getPlatform(),
      input.metadata,
    ),
    attachmentPaths: input.attachmentPaths,
    attachmentFiles: input.attachmentFiles,
    includeLogs: input.includeLogs,
    doctorReport,
    labelIds: input.labelIds,
  });
}

export function buildEnhancedDescription(
  description: string,
  version: string,
  platform: string,
  metadata: Record<string, string> = {},
): string {
  return [
    description,
    "",
    "---",
    `App version: ${version}`,
    `Platform: ${platform}`,
    ...Object.entries(metadata).map(([label, value]) => `${label}: ${value}`),
  ].join("\n");
}
