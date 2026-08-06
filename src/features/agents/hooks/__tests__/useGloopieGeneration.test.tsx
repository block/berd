import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGloopieGeneration } from "@/features/agents/hooks/useGloopieGeneration";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import type { AvatarCatalog } from "@/shared/avatars/catalog";
import { resetGloopieGenerationStoreForTests } from "@/features/agents/stores/gloopieGenerationStore";

function makeCatalog(
  ids: string[],
  collectionId = "c1",
  collections: AvatarCatalog["collections"] = [
    {
      id: collectionId,
      label: "Collection",
      coverAvatarId: ids[0] ?? "",
      avatarIds: ids,
    },
  ],
): AvatarCatalog {
  return {
    schemaVersion: 1,
    catalogVersion: "test",
    collections,
    assets: ids.map((id) => ({
      id,
      label: id,
      collectionId,
      variants: {
        webm: {
          path: `${id}.webm`,
          mimeType: "video/webm",
          byteSize: 1,
          sha256: "x",
        },
        hevc: {
          path: `${id}.mp4`,
          mimeType: "video/mp4",
          byteSize: 1,
          sha256: "x",
        },
      },
    })),
  };
}

function makeLibrary(catalog: AvatarCatalog | null): AvatarLibraryState {
  return {
    catalog,
    cachedAvatarMediaById: {},
    loading: false,
    cacheChecking: false,
    error: false,
    errorCode: null,
    downloadingCollectionIds: new Set(),
    failedCollectionIds: new Set(),
    retryCatalog: vi.fn(),
    openCollection: vi.fn(async () => {}),
    isCollectionCached: () => false,
  };
}

describe("useGloopieGeneration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGloopieGenerationStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in the prompt phase", () => {
    const { result } = renderHook(() =>
      useGloopieGeneration(makeLibrary(makeCatalog(["a", "b", "c", "d", "e"]))),
    );
    expect(result.current.phase).toBe("prompt");
    expect(result.current.options).toHaveLength(0);
  });

  it("does not generate with an empty object", () => {
    const { result } = renderHook(() =>
      useGloopieGeneration(makeLibrary(makeCatalog(["a", "b"]))),
    );
    act(() => result.current.startGenerate());
    expect(result.current.phase).toBe("prompt");
  });

  it("uses the bundled sample gloopie avatar for the shadow placeholder", () => {
    const catalog = makeCatalog(
      ["other-1", "gloopies-1", "gloopies-14"],
      "mixed",
      [
        {
          id: "other",
          label: "Other",
          coverAvatarId: "other-1",
          avatarIds: ["other-1"],
        },
        {
          id: "gloopies",
          label: "Gloopies",
          coverAvatarId: "gloopies-1",
          avatarIds: ["gloopies-1", "gloopies-14"],
        },
      ],
    );

    const { result } = renderHook(() =>
      useGloopieGeneration(makeLibrary(catalog)),
    );

    expect(result.current.sampleAvatarRef).toBe("app-avatar:gloopies-14");
  });

  it("walks prompt -> generating -> choosing -> animating -> done", () => {
    const { result } = renderHook(() =>
      useGloopieGeneration(makeLibrary(makeCatalog(["a", "b", "c", "d", "e"]))),
    );

    act(() => result.current.setObject("teapot"));
    act(() => result.current.startGenerate());
    expect(result.current.phase).toBe("generating");

    act(() => vi.runOnlyPendingTimers());
    expect(result.current.phase).toBe("choosing");
    expect(result.current.options.length).toBeGreaterThan(0);

    const firstOption = result.current.options[0];
    act(() => result.current.chooseOption(firstOption.id));
    expect(result.current.chosenOptionId).toBe(firstOption.id);

    act(() => result.current.animate());
    expect(result.current.phase).toBe("animating");

    act(() => vi.runOnlyPendingTimers());
    expect(result.current.phase).toBe("done");
    expect(result.current.resultAvatarRef).toBe(firstOption.avatarRef);
  });

  it("surfaces a recoverable error when no catalog media is available", () => {
    const { result } = renderHook(() =>
      useGloopieGeneration(makeLibrary(null)),
    );
    act(() => result.current.setObject("teapot"));
    act(() => result.current.startGenerate());
    act(() => vi.runOnlyPendingTimers());
    expect(result.current.phase).toBe("error");
    expect(result.current.errorCode).toBe("unavailable");
  });

  it("reset returns to a clean prompt state", () => {
    const { result } = renderHook(() =>
      useGloopieGeneration(makeLibrary(makeCatalog(["a", "b", "c", "d"]))),
    );
    act(() => result.current.setObject("teapot"));
    act(() => result.current.startGenerate());
    act(() => vi.runOnlyPendingTimers());
    act(() => result.current.reset());
    expect(result.current.phase).toBe("prompt");
    expect(result.current.object).toBe("");
    expect(result.current.options).toHaveLength(0);
  });

  it("can preserve the prompt when starting over", () => {
    const { result } = renderHook(() =>
      useGloopieGeneration(makeLibrary(makeCatalog(["a", "b", "c", "d"]))),
    );
    act(() => result.current.setObject("teapot"));
    act(() => result.current.startGenerate());
    act(() => vi.runOnlyPendingTimers());
    act(() => result.current.reset({ keepObject: true }));
    expect(result.current.phase).toBe("prompt");
    expect(result.current.object).toBe("teapot");
    expect(result.current.options).toHaveLength(0);
  });
});
