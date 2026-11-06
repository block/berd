import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownImage } from "../MarkdownImage";

const mocks = vi.hoisted(() => ({
  resolveMarkdownHref: vi.fn(),
  pathExists: vi.fn<(path: string) => Promise<boolean>>(),
  filesAreRemote: false,
  remoteHost: null as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, scheme: string) => `${scheme}://${path}`,
}));

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    resolveMarkdownHref: mocks.resolveMarkdownHref,
    pathExists: mocks.pathExists,
    filesAreRemote: mocks.filesAreRemote,
    remoteHost: mocks.remoteHost,
  }),
}));

describe("MarkdownImage", () => {
  beforeEach(() => {
    mocks.resolveMarkdownHref.mockReset();
    mocks.pathExists.mockReset();
    mocks.filesAreRemote = false;
    mocks.remoteHost = null;
  });

  it("renders an eligible local image via the asset: scheme by default", async () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./puppy.jpg",
      resolvedPath: "/work/puppy.jpg",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockResolvedValue(true);

    render(<MarkdownImage src="./puppy.jpg" alt="puppy" />);

    const img = await screen.findByAltText("puppy");
    expect(img.getAttribute("src")).toBe("asset:///work/puppy.jpg");
    expect(img.getAttribute("alt")).toBe("puppy");
    expect(mocks.pathExists).toHaveBeenCalledWith("/work/puppy.jpg");
  });

  it("does not rescue a remote https image (CSP handles it)", () => {
    render(<MarkdownImage src="https://example.com/p.jpg" alt="remote" />);

    expect(screen.getByAltText("remote").getAttribute("src")).toBe(
      "https://example.com/p.jpg",
    );
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
    // Remote sources short-circuit before touching the policy context.
    expect(mocks.resolveMarkdownHref).not.toHaveBeenCalled();
  });

  it.each([
    ["data:image/png;base64,abc", "data"],
    ["blob:https://example.com/image-id", "blob"],
  ])("leaves %s sources to the browser", (src, alt) => {
    render(<MarkdownImage src={src} alt={alt} />);

    expect(screen.getByAltText(alt).getAttribute("src")).toBe(src);
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
    expect(mocks.resolveMarkdownHref).not.toHaveBeenCalled();
  });

  it("shows an unavailable state when the local file does not exist", async () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./missing.jpg",
      resolvedPath: "/work/missing.jpg",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockResolvedValue(false);

    render(<MarkdownImage src="./missing.jpg" alt="missing" />);

    await waitFor(() => {
      expect(mocks.pathExists).toHaveBeenCalledWith("/work/missing.jpg");
    });
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
    expect(await screen.findByText("Image unavailable")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("does not rescue a resolved path that is not an image extension", () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./notes.txt",
      resolvedPath: "/work/notes.txt",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockResolvedValue(true);

    render(<MarkdownImage src="./notes.txt" alt="notes" />);

    // Non-image extension is rejected before any existence check.
    expect(mocks.pathExists).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
    expect(screen.getByText("Image unavailable")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("does not rescue when the policy context blocks the scheme", () => {
    mocks.resolveMarkdownHref.mockReturnValue(null);

    render(<MarkdownImage src="weird:thing" alt="blocked" />);

    expect(mocks.pathExists).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
    expect(screen.getByText("Image unavailable")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders a compact host placeholder for local paths in a remote session", () => {
    mocks.filesAreRemote = true;
    mocks.remoteHost = "devbox";
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./remote.png",
      resolvedPath: "/home/dev/project/remote.png",
      isWithinSessionCwd: true,
    });

    render(<MarkdownImage src="./remote.png" alt="remote artifact" />);

    // The file lives on the SSH host: no local existence check, no asset:
    // load (which would 404) — a name + host chip stands in for the image.
    expect(mocks.pathExists).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
    const placeholder = screen.getByTestId("remote-image-placeholder");
    expect(placeholder.textContent).toContain("remote artifact");
    expect(placeholder.textContent).toContain("devbox");
  });

  it("still leaves http(s) images alone in a remote session", () => {
    mocks.filesAreRemote = true;
    mocks.remoteHost = "devbox";

    render(<MarkdownImage src="https://example.com/p.jpg" alt="remote" />);

    expect(screen.queryByTestId("remote-image-placeholder")).toBeNull();
    expect(screen.getByAltText("remote").getAttribute("src")).toBe(
      "https://example.com/p.jpg",
    );
  });

  it.each([
    ["/tmp/preview.png", "/tmp/preview.png"],
    ["../../secret.png", "/secret.png"],
  ])("automatically loads %s outside the session cwd", async (src, resolvedPath) => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: src,
      resolvedPath,
      isWithinSessionCwd: false,
    });
    mocks.pathExists.mockResolvedValue(true);
    render(<MarkdownImage src={src} alt="Outside image" />);
    expect(await screen.findByAltText("Outside image")).toHaveAttribute(
      "src",
      `asset://${resolvedPath}`,
    );
    expect(mocks.pathExists).toHaveBeenCalledWith(resolvedPath);
    expect(screen.queryByRole("button", { name: /Show image/ })).toBeNull();
  });

  it("clears the stale image when src switches to a new local image", async () => {
    mocks.resolveMarkdownHref.mockImplementation((href: string) => ({
      rawPath: href,
      resolvedPath: `/work/${href}`,
      isWithinSessionCwd: true,
    }));
    // First image resolves immediately; second stays pending so the stale
    // first image can be checked while the new existence check is in flight.
    let resolveSecond: ((value: boolean) => void) | undefined;
    mocks.pathExists.mockResolvedValueOnce(true).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    const { rerender } = render(<MarkdownImage src="a.png" alt="first" />);
    const first = await screen.findByAltText("first");
    expect(first.getAttribute("src")).toBe("asset:///work/a.png");

    rerender(<MarkdownImage src="b.png" alt="second" />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
    });

    resolveSecond?.(true);
    const second = await screen.findByAltText("second");
    expect(second.getAttribute("src")).toBe("asset:///work/b.png");
  });

  it("shows an unavailable state when the existence check rejects", async () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./boom.png",
      resolvedPath: "/work/boom.png",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockRejectedValue(new Error("boom"));

    render(<MarkdownImage src="./boom.png" alt="boom" />);

    await waitFor(() => {
      expect(mocks.pathExists).toHaveBeenCalledWith("/work/boom.png");
    });
    // A rejection must not leave a stale image or surface as unhandled.
    expect(screen.queryByRole("button", { name: /^View / })).toBeNull();
    expect(await screen.findByText("Image unavailable")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("never emits a broken local image before the existence check settles", () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "preview.png",
      resolvedPath: "/work/preview.png",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockReturnValue(new Promise(() => {}));

    render(<MarkdownImage src="preview.png" alt="Preview" />);

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Loading image…")).toBeVisible();
  });

  it("shows an unavailable state when the browser cannot load an existing image", async () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "preview.png",
      resolvedPath: "/work/preview.png",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockResolvedValue(true);
    render(<MarkdownImage src="preview.png" alt="Preview" />);

    fireEvent.error(await screen.findByAltText("Preview"));

    expect(screen.getByText("Image unavailable")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("status")).toBeVisible();
  });

  it("shows an unavailable state when an outside-folder image is missing", async () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "/tmp/missing.png",
      resolvedPath: "/tmp/missing.png",
      isWithinSessionCwd: false,
    });
    mocks.pathExists.mockResolvedValue(false);
    render(<MarkdownImage src="/tmp/missing.png" alt="Preview" />);

    expect(await screen.findByText("Image unavailable")).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("uses the filename when there is no image description", () => {
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "/tmp/preview.png",
      resolvedPath: "/tmp/preview.png",
      isWithinSessionCwd: false,
    });
    mocks.pathExists.mockReturnValue(new Promise(() => {}));
    render(<MarkdownImage src="/tmp/preview.png" />);
    expect(screen.getByText("preview.png")).toBeVisible();
  });

  it("ignores a stale existence check after the image source changes", async () => {
    mocks.resolveMarkdownHref.mockImplementation((href: string) => ({
      rawPath: href,
      resolvedPath: `/work/${href}`,
      isWithinSessionCwd: true,
    }));
    let resolveFirst: ((exists: boolean) => void) | undefined;
    mocks.pathExists
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(false);
    const { rerender } = render(<MarkdownImage src="a.png" alt="First" />);
    rerender(<MarkdownImage src="b.png" alt="Second" />);
    await screen.findByText("Image unavailable");
    resolveFirst?.(true);

    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
    expect(screen.getByText("Second")).toBeVisible();
  });
});
