import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FeedbackSubmissionError,
  submitFeedbackIssue,
} from "@/shared/api/feedback";
import { FeedbackDialog } from "./FeedbackDialog";

const mockGetVersion = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mockGetVersion,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("@/shared/api/feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/feedback")>();
  return {
    ...actual,
    submitFeedbackIssue: vi.fn(),
  };
});

describe("FeedbackDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersion.mockResolvedValue("0.1.0-test");
  });

  it("renders the WARP-specific message for network access failures", async () => {
    const user = userEvent.setup();
    vi.mocked(submitFeedbackIssue).mockRejectedValueOnce(
      new FeedbackSubmissionError("networkAccess", "backend fallback message"),
    );

    render(<FeedbackDialog open={true} onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Title"), "Feedback title");
    await user.type(screen.getByLabelText("Description"), "Feedback details");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    const message =
      "Unable to submit feedback. Please check that you're connected to Cloudflare WARP and try again.";
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(message);
    });
  });
});
