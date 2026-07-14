import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownImage } from "../MarkdownImage";

const mocks = vi.hoisted(() => ({
  enabled: false,
  resolveMarkdownHref: vi.fn(),
  pathExists: vi.fn<(path: string) => Promise<boolean>>(),
  setExperimentEnabled: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, scheme: string) => `${scheme}://${path}`,
}));

vi.mock("@/features/experiments/experimentPreferences", () => ({
  useExperiment: () => ({ enabled: mocks.enabled }),
  setExperimentEnabled: mocks.setExperimentEnabled,
}));

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
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
    mocks.setExperimentEnabled.mockReset();
  });

  it("shows an enable hint (no asset rescue) when the experiment is OFF", async () => {
    mocks.enabled = false;
    mocks.resolveMarkdownHref.mockReturnValue({
      rawPath: "./puppy.jpg",
      resolvedPath: "/work/puppy.jpg",
      isWithinSessionCwd: true,
    });
    mocks.pathExists.mockResolvedValue(true);

    render(<MarkdownImage src="./puppy.jpg" alt="puppy" />);

    // Never resolves or renders the image; offers the enable affordance
    // where the broken image would have been.
    expect(screen.queryByTestId("clickable-image")).toBeNull();
    expect(screen.getByText("markdownImages.disabledHint")).toBeTruthy();
    expect(mocks.resolveMarkdownHref).not.toHaveBeenCalled();
  });

  it("enable hint click flips the experiment preference on", async () => {
    mocks.enabled = false;

    render(<MarkdownImage src="./puppy.jpg" alt="puppy" />);

    screen.getByRole("button", { name: "markdownImages.enable" }).click();
    expect(mocks.setExperimentEnabled).toHaveBeenCalledWith(
      "local-markdown-images",
      true,
    );
  });

  it("enable hint click does not bubble into a wrapping markdown link", async () => {
    // [![alt](./preview.png)](target.md) renders the image inside an <a>;
    // enabling previews must not also open/navigate the wrapping anchor.
    mocks.enabled = false;
    const onLinkClick = vi.fn();

    render(
      // biome-ignore lint/a11y/useValidAnchor: mirrors the markdown-rendered anchor wrapper under test
      <a href="./target.md" onClick={onLinkClick}>
        <MarkdownImage src="./preview.png" alt="preview" />
      </a>,
    );

    screen.getByRole("button", { name: "markdownImages.enable" }).click();
    expect(mocks.setExperimentEnabled).toHaveBeenCalledWith(
      "local-markdown-images",
      true,
    );
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it("does not show the hint for non-image local paths when OFF", async () => {
    mocks.enabled = false;

    render(<MarkdownImage src="./notes.txt" alt="notes" />);

    expect(screen.queryByText("markdownImages.disabledHint")).toBeNull();
    expect(screen.getByAltText("notes").getAttribute("src")).toBe(
      "./notes.txt",
    );
  });

  it("does not show the hint for remote images when OFF", async () => {
    mocks.enabled = false;

    render(<MarkdownImage src="https://example.com/p.jpg" alt="remote" />);

    expect(screen.queryByText("markdownImages.disabledHint")).toBeNull();
    expect(screen.getByAltText("remote").getAttribute("src")).toBe(
      "https://example.com/p.jpg",
    );
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
