import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import { AvatarLibraryPicker } from "../AvatarLibraryPicker";

function libraryWithError(
  errorCode: AvatarLibraryState["errorCode"],
): AvatarLibraryState {
  return {
    catalog: null,
    cachedAvatarMediaById: {},
    loading: false,
    cacheChecking: false,
    error: true,
    errorCode,
    downloadingCollectionIds: new Set<string>(),
    failedCollectionIds: new Set<string>(),
    retryCatalog: vi.fn(),
    openCollection: vi.fn(),
    isCollectionCached: () => false,
  };
}

function picker(library: AvatarLibraryState) {
  return (
    <AvatarLibraryPicker
      library={library}
      selectedAvatarRef={null}
      onSelectAvatar={vi.fn()}
      onPreviewError={vi.fn()}
    />
  );
}

describe("AvatarLibraryPicker", () => {
  it("shows catalog error copy without referencing custom URLs", () => {
    const { rerender } = renderWithProviders(
      picker(libraryWithError("networkAccess")),
    );

    expect(
      screen.getByText(
        "Unable to load avatar library. Connect to Cloudflare WARP and try again.",
      ),
    ).toBeInTheDocument();

    rerender(picker(libraryWithError("unavailable")));

    expect(
      screen.getByText("Avatar library unavailable. Try again."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Custom URLs still work/i),
    ).not.toBeInTheDocument();
  });
});
