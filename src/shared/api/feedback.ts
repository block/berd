import { invoke } from "@tauri-apps/api/core";

export interface SubmitFeedbackIssueInput {
  title: string;
  description: string;
}

export interface SubmitFeedbackIssueResult {
  issueUrl?: string;
}

export async function submitFeedbackIssue(
  input: SubmitFeedbackIssueInput,
): Promise<SubmitFeedbackIssueResult> {
  const response = await invoke<unknown>("submit_feedback_issue", {
    title: input.title,
    description: input.description,
  });

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
