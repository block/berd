import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import { AvatarLibraryPicker } from "../AvatarLibraryPicker";

function libraryWithError(
  errorCode: AvatarLibraryState["errorCode"],
): AvatarLibraryState {
  return {
    catalog: null,
    userAvatarIds: [],
    cachedAvatarMediaById: {},
    loading: false,
    cacheChecking: false,
    error: true,
    errorCode,
    mediaError: false,
    mediaErrorCode: null,
    retryCatalog: vi.fn(),
    retryMedia: vi.fn(),
  };
}

function libraryWithMediaError(): AvatarLibraryState {
  const retryMedia = vi.fn();
  return {
    catalog: {
      schemaVersion: 1,
      catalogVersion: "v1",
      collections: [
        {
          id: "gloopies",
          label: "Gloopies",
          coverAvatarId: "g-1",
          avatarIds: ["g-1"],
        },
      ],
      assets: [
        {
          id: "g-1",
          label: "Gloopie One",
          collectionId: "gloopies",
          variants: {
            webm: {
              path: "g-1.webm",
              mimeType: "video/webm",
              byteSize: 1,
              sha256: "0".repeat(64),
            },
            hevc: {
              path: "g-1.mov",
              mimeType: "video/quicktime",
              byteSize: 1,
              sha256: "0".repeat(64),
            },
          },
        },
      ],
    },
    userAvatarIds: [],
    cachedAvatarMediaById: {},
    loading: false,
    cacheChecking: false,
    error: false,
    errorCode: null,
    mediaError: true,
    mediaErrorCode: "unavailable",
    retryCatalog: vi.fn(),
    retryMedia,
  };
}

function picker(library: AvatarLibraryState, onSelectAvatar = vi.fn()) {
  return (
    <AvatarLibraryPicker
      library={library}
      selectedAvatarRef={null}
      onSelectAvatar={onSelectAvatar}
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
        "Unable to load avatar library. Check your network connection and try again.",
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

  it("leaves the Gloopies collection unchanged when the user has none", () => {
    renderWithProviders(picker(libraryWithMediaError()));

    expect(
      screen.getByRole("button", { name: /Gloopies/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Custom gloopie" }),
    ).not.toBeInTheDocument();
  });

  it("prepends and selects a reusable custom gloopie in Gloopies", () => {
    const library = libraryWithMediaError();
    library.userAvatarIds = ["gloopie-custom"];
    library.cachedAvatarMediaById["gloopie-custom"] = {
      catalogVersion: "user-generated",
      media: {
        src: "asset://gloopie-custom.webm",
        mediaType: "video",
        alphaMode: "stacked",
        posterSrc: "asset://gloopie-custom.poster.png",
      },
    };
    const onSelectAvatar = vi.fn();
    renderWithProviders(picker(library, onSelectAvatar));

    fireEvent.click(screen.getByRole("button", { name: "Gloopies" }));
    const avatarButtons = screen
      .getAllByRole("button")
      .filter((button) =>
        ["Custom gloopie", "Gloopie One"].includes(
          button.getAttribute("aria-label") ?? "",
        ),
      );
    expect(
      avatarButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Custom gloopie", "Gloopie One"]);

    fireEvent.click(screen.getByRole("button", { name: "Custom gloopie" }));
    expect(onSelectAvatar).toHaveBeenCalledWith("user-avatar:gloopie-custom");
  });

  it("shows missing-media feedback with a manual retry", () => {
    const library = libraryWithMediaError();
    renderWithProviders(picker(library));

    expect(screen.getByText("Failed to load image")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(library.retryMedia).toHaveBeenCalledOnce();
  });
});
