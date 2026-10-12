import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "./ImageLightbox";
import { copyImage } from "./copyImage";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { pathExists } from "@/shared/api/system";
import { downloadImage } from "./downloadImage";

vi.mock("./downloadImage", () => ({
  downloadImage: vi.fn(),
}));

vi.mock("./copyImage", () => ({ copyImage: vi.fn() }));
vi.mock("@/shared/lib/fileManager", () => ({ revealInFileManager: vi.fn() }));
vi.mock("@/shared/api/system", () => ({ pathExists: vi.fn() }));
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
    vi.mocked(copyImage).mockResolvedValue(undefined);
    vi.mocked(revealInFileManager).mockResolvedValue(undefined);
    vi.mocked(pathExists).mockResolvedValue(true);
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
  it("copies image pixels and leaves the preview open", async () => {
    const user = userEvent.setup();
    render(<ImageLightbox src="blob:preview" open onOpenChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Copy image" }));
    expect(copyImage).toHaveBeenCalledWith("blob:preview");
    await waitFor(() =>
      expect(toast.message).toHaveBeenCalledWith("Image copied"),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("reports a copy failure instead of claiming success", async () => {
    vi.mocked(copyImage).mockRejectedValue(new Error("denied"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<ImageLightbox src="blob:preview" open onOpenChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Copy image" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't copy image."),
    );
    expect(toast.message).not.toHaveBeenCalled();
  });

  it("reveals the confirmed original local file, not the display URL", async () => {
    window.__TAURI_INTERNALS__ = {};
    const user = userEvent.setup();
    render(
      <ImageLightbox
        src="data:image/png;base64,abc"
        localFilePath="/tmp/original.png"
        open
        onOpenChange={() => {}}
      />,
    );
    const reveal = await screen.findByRole("button", { name: /Reveal in/ });
    await user.click(reveal);
    expect(revealInFileManager).toHaveBeenCalledWith("/tmp/original.png");
  });

  it("does not guess a folder action from an asset URL", () => {
    window.__TAURI_INTERNALS__ = {};
    render(
      <ImageLightbox
        src="asset:///tmp/preview.png"
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /Reveal in/ })).toBeNull();
    expect(pathExists).not.toHaveBeenCalled();
  });

  it("hides the folder action for missing originals", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.mocked(pathExists).mockResolvedValue(false);
    render(
      <ImageLightbox
        src="blob:preview"
        localFilePath="/tmp/missing.png"
        open
        onOpenChange={() => {}}
      />,
    );
    await waitFor(() =>
      expect(pathExists).toHaveBeenCalledWith("/tmp/missing.png"),
    );
    expect(screen.queryByRole("button", { name: /Reveal in/ })).toBeNull();
  });

  it("does not leave the previous original's folder action when navigating", async () => {
    window.__TAURI_INTERNALS__ = {};
    const { rerender } = render(
      <ImageLightbox
        src="blob:first"
        localFilePath="/tmp/first.png"
        open
        onOpenChange={() => {}}
      />,
    );
    await screen.findByRole("button", { name: /Reveal in/ });
    vi.mocked(pathExists).mockReturnValue(new Promise(() => {}));
    rerender(
      <ImageLightbox
        src="blob:second"
        localFilePath="/tmp/second.png"
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /Reveal in/ })).toBeNull();
  });
});
