import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FeedbackSubmissionError,
  submitFeedbackIssue,
} from "@/shared/api/feedback";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("feedback api", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("normalizes camel and snake issue URL fields", async () => {
    mockInvoke.mockResolvedValueOnce({
      issueUrl: "https://linear.test/ISSUE-1",
    });
    await expect(
      submitFeedbackIssue({ title: "Bug", description: "Details" }),
    ).resolves.toEqual({ issueUrl: "https://linear.test/ISSUE-1" });
    expect(mockInvoke).toHaveBeenLastCalledWith("submit_feedback_issue", {
      title: "Bug",
      description: "Details",
      attachmentPaths: [],
      attachmentFiles: [],
      includeLogs: false,
      doctorReport: null,
      labelIds: [],
    });

    mockInvoke.mockResolvedValueOnce({
      issue_url: "https://linear.test/ISSUE-2",
    });
    await expect(
      submitFeedbackIssue({ title: "Bug", description: "Details" }),
    ).resolves.toEqual({ issueUrl: "https://linear.test/ISSUE-2" });
  });

  it("passes image attachments through to the Tauri command", async () => {
    mockInvoke.mockResolvedValueOnce({});

    await submitFeedbackIssue({
      title: "Bug",
      description: "Details",
      attachmentPaths: ["/tmp/screenshot.png"],
      attachmentFiles: [
        {
          name: "pasted.png",
          mimeType: "image/png",
          base64: "aW1hZ2U=",
        },
      ],
    });

    expect(mockInvoke).toHaveBeenCalledWith("submit_feedback_issue", {
      title: "Bug",
      description: "Details",
      attachmentPaths: ["/tmp/screenshot.png"],
      attachmentFiles: [
        {
          name: "pasted.png",
          mimeType: "image/png",
          base64: "aW1hZ2U=",
        },
      ],
      includeLogs: false,
      doctorReport: null,
      labelIds: [],
    });
  });

  it("normalizes structured network access errors", async () => {
    mockInvoke.mockRejectedValueOnce({
      code: "networkAccess",
      message: "Unable to reach the feedback service.",
    });

    await expect(
      submitFeedbackIssue({ title: "Bug", description: "Details" }),
    ).rejects.toMatchObject({
      code: "networkAccess",
      message: "Unable to reach the feedback service.",
    });
  });

  it("falls back to submitFailed for unstructured errors", async () => {
    mockInvoke.mockRejectedValueOnce("boom");

    await expect(
      submitFeedbackIssue({ title: "Bug", description: "Details" }),
    ).rejects.toEqual(new FeedbackSubmissionError("submitFailed", "boom"));
  });
});
