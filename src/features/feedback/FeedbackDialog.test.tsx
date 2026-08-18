import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  FeedbackSubmissionError,
  submitFeedbackIssue,
} from "@/shared/api/feedback";
import { inspectAttachmentPaths } from "@/shared/api/system";
import { FeedbackDialog } from "./FeedbackDialog";

const mockGetVersion = vi.hoisted(() => vi.fn());
const mockInvoke = vi.hoisted(() => vi.fn());
const mockOpenDialog = vi.hoisted(() => vi.fn());
const mockInspectAttachmentPaths = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mockGetVersion,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpenDialog,
}));

vi.mock("@/shared/api/system", () => ({
  inspectAttachmentPaths: mockInspectAttachmentPaths,
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
    mockOpenDialog.mockResolvedValue(null);
    mockInspectAttachmentPaths.mockResolvedValue([]);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:feedback-image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefills an agent-authored draft without submitting it", async () => {
    render(
      <FeedbackDialog
        open={true}
        onOpenChange={vi.fn()}
        draft={{
          title: "Draft title",
          description: "Draft details",
          includeLogs: true,
        }}
      />,
    );

    expect(screen.getByLabelText("Title")).toHaveValue("Draft title");
    expect(screen.getByLabelText("Description")).toHaveValue("Draft details");
    expect(screen.getByLabelText(/Attach logs and diagnostics/i)).toBeChecked();
    expect(submitFeedbackIssue).not.toHaveBeenCalled();
  });

  it("renders the WARP-specific message for network access failures", async () => {
    const user = userEvent.setup();
    vi.mocked(submitFeedbackIssue).mockRejectedValueOnce(
      new FeedbackSubmissionError("networkAccess", "backend fallback message"),
    );

    render(<FeedbackDialog open={true} onOpenChange={vi.fn()} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    const message =
      "Unable to submit feedback. Please check that you're connected to Cloudflare WARP and try again.";
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(message);
    });
  });

  it("keeps pasted image names scoped to the current paste batch", async () => {
    const user = userEvent.setup();
    vi.mocked(openDialog).mockResolvedValueOnce("/tmp/existing.png");
    vi.mocked(inspectAttachmentPaths).mockResolvedValueOnce([
      {
        name: "existing.png",
        path: "/tmp/existing.png",
        kind: "file",
        mimeType: "image/png",
      },
    ]);
    vi.mocked(submitFeedbackIssue).mockResolvedValueOnce({});

    render(<FeedbackDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Add images/i }));
    expect(await screen.findByText("existing.png")).toBeInTheDocument();

    await fillRequiredFields(user);
    pasteImages(screen.getByLabelText("Title"), [
      new File(["first"], "image.png", { type: "image/png" }),
      new File(["second"], "image.png", { type: "image/png" }),
    ]);

    expect(await screen.findByText("image.png")).toBeInTheDocument();
    expect(await screen.findByText("image-2.png")).toBeInTheDocument();
    expect(screen.queryByText("image-3.png")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(submitFeedbackIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          attachmentPaths: ["/tmp/existing.png"],
          attachmentFiles: [
            expect.objectContaining({
              name: "image.png",
              base64: expect.any(String),
            }),
            expect.objectContaining({
              name: "image-2.png",
              base64: expect.any(String),
            }),
          ],
        }),
      );
    });
  });

  it("surfaces picker inspection failures", async () => {
    const user = userEvent.setup();
    vi.mocked(openDialog).mockResolvedValueOnce("/tmp/failure.png");
    vi.mocked(inspectAttachmentPaths).mockRejectedValueOnce(
      new Error("inspection failed"),
    );

    render(<FeedbackDialog open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Add images/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Some images could not be attached.",
    );
  });
});

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Title"), "Feedback title");
  await user.type(screen.getByLabelText("Description"), "Feedback details");
}

function pasteImages(target: HTMLElement, files: File[]) {
  fireEvent.paste(target, {
    clipboardData: {
      items: files.map((file) => ({
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      })),
    },
  });
}
