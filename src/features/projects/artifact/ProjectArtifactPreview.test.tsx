import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACTS_QUERY_KEY, getArtifacts } from "@/shared/api/artifacts";
import { ProjectArtifactPreview } from "./ProjectArtifactPreview";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  invoke: vi.fn(),
}));

vi.mock("@/shared/api/artifacts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/api/artifacts")>();
  return {
    ...actual,
    getArtifacts: vi.fn(),
  };
});

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

const mockedGetArtifacts = vi.mocked(getArtifacts);

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>,
    ),
  };
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
    mockedGetArtifacts.mockReturnValue(new Promise(() => {}));

    renderWithQueryClient(
      <ProjectArtifactPreview input={{ name: "Launch plan" }} />,
    );

    expect(screen.getByTestId("project-artifact-preview")).toBeInTheDocument();
    expect(
      screen.queryByTestId("project-artifact-renderer"),
    ).not.toBeInTheDocument();
  });

  it("shows a project glyph placeholder in the tile fallback", () => {
    mockedGetArtifacts.mockReturnValue(new Promise(() => {}));

    const { container } = renderWithQueryClient(
      <ProjectArtifactPreview input={{ name: "Launch plan" }} variant="tile" />,
    );

    expect(
      container.querySelector(".backdrop-blur-xl"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("project-artifact-placeholder-glyph"),
    ).toBeInTheDocument();
  });

  it("passes cached image and environment URLs to the renderer", async () => {
    const rawArtifacts = {
      catalogVersion: "20260521T121530123Z",
      assets: [
        {
          kind: "environment" as const,
          path: "/tmp/assets/hdri/studio_soft.exr",
          mimeType: "image/x-exr",
          byteSize: 4,
          sha256: "a".repeat(64),
        },
        {
          kind: "projectImage" as const,
          path: "/tmp/assets/project-images/memory-01.webp",
          mimeType: "image/webp",
          byteSize: 4,
          sha256: "b".repeat(64),
        },
        {
          kind: "projectImage" as const,
          path: "/tmp/assets/project-images/memory-02.webp",
          mimeType: "image/webp",
          byteSize: 4,
          sha256: "c".repeat(64),
        },
      ],
    };
    mockedGetArtifacts.mockResolvedValue(rawArtifacts);

    const { queryClient } = renderWithQueryClient(
      <ProjectArtifactPreview input={{ name: "Launch plan" }} />,
    );

    const renderer = await screen.findByTestId("project-artifact-renderer");
    expect(renderer).toHaveAttribute(
      "data-image-urls",
      "asset:///tmp/assets/project-images/memory-01.webp,asset:///tmp/assets/project-images/memory-02.webp",
    );
    expect(renderer).toHaveAttribute(
      "data-environment-url",
      "asset:///tmp/assets/hdri/studio_soft.exr",
    );
    expect(queryClient.getQueryData(ARTIFACTS_QUERY_KEY)).toEqual(rawArtifacts);
  });

  it("uses the fallback and skips asset loading while rendering is paused", () => {
    renderWithQueryClient(
      <ProjectArtifactPreview input={{ name: "Launch plan" }} renderPaused />,
    );

    expect(screen.getByTestId("project-artifact-preview")).toBeInTheDocument();
    expect(
      screen.queryByTestId("project-artifact-renderer"),
    ).not.toBeInTheDocument();
    expect(mockedGetArtifacts).not.toHaveBeenCalled();
  });

  it("limits tile renderer images while preserving the deterministic first image", async () => {
    mockedGetArtifacts.mockResolvedValue({
      catalogVersion: "20260521T121530123Z",
      assets: [
        {
          kind: "environment",
          path: "/tmp/assets/hdri/studio_soft.exr",
          mimeType: "image/x-exr",
          byteSize: 4,
          sha256: "a".repeat(64),
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          kind: "projectImage" as const,
          path: `/tmp/assets/project-images/memory-${String(index + 1).padStart(2, "0")}.webp`,
          mimeType: "image/webp",
          byteSize: 4,
          sha256: String(index).repeat(64).slice(0, 64),
        })),
      ],
    });

    renderWithQueryClient(
      <ProjectArtifactPreview
        input={{
          name: "Launch plan",
          artifact: {
            seed: 2,
            color: "sage",
            mood: "active",
            moodIntensity: 0.5,
            contentMode: "planes",
          },
        }}
        variant="tile"
      />,
    );

    expect(
      await screen.findByTestId("project-artifact-renderer"),
    ).toHaveAttribute(
      "data-image-urls",
      [
        "asset:///tmp/assets/project-images/memory-03.webp",
        "asset:///tmp/assets/project-images/memory-04.webp",
        "asset:///tmp/assets/project-images/memory-05.webp",
      ].join(","),
    );
  });

  it("keeps the fallback visible when asset loading fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedGetArtifacts.mockRejectedValue(new Error("offline"));

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
    mockedGetArtifacts
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        catalogVersion: "20260521T121530123Z",
        assets: [
          {
            kind: "environment",
            path: "/tmp/assets/hdri/studio_soft.exr",
            mimeType: "image/x-exr",
            byteSize: 4,
            sha256: "a".repeat(64),
          },
          {
            kind: "projectImage",
            path: "/tmp/assets/project-images/memory-01.webp",
            mimeType: "image/webp",
            byteSize: 4,
            sha256: "b".repeat(64),
          },
        ],
      });

    renderWithQueryClient(
      <ProjectArtifactPreview input={{ name: "Launch plan" }} />,
    );

    expect(
      await screen.findByTestId("project-artifact-renderer"),
    ).toHaveAttribute(
      "data-image-urls",
      "asset:///tmp/assets/project-images/memory-01.webp",
    );
  });
});
