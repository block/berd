import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "./ImageLightbox";
import { downloadImage } from "./downloadImage";

vi.mock("./downloadImage", () => ({
  downloadImage: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    message: vi.fn(),
    error: vi.fn(),
  },
}));

const mockDownloadImage = vi.mocked(downloadImage);

describe("ImageLightbox download button", () => {
  beforeEach(() => {
    mockDownloadImage.mockResolvedValue("image-1.png");
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  it("renders the download button when a src is present", () => {
    render(
      <ImageLightbox
        src="data:image/png;base64,AAAA"
        open
        onOpenChange={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Download image" }),
    ).toBeInTheDocument();
  });

  it("does not render the download button when src is empty", () => {
    render(<ImageLightbox src="" open onOpenChange={() => {}} />);

    expect(
      screen.queryByRole("button", { name: "Download image" }),
    ).not.toBeInTheDocument();
  });

  it("downloads with the provided filename hint and shows a toast", async () => {
    const user = userEvent.setup();
    render(
      <ImageLightbox
        src="data:image/png;base64,AAAA"
        downloadFilename="photo"
        open
        onOpenChange={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Download image" }));

    expect(mockDownloadImage).toHaveBeenCalledWith(
      "data:image/png;base64,AAAA",
      "photo",
    );
    await waitFor(() =>
      expect(toast.message).toHaveBeenCalledWith(
        "Download started: image-1.png",
        {},
      ),
    );
  });

  it("offers an Open Downloads action under Tauri", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const user = userEvent.setup();
    render(
      <ImageLightbox
        src="data:image/png;base64,AAAA"
        open
        onOpenChange={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Download image" }));

    await waitFor(() => expect(toast.message).toHaveBeenCalledOnce());
    const options = vi.mocked(toast.message).mock.calls[0][1] as {
      action?: { label?: string };
    };
    expect(options.action?.label).toBe("Open Downloads");
  });

  it("shows an error toast when the download fails", async () => {
    mockDownloadImage.mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <ImageLightbox
        src="data:image/png;base64,AAAA"
        open
        onOpenChange={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Download image" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't download image."),
    );
    errorSpy.mockRestore();
  });
});
