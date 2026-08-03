import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "@/shared/api/doctor";
import { submitFeedbackIssue } from "@/shared/api/feedback";
import { trackFeedbackSubmitted } from "@/shared/telemetry/client";
import { submitFeedbackReport } from "./submitFeedbackReport";

const mockGetVersion = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/app", () => ({ getVersion: mockGetVersion }));
vi.mock("@/shared/lib/platform", () => ({ getPlatform: () => "mac" }));
vi.mock("@/shared/api/doctor", () => ({ runDoctor: vi.fn() }));
vi.mock("@/shared/api/feedback", () => ({ submitFeedbackIssue: vi.fn() }));
vi.mock("@/shared/telemetry/client", () => ({
  trackFeedbackSubmitted: vi.fn(),
}));

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
    });
    expect(trackFeedbackSubmitted).toHaveBeenCalledOnce();
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

  it("does not track telemetry when submission fails", async () => {
    vi.mocked(submitFeedbackIssue).mockRejectedValue(new Error("offline"));

    await expect(
      submitFeedbackReport({
        title: "Bug",
        description: "Details",
        includeLogs: false,
      }),
    ).rejects.toThrow("offline");
    expect(trackFeedbackSubmitted).not.toHaveBeenCalled();
  });
});
