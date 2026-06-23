import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ArtifactLinkCandidate } from "@/features/chat/hooks/ArtifactPolicyContext";

const mockResolveMarkdownHref =
  vi.fn<(href: string) => ArtifactLinkCandidate | null>();
const mockOpenResolvedPath = vi.fn<(path: string) => Promise<void>>();

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    resolveMarkdownHref: mockResolveMarkdownHref,
    pathExists: async () => false,
    openResolvedPath: mockOpenResolvedPath,
  }),
}));

import { useArtifactLinkHandler } from "../useArtifactLinkHandler";

function makeCandidate(
  overrides: Partial<ArtifactLinkCandidate> = {},
): ArtifactLinkCandidate {
  return {
    rawPath: "/project/report.md",
    resolvedPath: "/Users/test/project/report.md",
    isWithinSessionCwd: true,
    ...overrides,
  };
}

function Harness({ href, label }: { href: string; label: string }) {
  const { handleContentClick, pathNotice } = useArtifactLinkHandler();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: test harness only
    // biome-ignore lint/a11y/noStaticElementInteractions: test harness only
    <div onClick={handleContentClick}>
      {/* External hrefs are intentionally not preventDefault-ed by the handler
          (the LinkSafetyModal owns them), so suppress jsdom's unimplemented
          navigation here; the delegated handler under test still runs. */}
      <a href={href} onClick={(event) => event.preventDefault()}>
        {label}
      </a>
      {pathNotice && <p data-testid="notice">{pathNotice}</p>}
    </div>
  );
}

function HarnessNoLink() {
  const { handleContentClick, pathNotice } = useArtifactLinkHandler();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: test harness only
    // biome-ignore lint/a11y/noStaticElementInteractions: test harness only
    <div onClick={handleContentClick}>
      <span data-testid="plain">just text</span>
      {pathNotice && <p data-testid="notice">{pathNotice}</p>}
    </div>
  );
}

describe("useArtifactLinkHandler", () => {
  beforeEach(() => {
    mockResolveMarkdownHref.mockReset();
    mockOpenResolvedPath.mockReset();
  });

  it("opens resolved local links", async () => {
    const user = userEvent.setup();
    const candidate = makeCandidate();
    mockResolveMarkdownHref.mockReturnValue(candidate);
    mockOpenResolvedPath.mockResolvedValue(undefined);

    render(<Harness href="/project/report.md" label="Report" />);
    await user.click(screen.getByText("Report"));

    expect(mockResolveMarkdownHref).toHaveBeenCalledWith("/project/report.md");
    expect(mockOpenResolvedPath).toHaveBeenCalledWith(candidate.resolvedPath);
  });

  it("routes file links through the artifact policy", async () => {
    const user = userEvent.setup();
    const candidate = makeCandidate({
      rawPath: "file:///tmp/report.md",
      resolvedPath: "/tmp/report.md",
      isWithinSessionCwd: false,
    });
    mockResolveMarkdownHref.mockReturnValue(candidate);
    mockOpenResolvedPath.mockResolvedValue(undefined);

    render(<Harness href="file:///tmp/report.md" label="File" />);
    await user.click(screen.getByText("File"));

    expect(mockResolveMarkdownHref).toHaveBeenCalledWith(
      "file:///tmp/report.md",
    );
    expect(mockOpenResolvedPath).toHaveBeenCalledWith("/tmp/report.md");
  });

  it("shows opener errors", async () => {
    const user = userEvent.setup();
    mockResolveMarkdownHref.mockReturnValue(
      makeCandidate({ resolvedPath: "/secret/data.md" }),
    );
    mockOpenResolvedPath.mockRejectedValue(
      new Error("File not found: /secret/data.md"),
    );

    render(<Harness href="/secret/data.md" label="Secret" />);
    await user.click(screen.getByText("Secret"));

    expect(screen.getByTestId("notice")).toHaveTextContent(
      "File not found: /secret/data.md",
    );
  });

  it("does not intercept external URLs", async () => {
    const user = userEvent.setup();

    render(<Harness href="https://example.com" label="External" />);
    await user.click(screen.getByText("External"));

    expect(mockResolveMarkdownHref).not.toHaveBeenCalled();
    expect(mockOpenResolvedPath).not.toHaveBeenCalled();
  });

  it("ignores clicks on non-link elements", async () => {
    const user = userEvent.setup();

    render(<HarnessNoLink />);
    await user.click(screen.getByTestId("plain"));

    expect(mockResolveMarkdownHref).not.toHaveBeenCalled();
    expect(mockOpenResolvedPath).not.toHaveBeenCalled();
  });
});
