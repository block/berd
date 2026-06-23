import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownImage } from "../MarkdownImage";

const mocks = vi.hoisted(() => ({
  enabled: false,
  resolveMarkdownHref: vi.fn(),
  pathExists: vi.fn<(path: string) => Promise<boolean>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, scheme: string) => `${scheme}://${path}`,
}));

vi.mock("@/features/experiments/experimentPreferences", () => ({
  useExperiment: () => ({ enabled: mocks.enabled }),
}));

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactPolicyContext: () => ({
    resolveMarkdownHref: mocks.resolveMarkdownHref,
    pathExists: mocks.pathExists,
  }),
}));

vi.mock("@/features/chat/ui/ClickableImage", () => ({
  ClickableImage: ({ src, alt }: { src: string; alt: string }) => (
    <img data-testid="clickable-image" src={src} alt={alt} />
  ),
}));

describe("MarkdownImage", () => {
  beforeEach(() => {
    mocks.enabled = false;
    mocks.resolveMarkdownHref.mockReset();
    mocks.pathExists.mockReset();
  });

  it("renders a plain <img> (no asset rescue) when the experiment is OFF", async () => {
    mocks.enabled = false;
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./puppy.jpg",
      resolvedPath: "/work/puppy.jpg",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockResolvedValue(true);

    render(<MarkdownImage src="./puppy.jpg" alt="puppy" />);

    // Falls through to the default broken-image behavior; never resolves.
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    const img = screen.getByAltText("puppy");
    expect(img.getAttribute("src")).toBe("./puppy.jpg");
    expect(mocks.resolveMarkdownHref).not.toHaveBeenCalled();
  });

  it("renders a local image via the asset: scheme when ON and the file exists", async () => {
    mocks.enabled = true;
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./puppy.jpg",
      resolvedPath: "/work/puppy.jpg",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockResolvedValue(true);

    render(<MarkdownImage src="./puppy.jpg" alt="puppy" />);

    const img = await screen.findByTestId("clickable-image");
    expect(img.getAttribute("src")).toBe("asset:///work/puppy.jpg");
    expect(img.getAttribute("alt")).toBe("puppy");
    expect(mocks.pathExists).toHaveBeenCalledWith("/work/puppy.jpg");
  });

  it("does NOT rescue a remote https image even when ON (CSP handles it)", async () => {
    mocks.enabled = true;

    render(<MarkdownImage src="https://example.com/p.jpg" alt="remote" />);

    await waitFor(() => {
      expect(screen.getByAltText("remote").getAttribute("src")).toBe(
        "https://example.com/p.jpg",
      );
    });
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    // Remote sources short-circuit before touching the policy context.
    expect(mocks.resolveMarkdownHref).not.toHaveBeenCalled();
  });

  it("falls back to a plain <img> when the local file does not exist", async () => {
    mocks.enabled = true;
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
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    expect(screen.getByAltText("missing").getAttribute("src")).toBe(
      "./missing.jpg",
    );
  });

  it("does not rescue a resolved path that is not an image extension", async () => {
    mocks.enabled = true;
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./notes.txt",
      resolvedPath: "/work/notes.txt",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockResolvedValue(true);

    render(<MarkdownImage src="./notes.txt" alt="notes" />);

    // Non-image extension is rejected before any existence check.
    expect(mocks.pathExists).not.toHaveBeenCalled();
    expect(screen.queryByTestId("clickable-image")).toBeNull();
  });

  it("does not rescue when the policy context blocks the scheme (null candidate)", async () => {
    mocks.enabled = true;
    mocks.resolveMarkdownHref.mockReturnValue(null);

    render(<MarkdownImage src="weird:thing" alt="blocked" />);

    expect(mocks.pathExists).not.toHaveBeenCalled();
    expect(screen.queryByTestId("clickable-image")).toBeNull();
  });

  it("does NOT rescue a path resolved outside the session cwd", async () => {
    mocks.enabled = true;
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "../../secret.png",
      resolvedPath: "/secret.png",
      isWithinSessionCwd: false,
    });
    mocks.pathExists.mockResolvedValue(true);

    render(<MarkdownImage src="../../secret.png" alt="escape" />);

    // Out-of-cwd paths are rejected before any existence check, so the
    // experiment scope claim holds even for absolute / ..-escaping paths.
    expect(mocks.pathExists).not.toHaveBeenCalled();
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    expect(screen.getByAltText("escape").getAttribute("src")).toBe(
      "../../secret.png",
    );
  });

  it("clears the stale image when src switches to a new local image", async () => {
    mocks.enabled = true;
    mocks.resolveMarkdownHref.mockImplementation((href: string) => ({
      rawPath: href,
      resolvedPath: `/work/${href}`,
      isWithinSessionCwd: true,
    }));
    // First image resolves immediately; second never resolves so we can assert
    // the stale first image is gone while the new check is in flight.
    let resolveSecond: ((value: boolean) => void) | undefined;
    mocks.pathExists.mockResolvedValueOnce(true).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    const { rerender } = render(<MarkdownImage src="a.png" alt="first" />);
    const first = await screen.findByTestId("clickable-image");
    expect(first.getAttribute("src")).toBe("asset:///work/a.png");

    rerender(<MarkdownImage src="b.png" alt="second" />);

    // While b.png's existence check is pending, no stale clickable image shows.
    await waitFor(() => {
      expect(screen.queryByTestId("clickable-image")).toBeNull();
    });

    resolveSecond?.(true);
    const second = await screen.findByTestId("clickable-image");
    expect(second.getAttribute("src")).toBe("asset:///work/b.png");
  });

  it("falls back to a plain <img> when the existence check rejects", async () => {
    mocks.enabled = true;
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
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    expect(screen.getByAltText("boom").getAttribute("src")).toBe("./boom.png");
  });
});
