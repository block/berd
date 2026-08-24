import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { AvatarCatalog } from "@/shared/avatars/catalog";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import { AvatarCollectionOverlay } from "../AvatarCollectionOverlay";

function entry(id: string, collectionId: string) {
  return {
    id,
    label: id,
    collectionId,
    variants: {
      webm: {
        path: `${id}.webm`,
        mimeType: "video/webm",
        byteSize: 1,
        sha256: id,
      },
      hevc: {
        path: `${id}.mov`,
        mimeType: "video/quicktime",
        byteSize: 1,
        sha256: id,
      },
    },
  };
}

function catalogWith(collections: Record<string, string[]>): AvatarCatalog {
  return {
    schemaVersion: 1,
    catalogVersion: "v1",
    collections: Object.entries(collections).map(([id, avatarIds]) => ({
      id,
      label: id,
      coverAvatarId: avatarIds[0],
      avatarIds,
    })),
    assets: Object.entries(collections).flatMap(([id, avatarIds]) =>
      avatarIds.map((avatarId) => entry(avatarId, id)),
    ),
  };
}

function libraryWith(
  catalog: AvatarCatalog | null,
  overrides: Partial<AvatarLibraryState> = {},
): AvatarLibraryState {
  const cachedAvatarMediaById: AvatarLibraryState["cachedAvatarMediaById"] = {};
  for (const asset of catalog?.assets ?? []) {
    cachedAvatarMediaById[asset.id] = {
      catalogVersion: "v1",
      media: { src: `cached-${asset.id}`, mediaType: "image" },
    };
  }
  return {
    catalog,
    userAvatarIds: [],
    userAvatarMediaById: {},
    cachedAvatarMediaById,
    loading: false,
    cacheChecking: false,
    error: false,
    errorCode: null,
    mediaError: false,
    mediaErrorCode: null,
    retryCatalog: vi.fn(),
    retryMedia: vi.fn(),
    ...overrides,
  };
}

/** Queries scoped to the primary (non-inert) wrap tile plus fixed chrome. */
function overlay() {
  return within(screen.getByTestId("avatar-collection-overlay"));
}

/** Run out the overlay's exit animation timer. */
function finishExitAnimation() {
  act(() => {
    vi.runAllTimers();
  });
}

