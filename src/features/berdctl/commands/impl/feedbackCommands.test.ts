import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeedbackDialogStore } from "@/features/feedback/feedbackDialogStore";
import { submitFeedbackReport } from "@/features/feedback/submitFeedbackReport";
import { getProfileCapabilitySnapshot } from "@/shared/profile/capabilities";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { openFeedbackCommand } from "./openFeedback";
import { submitFeedbackCommand } from "./submitFeedback";

vi.mock("@/shared/profile/capabilities", () => ({
  getProfileCapabilitySnapshot: vi.fn(),
}));
vi.mock("@/features/feedback/submitFeedbackReport", () => ({
  submitFeedbackReport: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { loading: vi.fn(() => "toast-1"), success: vi.fn(), error: vi.fn() },
}));

describe("feedback commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProfileCapabilitySnapshot).mockReturnValue(true);
    useFeedbackDialogStore.setState({ open: false, draft: null });
  });

  it("opens the existing form with the supplied draft without submitting", async () => {
    await expect(
      openFeedbackCommand.execute(
        {
          title: "Draft title",
          description: "Draft details",
          include_logs: true,
        },
        {},
      ),
    ).resolves.toEqual({ opened: true, include_logs: true });

    expect(useFeedbackDialogStore.getState()).toMatchObject({
      open: true,
      draft: {
        title: "Draft title",
        description: "Draft details",
        includeLogs: true,
      },
    });
    expect(submitFeedbackReport).not.toHaveBeenCalled();
  });

  it("refuses to replace an already-open feedback form", async () => {
    useFeedbackDialogStore.getState().openDialog({
      title: "User draft",
      description: "Keep this",
      includeLogs: false,
    });

    await expect(
      openFeedbackCommand.execute(
        { title: "New title", description: "New details", include_logs: true },
        {},
      ),
    ).rejects.toMatchObject({ code: "feedback_form_busy" });
    expect(useFeedbackDialogStore.getState().draft).toEqual({
      title: "User draft",
      description: "Keep this",
      includeLogs: false,
    });
  });

  it("submits directly, returns the issue URL, and shows visible success", async () => {
    vi.mocked(submitFeedbackReport).mockResolvedValue({
      issueUrl: "https://linear.test/BOT-1",
    });

    await expect(
      submitFeedbackCommand.execute(
        {
          title: "Approved title",
          description: "Approved details",
          include_logs: false,
        },
        {},
      ),
    ).resolves.toEqual({
      submitted: true,
      include_logs: false,
      issue_url: "https://linear.test/BOT-1",
    });
    expect(submitFeedbackReport).toHaveBeenCalledWith({
      title: "Approved title",
      description: "Approved details",
      includeLogs: false,
      beforeSubmit: expect.any(Function),
    });
    expect(toast.loading).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        id: "toast-1",
        action: expect.objectContaining({ label: expect.any(String) }),
      }),
    );
    const successOptions = vi.mocked(toast.success).mock.calls[0]?.[1];
    if (
      typeof successOptions?.action === "object" &&
      successOptions.action !== null &&
      "onClick" in successOptions.action
    ) {
      successOptions.action.onClick?.({} as never);
    }
    expect(openUrl).toHaveBeenCalledWith("https://linear.test/BOT-1");
  });

  it("refuses a late irreversible submission after preparation", async () => {
    vi.mocked(submitFeedbackReport).mockImplementation(async (input) => {
      input.beforeSubmit?.();
      return {};
    });

    await expect(
      submitFeedbackCommand.execute(
        { title: "Title", description: "Details", include_logs: false },
        { deadlineMs: Date.now() },
      ),
    ).rejects.toMatchObject({ code: "timed_out" });
  });

  it("shows visible failure and returns a stable command error", async () => {
    vi.mocked(submitFeedbackReport).mockRejectedValue(new Error("offline"));

    await expect(
      submitFeedbackCommand.execute(
        { title: "Title", description: "Details", include_logs: false },
        {},
      ),
    ).rejects.toMatchObject({
      code: "feedback_submission_failed",
      message: "offline",
    });
    expect(toast.error).toHaveBeenCalledWith(expect.any(String), {
      id: "toast-1",
      description: "offline",
    });
  });

  it("refuses both paths when feedback is disabled", async () => {
    vi.mocked(getProfileCapabilitySnapshot).mockReturnValue(false);

    await expect(
      openFeedbackCommand.execute(
        { title: "Title", description: "Details", include_logs: false },
        {},
      ),
    ).rejects.toMatchObject({ code: "feedback_disabled" });
    await expect(
      submitFeedbackCommand.execute(
        { title: "Title", description: "Details", include_logs: false },
        {},
      ),
    ).rejects.toMatchObject({ code: "feedback_disabled" });
  });
});
