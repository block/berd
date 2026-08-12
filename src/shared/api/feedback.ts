import { invoke } from "@tauri-apps/api/core";
import type { DoctorReport } from "@/shared/api/doctor";

export interface SubmitFeedbackIssueInput {
  title: string;
  description: string;
  attachmentPaths?: string[];
  attachmentFiles?: FeedbackAttachmentFileInput[];
  includeLogs?: boolean;
  doctorReport?: DoctorReport | null;
  labelIds?: string[];
}

export interface FeedbackAttachmentFileInput {
  name: string;
  mimeType: string;
  base64: string;
}

export interface SubmitFeedbackIssueResult {
  issueUrl?: string;
}

export type FeedbackErrorCode = "networkAccess" | "validation" | "submitFailed";

const DEFAULT_SUBMIT_ERROR = "Failed to submit feedback";

export class FeedbackSubmissionError extends Error {
  readonly code: FeedbackErrorCode;

  constructor(code: FeedbackErrorCode, message: string) {
    super(message);
    this.name = "FeedbackSubmissionError";
    this.code = code;
  }
}

export async function submitFeedbackIssue(
  input: SubmitFeedbackIssueInput,
): Promise<SubmitFeedbackIssueResult> {
  let response: unknown;
  try {
    response = await invoke<unknown>("submit_feedback_issue", {
      title: input.title,
      description: input.description,
      attachmentPaths: input.attachmentPaths ?? [],
      attachmentFiles: input.attachmentFiles ?? [],
      includeLogs: input.includeLogs ?? false,
      doctorReport: input.doctorReport ?? null,
      labelIds: input.labelIds ?? [],
    });
  } catch (error) {
    throw normalizeFeedbackSubmissionError(error);
  }

  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    const issueUrl =
      typeof record.issueUrl === "string"
        ? record.issueUrl
        : typeof record.issue_url === "string"
          ? record.issue_url
          : undefined;
    return { issueUrl };
  }

  return {};
}

function normalizeFeedbackSubmissionError(
  error: unknown,
): FeedbackSubmissionError {
  if (error instanceof FeedbackSubmissionError) {
    return error;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return new FeedbackSubmissionError(
      normalizeFeedbackErrorCode(record.code),
      stringOrDefault(record.message),
    );
  }

  return new FeedbackSubmissionError("submitFailed", stringOrDefault(error));
}

function normalizeFeedbackErrorCode(value: unknown): FeedbackErrorCode {
  switch (value) {
    case "networkAccess":
    case "validation":
    case "submitFailed":
      return value;
    default:
      return "submitFailed";
  }
}

function stringOrDefault(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message;
  }
  return DEFAULT_SUBMIT_ERROR;
}
