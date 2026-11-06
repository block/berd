import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
    const onOpenChange = vi.fn();
    render(
      <ImageLightbox src="blob:preview" open onOpenChange={onOpenChange} />,
    );
    fireEvent.contextMenu(screen.getByRole("img"));
    await user.click(
      await screen.findByRole("menuitem", { name: "Copy image" }),
    );
    expect(copyImage).toHaveBeenCalledWith("blob:preview", {
      image: screen.getByRole("img"),
      signal: expect.any(AbortSignal),
    });
    await waitFor(() =>
      expect(toast.message).toHaveBeenCalledWith("Image copied"),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("reports a copy failure instead of claiming success", async () => {
    vi.mocked(copyImage).mockRejectedValue(new Error("denied"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ImageLightbox src="blob:preview" open onOpenChange={onOpenChange} />,
    );
    fireEvent.contextMenu(screen.getByRole("img"));
    await user.click(
      await screen.findByRole("menuitem", { name: "Copy image" }),
    );
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
    const reveal = await screen.findByRole("button", {
      name: "Open in folder",
    });
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
    expect(screen.queryByRole("button", { name: "Open in folder" })).toBeNull();
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
    expect(screen.queryByRole("button", { name: "Open in folder" })).toBeNull();
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
    await screen.findByRole("button", { name: "Open in folder" });
    vi.mocked(pathExists).mockReturnValue(new Promise(() => {}));
    rerender(
      <ImageLightbox
        src="blob:second"
        localFilePath="/tmp/second.png"
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open in folder" })).toBeNull();
  });
  it("offers matching Copy and Download buttons, repeated in the context menu", async () => {
    render(
      <ImageLightbox
        src="data:image/png;base64,abc"
        open
        onOpenChange={() => {}}
      />,
    );
    const actions = screen.getByRole("group", { name: "Image actions" });
    const buttons = Array.from(actions.querySelectorAll("button"));
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Copy image",
      "Download image",
    ]);
    expect(buttons[0]).toHaveClass(...buttons[1].classList);
    expect(actions).toBeVisible();
    fireEvent.contextMenu(screen.getByRole("img"));
    expect(
      await screen.findByRole("menuitem", { name: "Copy image" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Download image" }),
    ).toBeVisible();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("cancels pending copying on source changes and ignores a stale completion", async () => {
    let resolveFirst: (() => void) | undefined;
    vi.mocked(copyImage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { rerender } = render(
      <ImageLightbox src="data:first" open onOpenChange={() => {}} />,
    );
    fireEvent.contextMenu(screen.getByRole("img"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy image" }),
    );
    const firstSignal = vi.mocked(copyImage).mock.calls[0][1]?.signal;
    rerender(<ImageLightbox src="data:second" open onOpenChange={() => {}} />);
    expect(firstSignal?.aborted).toBe(true);
    fireEvent.contextMenu(screen.getByRole("img"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy image" }),
    );
    await waitFor(() => expect(toast.message).toHaveBeenCalledOnce());
    await act(async () => {
      resolveFirst?.();
    });
    expect(toast.message).toHaveBeenCalledOnce();
    expect(copyImage).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending copy when the preview closes and permits retry when reopened", async () => {
    vi.mocked(copyImage).mockImplementationOnce(() => new Promise(() => {}));
    const { rerender } = render(
      <ImageLightbox src="data:first" open onOpenChange={() => {}} />,
    );
    fireEvent.contextMenu(screen.getByRole("img"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy image" }),
    );
    const signal = vi.mocked(copyImage).mock.calls[0][1]?.signal;
    rerender(
      <ImageLightbox src="data:first" open={false} onOpenChange={() => {}} />,
    );
    expect(signal?.aborted).toBe(true);
    rerender(<ImageLightbox src="data:first" open onOpenChange={() => {}} />);
    fireEvent.contextMenu(screen.getByRole("img"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy image" }),
    );
    await waitFor(() =>
      expect(toast.message).toHaveBeenCalledWith("Image copied"),
    );
  });

  it("does not navigate the gallery when arrow keys are used inside the context menu", async () => {
    const next = vi.fn();
    render(
      <ImageLightbox
        src="data:first"
        open
        onNext={next}
        onOpenChange={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("img"));
    const item = await screen.findByRole("menuitem", { name: "Copy image" });
    fireEvent.keyDown(item, { key: "ArrowRight" });
    expect(next).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(next).toHaveBeenCalledOnce();
  });
  it("opens the image copy menu from the keyboard", async () => {
    render(
      <ImageLightbox
        src="data:image/png;base64,abc"
        open
        onOpenChange={() => {}}
      />,
    );
    const image = screen.getByRole("img");
    image.focus();
    fireEvent.keyDown(image, { key: "F10", shiftKey: true });
    expect(
      await screen.findByRole("menuitem", { name: "Copy image" }),
    ).toBeVisible();
  });
  it("copies from the first top-right button and keeps the preview open", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ImageLightbox
        src="data:image/png;base64,abc"
        open
        onOpenChange={onOpenChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Copy image" }));
    expect(copyImage).toHaveBeenCalledWith("data:image/png;base64,abc", {
      image: screen.getByRole("img"),
      signal: expect.any(AbortSignal),
    });
    await waitFor(() =>
      expect(toast.message).toHaveBeenCalledWith("Image copied"),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("disables both copy entry points during the same operation", async () => {
    vi.mocked(copyImage).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(
      <ImageLightbox
        src="data:image/png;base64,abc"
        open
        onOpenChange={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Copy image" }));
    expect(screen.getByRole("button", { name: "Copy image" })).toBeDisabled();
    fireEvent.contextMenu(screen.getByRole("img"));
    expect(
      await screen.findByRole("menuitem", { name: "Copy image" }),
    ).toHaveAttribute("data-disabled");
    expect(copyImage).toHaveBeenCalledOnce();
  });

  it("keeps the action order and folder label identical in the row and shortcut menu", async () => {
    window.__TAURI_INTERNALS__ = {};
    render(
      <ImageLightbox
        src="data:image/png;base64,abc"
        localFilePath="/tmp/original.png"
        open
        onOpenChange={() => {}}
      />,
    );
    await screen.findByRole("button", { name: "Open in folder" });
    const actions = screen.getByRole("group", { name: "Image actions" });
    expect(
      Array.from(actions.querySelectorAll("button")).map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Copy image", "Download image", "Open in folder"]);
    fireEvent.contextMenu(screen.getByRole("img"));
    await screen.findByRole("menuitem", { name: "Open in folder" });
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Copy image", "Download image", "Open in folder"]);
  });
});