describe("AvatarCollectionOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom reports zero rects; give the canvas a real size so the scatter
    // layout has a tile to fill.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      width: 1200,
      height: 800,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens straight into a single-collection catalog and closes on back after the exit animation", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(catalogWith({ gloopies: ["g-1", "g-2"] }))}
        onSelectAvatar={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(
      overlay().getByRole("heading", { name: /gloopies collection/i }),
    ).toBeInTheDocument();

    fireEvent.click(overlay().getByRole("button", { name: /^close$/i }));
    // Exit is animated: the callback fires only after the timer.
    expect(onClose).not.toHaveBeenCalled();
    finishExitAnimation();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("highlights an avatar, persists it, then closes", async () => {
    const onSelectAvatar = vi.fn();
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(catalogWith({ gloopies: ["g-1", "g-2"] }))}
        onSelectAvatar={onSelectAvatar}
        onClose={vi.fn()}
      />,
    );

    // No Select button until something is highlighted.
    expect(
      overlay().queryByRole("button", { name: /^select$/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(overlay().getAllByRole("button", { name: "g-1" })[0]);
    expect(onSelectAvatar).not.toHaveBeenCalled();
    expect(
      overlay()
        .getAllByRole("button", { name: "g-1" })
        .some((tile) => tile.getAttribute("aria-pressed") === "true"),
    ).toBe(true);

    fireEvent.click(overlay().getByRole("button", { name: /^select$/i }));
    expect(onSelectAvatar).toHaveBeenCalledWith("app-avatar:g-1");
    await act(async () => {});
    finishExitAnimation();
  });

  it("keeps the canvas and highlighted selection locked while persistence is pending", async () => {
    let resolveSelection: (() => void) | undefined;
    const onSelectAvatar = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSelection = resolve;
        }),
    );
    const onClose = vi.fn();
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(catalogWith({ gloopies: ["g-1", "g-2"] }))}
        onSelectAvatar={onSelectAvatar}
        onClose={onClose}
      />,
    );

    const selectedTile = overlay().getAllByRole("button", { name: "g-1" })[0];
    fireEvent.click(selectedTile);
    fireEvent.click(overlay().getByRole("button", { name: /^select$/i }));

    expect(selectedTile).toBeDisabled();
    expect(overlay().getAllByRole("button", { name: "g-2" })[0]).toBeDisabled();
    expect(overlay().getByRole("button", { name: /^close$/i })).toBeDisabled();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("avatar-collection-overlay"));
    finishExitAnimation();

    expect(onClose).not.toHaveBeenCalled();
    expect(
      overlay()
        .getAllByRole("button", { name: "g-1" })
        .some((tile) => tile.getAttribute("aria-pressed") === "true"),
    ).toBe(true);

    await act(async () => resolveSelection?.());
    finishExitAnimation();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a neutral loading state while the catalog loads", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(null, { loading: true, cacheChecking: true })}
        onSelectAvatar={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(overlay().getByRole("status")).toHaveTextContent("Loading");
    fireEvent.click(overlay().getByRole("button", { name: /^close$/i }));
    finishExitAnimation();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed selection highlighted and lets the user retry", async () => {
    const onSelectAvatar = vi
      .fn()
      .mockRejectedValueOnce(new Error("save failed"))
      .mockResolvedValueOnce(undefined);
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(catalogWith({ gloopies: ["g-1", "g-2"] }))}
        onSelectAvatar={onSelectAvatar}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(overlay().getAllByRole("button", { name: "g-1" })[0]);
    fireEvent.click(overlay().getByRole("button", { name: /^select$/i }));
    await act(async () => {});

    expect(overlay().getByRole("alert")).toHaveTextContent(
      "Save failed. Your edits are still here.",
    );
    expect(
      overlay()
        .getAllByRole("button", { name: "g-1" })
        .some((tile) => tile.getAttribute("aria-pressed") === "true"),
    ).toBe(true);

    fireEvent.click(overlay().getByRole("button", { name: /retry save/i }));
    await act(async () => {});
    expect(onSelectAvatar).toHaveBeenCalledTimes(2);
    expect(onSelectAvatar).toHaveBeenLastCalledWith("app-avatar:g-1");
    finishExitAnimation();
  });

  it("clears a failed selection when the highlighted avatar is toggled off", async () => {
    const onSelectAvatar = vi
      .fn()
      .mockRejectedValueOnce(new Error("save failed"));
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(catalogWith({ gloopies: ["g-1", "g-2"] }))}
        onSelectAvatar={onSelectAvatar}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(overlay().getAllByRole("button", { name: "g-1" })[0]);
    fireEvent.click(overlay().getByRole("button", { name: /^select$/i }));
    await act(async () => {});

    expect(overlay().getByRole("alert")).toBeInTheDocument();
    fireEvent.click(overlay().getAllByRole("button", { name: "g-1" })[0]);

    expect(overlay().queryByRole("alert")).not.toBeInTheDocument();
    expect(
      overlay().queryByRole("button", { name: /^select$/i }),
    ).not.toBeInTheDocument();
  });

  it("toggles the highlight off when the same avatar is clicked again", () => {
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(catalogWith({ gloopies: ["g-1", "g-2"] }))}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const tile = overlay().getAllByRole("button", { name: "g-1" })[0];
    fireEvent.click(tile);
    expect(
      overlay().getByRole("button", { name: /^select$/i }),
    ).toBeInTheDocument();
    fireEvent.click(tile);
    expect(
      overlay().queryByRole("button", { name: /^select$/i }),
    ).not.toBeInTheDocument();
  });

  it("renders no committed-avatar indicator when nothing is highlighted", () => {
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(catalogWith({ gloopies: ["g-1", "g-2"] }))}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // No tile carries a check badge on open; highlighting is purely
    // click-driven (aria-pressed) with no persistent committed marker.
    const tiles = overlay().getAllByRole("button", { name: "g-2" });
    expect(tiles.every((tile) => tile.querySelector("svg") === null)).toBe(
      true,
    );
    expect(
      tiles.every((tile) => tile.getAttribute("aria-pressed") === "false"),
    ).toBe(true);
  });

  it("shows the collections level for multi-collection catalogs and drills in", () => {
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      overlay().getByRole("heading", { name: /avatar collections/i }),
    ).toBeInTheDocument();

    fireEvent.click(
      overlay().getAllByRole("button", {
        name: /open the robots collection/i,
      })[0],
    );

    expect(
      overlay().getByRole("heading", { name: /robots collection/i }),
    ).toBeInTheDocument();
    // Back now goes up to collections, not out.
    expect(
      overlay().getByRole("button", { name: /back to avatar collections/i }),
    ).toBeInTheDocument();
  });

  it("orders collections gloopies, pollies, fuzzies with unknowns after", () => {
    // Catalog deliberately in the opposite order: the view owns the display
    // ranking (design direction), so it must not lean on catalog order.
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({
            robots: ["r-1"],
            fuzzies: ["f-1"],
            pollies: ["p-1"],
            gloopies: ["g-1"],
          }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const cards = overlay()
      .getAllByRole("button", { name: /open the .* collection/i })
      .map((card) => card.getAttribute("aria-label"));
    expect(cards).toEqual([
      "Open the gloopies collection",
      "Open the pollies collection",
      "Open the fuzzies collection",
      "Open the robots collection",
    ]);
    expect(overlay().getAllByText("Collection")).toHaveLength(4);
  });
  it("clears a pending highlight when going up to the collections level", () => {
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      overlay().getAllByRole("button", {
        name: /open the gloopies collection/i,
      })[0],
    );
    fireEvent.click(overlay().getAllByRole("button", { name: "g-1" })[0]);
    fireEvent.click(
      overlay().getByRole("button", { name: /back to avatar collections/i }),
    );
    fireEvent.click(
      overlay().getAllByRole("button", {
        name: /open the gloopies collection/i,
      })[0],
    );

    expect(
      overlay().queryByRole("button", { name: /^select$/i }),
    ).not.toBeInTheDocument();
  });

  it("clears a failed selection when going up to the collections level", async () => {
    const onSelectAvatar = vi.fn().mockRejectedValue(new Error("save failed"));
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={onSelectAvatar}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      overlay().getAllByRole("button", {
        name: /open the gloopies collection/i,
      })[0],
    );
    fireEvent.click(overlay().getAllByRole("button", { name: "g-1" })[0]);
    fireEvent.click(overlay().getByRole("button", { name: /^select$/i }));
    await act(async () => {});

    expect(overlay().getByRole("alert")).toBeInTheDocument();
    fireEvent.click(
      overlay().getByRole("button", { name: /back to avatar collections/i }),
    );

    expect(overlay().queryByRole("alert")).not.toBeInTheDocument();
    expect(
      overlay().getByRole("heading", { name: /avatar collections/i }),
    ).toBeInTheDocument();
  });

  it("returns to the collections level on Escape before closing", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(
      overlay().getAllByRole("button", {
        name: /open the gloopies collection/i,
      })[0],
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(
      overlay().getByRole("heading", { name: /avatar collections/i }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    finishExitAnimation();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on an empty-canvas click at the collections level only", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={onClose}
      />,
    );

    const canvas = screen.getByTestId("avatar-collection-overlay")
      .firstElementChild as HTMLElement;

    // Collections level: clicking the empty canvas closes (light dismiss).
    fireEvent.click(canvas);
    finishExitAnimation();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps empty-canvas clicks inert inside a collection", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(
      overlay().getAllByRole("button", {
        name: /open the gloopies collection/i,
      })[0],
    );

    const canvas = screen.getByTestId("avatar-collection-overlay")
      .firstElementChild as HTMLElement;
    // Inside a collection a stray canvas click must not throw the user out.
    fireEvent.click(canvas);
    finishExitAnimation();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      overlay().getByRole("heading", { name: /gloopies collection/i }),
    ).toBeInTheDocument();
  });

  /**
   * The stylesheet targets these structures by selector, so the DOM shape is a
   * contract rather than an implementation detail. `globals.css` relies on:
   *
   *   .avatar-scatter-item > button          (hover/press scale)
   *   button.avatar-scatter-item             (row tiles ARE the button)
   *   .avatar-scatter-item .avatar-scatter-media
   *   .avatar-scatter-waiting                (paint-gated entrance)
   *
   * and `applyPan` reaches into each tile for `.avatar-scatter-media` to
   * retrigger the arrival animation. None of that is observable through the
   * behavioral tests above, so these pin it explicitly.
   */
  describe("scatter DOM contract (styling + pan hooks)", () => {
    function scatterItems() {
      return Array.from(
        document.querySelectorAll<HTMLElement>(".avatar-scatter-item"),
      );
    }

    it("nests scatter tiles as item wrapper > button > media", () => {
      renderWithProviders(
        <AvatarCollectionOverlay
          library={libraryWith(catalogWith({ gloopies: ["g-1", "g-2"] }))}
          onSelectAvatar={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      // Inside a collection the tiles are wrappers, not buttons: hovering the
      // Select action must not wobble the avatar, which is why the scale rule
      // is scoped to `.avatar-scatter-item > button`.
      const wrappers = scatterItems().filter(
        (node) => node.tagName !== "BUTTON",
      );
      expect(wrappers.length).toBeGreaterThan(0);

      for (const wrapper of wrappers) {
        const button = wrapper.querySelector(":scope > button");
        expect(button).not.toBeNull();
        // The pan code queries the media from the wrapper, and the CSS
        // descendant selector needs it under the item.
        expect(wrapper.querySelector(".avatar-scatter-media")).not.toBeNull();
      }
    });

    it("renders collection row tiles as the button itself", () => {
      renderWithProviders(
        <AvatarCollectionOverlay
          library={libraryWith(
            catalogWith({ gloopies: ["g-1"], extras: ["e-1"] }),
          )}
          onSelectAvatar={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      // Multiple collections open on the collections row, where
      // `button.avatar-scatter-item` is the selector that drives the scale.
      const rowTiles = scatterItems();
      expect(rowTiles.length).toBeGreaterThan(0);
      for (const tile of rowTiles) {
        expect(tile.tagName).toBe("BUTTON");
        expect(tile.querySelector(".avatar-scatter-media")).not.toBeNull();
      }
    });

    it("holds the entrance paused until the media reports ready", () => {
      renderWithProviders(
        <AvatarCollectionOverlay
          library={libraryWith(catalogWith({ gloopies: ["g-1", "g-2"] }))}
          onSelectAvatar={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      // Cached media that has not painted yet keeps the pause class, which is
      // what stops tiles popping in as empty boxes.
      const waiting = document.querySelectorAll(".avatar-scatter-waiting");
      expect(waiting.length).toBeGreaterThan(0);
    });

    it("gives each scatter tile its own entrance delay", () => {
      renderWithProviders(
        <AvatarCollectionOverlay
          library={libraryWith(catalogWith({ gloopies: ["g-1", "g-2"] }))}
          onSelectAvatar={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      // The keyframes read this custom property; losing it collapses the
      // stagger into every tile popping at once.
      for (const item of scatterItems()) {
        expect(item.style.getPropertyValue("--scatter-pop-delay")).not.toBe("");
      }
    });
  });
});
