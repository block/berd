import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectArtifactAssets } from "@/shared/api/projectArtifactAssets";
import { ProjectArtifactPreview } from "./ProjectArtifactPreview";

vi.mock("@/shared/api/projectArtifactAssets", () => ({
  getProjectArtifactAssets: vi.fn(),
}));

vi.mock("./ProjectArtifactRenderer", () => ({
  ProjectArtifactRenderer: ({
    environmentUrl,
    imageUrls,
  }: {
    environmentUrl: string;
    imageUrls: string[];
  }) => (
    <div
      data-testid="project-artifact-renderer"
      data-environment-url={environmentUrl}
      data-image-urls={imageUrls.join(",")}
    />
  ),
}));

const mockedGetProjectArtifactAssets = vi.mocked(getProjectArtifactAssets);

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

describe("ProjectArtifactPreview", () => {
  beforeEach(() => {
    vi.stubEnv("MODE", "development");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("shows the fallback while project artifact assets load", () => {
    mockedGetProjectArtifactAssets.mockReturnValue(new Promise(() => {}));

    renderWithQueryClient(
      <ProjectArtifactPreview input={{ name: "Launch plan" }} />,
    );

    expect(screen.getByTestId("project-artifact-preview")).toBeInTheDocument();
    expect(
      screen.queryByTestId("project-artifact-renderer"),
    ).not.toBeInTheDocument();
  });

  it("passes cached image and environment URLs to the renderer", async () => {
    mockedGetProjectArtifactAssets.mockResolvedValue({
      catalogVersion: "20260521T121530123Z",
      imageUrls: ["asset://memory-01.webp", "asset://memory-02.webp"],
      environmentUrl: "asset://studio_soft.exr",
    });

    renderWithQueryClient(
      <ProjectArtifactPreview input={{ name: "Launch plan" }} />,
    );

    const renderer = await screen.findByTestId("project-artifact-renderer");
    expect(renderer).toHaveAttribute(
      "data-image-urls",
      "asset://memory-01.webp,asset://memory-02.webp",
    );
    expect(renderer).toHaveAttribute(
      "data-environment-url",
      "asset://studio_soft.exr",
    );
  });

  it("keeps the fallback visible when asset loading fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedGetProjectArtifactAssets.mockRejectedValue(new Error("offline"));

    renderWithQueryClient(
      <ProjectArtifactPreview input={{ name: "Launch plan" }} />,
    );

    await waitFor(
      () => {
        expect(warn).toHaveBeenCalledWith(
          "Failed to load project artifact assets.",
          expect.any(Error),
        );
      },
      { timeout: 3000 },
    );
    expect(screen.getByTestId("project-artifact-preview")).toBeInTheDocument();
    expect(
      screen.queryByTestId("project-artifact-renderer"),
    ).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it("recovers when an asset query retry succeeds", async () => {
    mockedGetProjectArtifactAssets
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        catalogVersion: "20260521T121530123Z",
        imageUrls: ["asset://memory-01.webp"],
        environmentUrl: "asset://studio_soft.exr",
      });

    renderWithQueryClient(
      <ProjectArtifactPreview input={{ name: "Launch plan" }} />,
    );

    expect(
      await screen.findByTestId("project-artifact-renderer"),
    ).toHaveAttribute("data-image-urls", "asset://memory-01.webp");
  });
});
