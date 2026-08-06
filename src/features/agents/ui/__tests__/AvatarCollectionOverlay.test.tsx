import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { AvatarCatalog } from "@/shared/avatars/catalog";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import type {
  AvatarCollectionGloopieProps,
  AvatarCollectionGloopieReview,
} from "../AvatarCollectionOverlay";
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
    cachedAvatarMediaById,
    loading: false,
    cacheChecking: false,
    error: false,
    errorCode: null,
    downloadingCollectionIds: new Set<string>(),
    failedCollectionIds: new Set<string>(),
    retryCatalog: vi.fn(),
    openCollection: vi.fn().mockResolvedValue(undefined),
    isCollectionCached: () => true,
    ...overrides,
  };
}

function gloopieWith(
  overrides: Partial<AvatarCollectionGloopieProps> = {},
): AvatarCollectionGloopieProps {
  return {
    object: "",
    setObject: vi.fn(),
    start: vi.fn(),
    onHandoff: vi.fn(),
    hasActiveWork: false,
    onOpenActiveWork: vi.fn(),
    ...overrides,
  };
}

function reviewWith(
  overrides: Partial<AvatarCollectionGloopieReview> = {},
): AvatarCollectionGloopieReview {
  return {
    options: [
      { id: "one", avatarRef: "user-avatar:one" },
      { id: "two", avatarRef: "user-avatar:two" },
      { id: "three", avatarRef: "user-avatar:three" },
      { id: "four", avatarRef: "user-avatar:four" },
    ],
    chosenOptionId: null,
    chooseOption: vi.fn(),
    animate: vi.fn(),
    regenerate: vi.fn(),
    startOver: vi.fn(),
    onHandoff: vi.fn(),
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

  it("highlights an avatar on click and commits it via the Select button", () => {
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
    expect(onSelectAvatar).not.toHaveBeenCalled();
    finishExitAnimation();
    expect(onSelectAvatar).toHaveBeenCalledWith("g-1");
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

  it("opens the create prompt on the glass and hands off after generate", () => {
    const gloopie = gloopieWith({ object: "a friendly teapot" });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
        gloopie={gloopie}
      />,
    );

    fireEvent.click(
      overlay().getAllByRole("button", { name: /create your own/i })[0],
    );

    // The prompt renders on the overlay itself, under the swapped title.
    expect(
      overlay().getByRole("heading", { name: /create your own/i }),
    ).toBeInTheDocument();
    expect(
      overlay().getByPlaceholderText(/friendly teapot/i),
    ).toBeInTheDocument();

    fireEvent.click(overlay().getByRole("button", { name: /create gloopie/i }));
    // Generation starts immediately; the handoff waits for the exit.
    expect(gloopie.start).toHaveBeenCalledTimes(1);
    expect(gloopie.onHandoff).not.toHaveBeenCalled();
    finishExitAnimation();
    expect(gloopie.onHandoff).toHaveBeenCalledTimes(1);
  });

  it("disables generate until a prompt is entered and backs out of the prompt in place", () => {
    const gloopie = gloopieWith({ object: "" });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
        gloopie={gloopie}
      />,
    );

    fireEvent.click(
      overlay().getAllByRole("button", { name: /create your own/i })[0],
    );
    expect(
      overlay().getByRole("button", { name: /create gloopie/i }),
    ).toBeDisabled();

    // Back returns to the collections canvas without closing the overlay.
    fireEvent.click(
      overlay().getByRole("button", { name: /back to avatar collections/i }),
    );
    expect(
      overlay().getByRole("heading", { name: /avatar collections/i }),
    ).toBeInTheDocument();
  });

  it("routes the create tile to in-flight work instead of the prompt", () => {
    const gloopie = gloopieWith({ hasActiveWork: true });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
        gloopie={gloopie}
      />,
    );

    fireEvent.click(
      overlay().getAllByRole("button", { name: /gloopie in progress/i })[0],
    );
    finishExitAnimation();
    expect(gloopie.onOpenActiveWork).toHaveBeenCalledTimes(1);
    expect(
      overlay().queryByPlaceholderText(/friendly teapot/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the takeover open while generating instead of handing off", () => {
    const gloopie = gloopieWith({
      object: "a friendly teapot",
      stayOpenWhileGenerating: true,
    });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
        gloopie={gloopie}
      />,
    );

    fireEvent.click(
      overlay().getAllByRole("button", { name: /create your own/i })[0],
    );
    fireEvent.click(overlay().getByRole("button", { name: /create gloopie/i }));

    // Generation started, but the surface stays put so the options can land
    // here rather than back in the builder rail.
    expect(gloopie.start).toHaveBeenCalledTimes(1);
    finishExitAnimation();
    expect(gloopie.onHandoff).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("avatar-collection-overlay"),
    ).toBeInTheDocument();
  });

  it("shows generation progress on the glass and can background the work", () => {
    const onContinueSetup = vi.fn();
    const gloopie = gloopieWith({
      object: "a friendly teapot",
      hasActiveWork: true,
      stayOpenWhileGenerating: true,
      generating: { onContinueSetup, onDiscard: vi.fn() },
    });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
        gloopie={gloopie}
      />,
    );

    expect(
      overlay().getByRole("heading", { name: /creating your gloopie/i }),
    ).toBeInTheDocument();

    fireEvent.click(
      overlay().getByRole("button", { name: /continue setting up agent/i }),
    );
    finishExitAnimation();
    expect(onContinueSetup).toHaveBeenCalledTimes(1);
  });

  it("picks a generated option on the glass and animates it", () => {
    const review = reviewWith({ chosenOptionId: "two" });
    const gloopie = gloopieWith({
      object: "a friendly teapot",
      hasActiveWork: true,
      stayOpenWhileGenerating: true,
      review,
    });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
        gloopie={gloopie}
      />,
    );

    // The choose step replaces the collection canvas on the same surface.
    expect(
      overlay().getByRole("heading", { name: /pick your favorite/i }),
    ).toBeInTheDocument();

    fireEvent.click(
      overlay().getByRole("button", { name: /gloopie option 1 of 4/i }),
    );
    expect(review.chooseOption).toHaveBeenCalledWith("one");

    fireEvent.click(overlay().getByRole("button", { name: /^animate$/i }));
    // Animation starts immediately; the handoff waits for the exit animation.
    expect(review.animate).toHaveBeenCalledTimes(1);
    expect(review.onHandoff).not.toHaveBeenCalled();
    finishExitAnimation();
    expect(review.onHandoff).toHaveBeenCalledTimes(1);
  });

  it("cannot animate before an option is chosen", () => {
    const review = reviewWith({ chosenOptionId: null });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
        gloopie={gloopieWith({ hasActiveWork: true, review })}
      />,
    );

    expect(
      overlay().getByRole("button", { name: /^animate$/i }),
    ).toBeDisabled();
    expect(review.animate).not.toHaveBeenCalled();
  });

  it("returns from review to the prompt instead of closing the takeover", () => {
    const review = reviewWith({ chosenOptionId: "one" });
    const onClose = vi.fn();
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={onClose}
        gloopie={gloopieWith({
          object: "a friendly teapot",
          hasActiveWork: true,
          review,
        })}
      />,
    );

    fireEvent.click(overlay().getByRole("button", { name: /start over/i }));

    // Throwing away four generated options asks first instead of acting.
    expect(review.startOver).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: /start over\?/i });
    fireEvent.click(
      within(dialog).getByRole("button", { name: /start over/i }),
    );
    finishExitAnimation();

    // Abandoning the options keeps the user on the takeover, at the prompt.
    expect(review.startOver).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("avatar-collection-overlay"),
    ).toBeInTheDocument();
  });

  it("keeps the options when the start-over confirmation is dismissed", () => {
    const review = reviewWith({ chosenOptionId: "one" });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
        gloopie={gloopieWith({
          object: "a friendly teapot",
          hasActiveWork: true,
          review,
        })}
      />,
    );

    fireEvent.click(overlay().getByRole("button", { name: /start over/i }));
    const dialog = screen.getByRole("dialog", { name: /start over\?/i });
    fireEvent.click(
      within(dialog).getByRole("button", { name: /keep going/i }),
    );

    expect(review.startOver).not.toHaveBeenCalled();
    expect(
      overlay().getByRole("heading", { name: /pick your favorite/i }),
    ).toBeInTheDocument();
  });

  it("asks before discarding an in-flight generation from the glass", () => {
    const onDiscard = vi.fn();
    const gloopie = gloopieWith({
      object: "a friendly teapot",
      hasActiveWork: true,
      stayOpenWhileGenerating: true,
      generating: { onContinueSetup: vi.fn(), onDiscard },
    });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
        gloopie={gloopie}
      />,
    );

    fireEvent.click(overlay().getByRole("button", { name: /^cancel$/i }));
    expect(onDiscard).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog", {
      name: /cancel this gloopie\?/i,
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: /cancel gloopie/i }),
    );

    // The attempt is abandoned and the takeover lands back on the prompt.
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("clicking the highlighted option again releases the selection", () => {
    const review = reviewWith({ chosenOptionId: "one" });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
        gloopie={gloopieWith({ hasActiveWork: true, review })}
      />,
    );

    fireEvent.click(
      overlay().getByRole("button", { name: /gloopie option 1 of 4/i }),
    );
    expect(review.chooseOption).toHaveBeenCalledWith(null);
  });

  it("clicking empty canvas on the review step releases the selection", () => {
    const review = reviewWith({ chosenOptionId: "one" });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={libraryWith(
          catalogWith({ gloopies: ["g-1"], robots: ["r-1"] }),
        )}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
        gloopie={gloopieWith({ hasActiveWork: true, review })}
      />,
    );

    // Anywhere that is not an option tile or a control counts as "off the
    // avatar" — the wordmark included. The click bubbles to the canvas.
    fireEvent.click(
      overlay().getByRole("heading", { name: /pick your favorite/i }),
    );
    expect(review.chooseOption).toHaveBeenCalledWith(null);
  });

  it("requests collection assets when a collection opens", () => {
    const library = libraryWith(catalogWith({ gloopies: ["g-1"] }));
    renderWithProviders(
      <AvatarCollectionOverlay
        library={library}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(library.openCollection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gloopies" }),
    );
  });

  it("surfaces a retry pill when the open collection failed to load", () => {
    const library = libraryWith(catalogWith({ gloopies: ["g-1"] }), {
      failedCollectionIds: new Set(["gloopies"]),
      errorCode: "networkAccess",
    });
    renderWithProviders(
      <AvatarCollectionOverlay
        library={library}
        onSelectAvatar={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(overlay().getByRole("button", { name: /retry/i }));
    expect(library.openCollection).toHaveBeenCalled();
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
