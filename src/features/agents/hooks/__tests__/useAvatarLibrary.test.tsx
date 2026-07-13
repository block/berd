import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AvatarCatalog,
  AvatarCollection,
  CachedAvatarCollection,
} from "@/shared/avatars/catalog";

vi.mock("@/shared/api/avatars", async () => {
  const actual = await vi.importActual<typeof import("@/shared/api/avatars")>(
    "@/shared/api/avatars",
  );
  return {
    ...actual,
    getAvatarCatalog: vi.fn(),
    getCachedAvatarCollections: vi.fn(),
    ensureAvatarCollection: vi.fn(),
    cachedAssetToMedia: (asset: { path: string; mimeType: string }) => ({
      src: asset.path,
      mediaType: "image" as const,
    }),
  };
});

import {
  ensureAvatarCollection,
  getAvatarCatalog,
  getCachedAvatarCollections,
} from "@/shared/api/avatars";
import { useAvatarLibrary } from "../useAvatarLibrary";

const CATALOG_VERSION = "v1";

function collection(id: string): AvatarCollection {
  return {
    id,
    label: id,
    coverAvatarId: `${id}-1`,
    avatarIds: [`${id}-1`, `${id}-2`],
  };
}

function catalogWithCollections(
  collections: AvatarCollection[],
): AvatarCatalog {
  return {
    schemaVersion: 1,
    catalogVersion: CATALOG_VERSION,
    collections,
    assets: collections.flatMap((entry) =>
      entry.avatarIds.map((avatarId) => ({
        id: avatarId,
        label: avatarId,
        collectionId: entry.id,
        variants: {
          webm: {
            path: `${avatarId}.webm`,
            mimeType: "video/webm",
            byteSize: 1,
            sha256: "0".repeat(64),
          },
          hevc: {
            path: `${avatarId}.mov`,
            mimeType: "video/quicktime",
            byteSize: 1,
            sha256: "0".repeat(64),
          },
        },
      })),
    ),
  };
}

function cachedCollection(id: string): CachedAvatarCollection {
  return {
    catalogVersion: CATALOG_VERSION,
    collectionId: id,
    assets: [`${id}-1`, `${id}-2`].map((avatarId) => ({
      id: avatarId,
      path: `/cache/${avatarId}.webm`,
      mimeType: "video/webm",
    })),
  };
}

const collectionA = collection("a");
const collectionB = collection("b");

describe("useAvatarLibrary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAvatarCatalog).mockResolvedValue(
      catalogWithCollections([collectionA, collectionB]),
    );
    vi.mocked(getCachedAvatarCollections).mockResolvedValue([]);
  });

  it("tracks concurrent collection downloads independently", async () => {
    const pending = new Map<string, (value: CachedAvatarCollection) => void>();
    vi.mocked(ensureAvatarCollection).mockImplementation(
      ({ collectionId }) =>
        new Promise((resolve) => {
          pending.set(collectionId, (value) =>
            resolve({ ...value, failedAssetIds: [] }),
          );
        }),
    );

    const { result } = renderHook(() => useAvatarLibrary(true));
    await waitFor(() => expect(result.current.catalog).not.toBeNull());

    // Start download A, then B — both should stay marked as downloading.
    act(() => {
      void result.current.openCollection(collectionA);
    });
    act(() => {
      void result.current.openCollection(collectionB);
    });

    expect(result.current.downloadingCollectionIds.has("a")).toBe(true);
    expect(result.current.downloadingCollectionIds.has("b")).toBe(true);

    // Finish A: only B remains downloading.
    await act(async () => {
      pending.get("a")?.(cachedCollection("a"));
    });
    expect(result.current.downloadingCollectionIds.has("a")).toBe(false);
    expect(result.current.downloadingCollectionIds.has("b")).toBe(true);
    expect(result.current.isCollectionCached(collectionA)).toBe(true);

    // Finish B: nothing downloading, both cached.
    await act(async () => {
      pending.get("b")?.(cachedCollection("b"));
    });
    expect(result.current.downloadingCollectionIds.size).toBe(0);
    expect(result.current.isCollectionCached(collectionB)).toBe(true);
    expect(result.current.failedCollectionIds.size).toBe(0);
  });

  it("does not start a second download for a collection already in flight", async () => {
    const pending = new Map<string, (value: CachedAvatarCollection) => void>();
    vi.mocked(ensureAvatarCollection).mockImplementation(
      ({ collectionId }) =>
        new Promise((resolve) => {
          pending.set(collectionId, (value) =>
            resolve({ ...value, failedAssetIds: [] }),
          );
        }),
    );

    const { result } = renderHook(() => useAvatarLibrary(true));
    await waitFor(() => expect(result.current.catalog).not.toBeNull());

    act(() => {
      void result.current.openCollection(collectionA);
    });
    // Re-opening the same collection while downloading is a no-op.
    await act(async () => {
      await result.current.openCollection(collectionA);
    });

    expect(vi.mocked(ensureAvatarCollection)).toHaveBeenCalledTimes(1);
    expect(result.current.downloadingCollectionIds.has("a")).toBe(true);

    await act(async () => {
      pending.get("a")?.(cachedCollection("a"));
    });
    expect(result.current.downloadingCollectionIds.size).toBe(0);
  });

  it("clears the downloading flag when a download fails", async () => {
    vi.mocked(ensureAvatarCollection).mockRejectedValue(
      new Error("network down"),
    );

    const { result } = renderHook(() => useAvatarLibrary(true));
    await waitFor(() => expect(result.current.catalog).not.toBeNull());

    await act(async () => {
      await result.current.openCollection(collectionA);
    });

    expect(result.current.downloadingCollectionIds.size).toBe(0);
    expect(result.current.failedCollectionIds.has("a")).toBe(true);
  });
});
