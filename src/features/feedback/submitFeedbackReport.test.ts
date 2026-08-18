import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "@/shared/api/doctor";
import { submitFeedbackIssue } from "@/shared/api/feedback";
import { submitFeedbackReport } from "./submitFeedbackReport";

const mockGetVersion = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/app", () => ({ getVersion: mockGetVersion }));
vi.mock("@/shared/lib/platform", () => ({ getPlatform: () => "mac" }));
vi.mock("@/shared/api/doctor", () => ({ runDoctor: vi.fn() }));
vi.mock("@/shared/api/feedback", () => ({ submitFeedbackIssue: vi.fn() }));

describe("submitFeedbackReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersion.mockResolvedValue("1.2.3");
    vi.mocked(submitFeedbackIssue).mockResolvedValue({
      issueUrl: "https://linear.test/BOT-1",
    });
  });

  it("enriches and submits without diagnostics by default", async () => {
    await expect(
      submitFeedbackReport({
        title: " Bug ",
        description: " Details ",
        includeLogs: false,
      }),
    ).resolves.toEqual({ issueUrl: "https://linear.test/BOT-1" });

    expect(runDoctor).not.toHaveBeenCalled();
    expect(submitFeedbackIssue).toHaveBeenCalledWith({
      title: "Bug",
      description: "Details\n\n---\nApp version: 1.2.3\nPlatform: mac",
      attachmentPaths: undefined,
      attachmentFiles: undefined,
      includeLogs: false,
      doctorReport: null,
      labelIds: undefined,
    });
  });

  it("runs Doctor only after explicit diagnostics opt-in", async () => {
    const doctorReport = { checks: [] };
    vi.mocked(runDoctor).mockResolvedValue(doctorReport);

    await submitFeedbackReport({
      title: "Bug",
      description: "Details",
      includeLogs: true,
    });

    expect(runDoctor).toHaveBeenCalledOnce();
    expect(submitFeedbackIssue).toHaveBeenCalledWith(
      expect.objectContaining({ includeLogs: true, doctorReport }),
    );
  });

  it("adds beta routing metadata when supplied by the updater", async () => {
    await submitFeedbackReport({
      title: "Rough edge",
      description: "Details",
      includeLogs: false,
      titleSuffix: " [Berd 1.2.3 Beta]",
      metadata: { "Release channel": "Beta", "Running build": "1.2.3" },
      labelIds: ["12345678-1234-1234-1234-123456789abc"],
    });

    expect(submitFeedbackIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Rough edge [Berd 1.2.3 Beta]",
        description:
          "Details\n\n---\nApp version: 1.2.3\nPlatform: mac\nRelease channel: Beta\nRunning build: 1.2.3",
        labelIds: ["12345678-1234-1234-1234-123456789abc"],
      }),
    );
  });

  it("propagates a submission failure to the caller", async () => {
    vi.mocked(submitFeedbackIssue).mockRejectedValue(new Error("offline"));

    await expect(
      submitFeedbackReport({
        title: "Bug",
        description: "Details",
        includeLogs: false,
      }),
    ).rejects.toThrow("offline");
  });
});
