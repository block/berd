import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AvatarCatalog,
  CachedAvatarCollection,
} from "@/shared/avatars/catalog";

const cacheWarmedListeners: Array<() => void> = [];
const userLibraryChangedListeners: Array<() => void> = [];
vi.mock("@/shared/api/avatars", async () => {
  const actual = await vi.importActual<typeof import("@/shared/api/avatars")>(
    "@/shared/api/avatars",
  );
  return {
    ...actual,
    getAvatarLibrarySnapshot: vi.fn(),
    refreshAvatarCache: vi.fn(),
    listenAvatarCacheWarmed: vi.fn(async (handler: () => void) => {
      cacheWarmedListeners.push(handler);
      return vi.fn();
    }),
    listenUserAvatarLibraryChanged: vi.fn(async (handler: () => void) => {
      userLibraryChangedListeners.push(handler);
      return vi.fn();
    }),
    cachedAssetToMedia: (asset: { path: string; mimeType: string }) => ({
      src: asset.path,
      mediaType: asset.mimeType.startsWith("video/")
        ? ("video" as const)
        : ("image" as const),
    }),
  };
});

import {
  getAvatarLibrarySnapshot,
  listenUserAvatarLibraryChanged,
  refreshAvatarCache,
} from "@/shared/api/avatars";
import { useAvatarLibrary } from "../useAvatarLibrary";

const catalog: AvatarCatalog = {
  schemaVersion: 1,
  catalogVersion: "v1",
  collections: [
    { id: "a", label: "a", coverAvatarId: "a-1", avatarIds: ["a-1"] },
  ],
  assets: [
    {
      id: "a-1",
      label: "a-1",
      collectionId: "a",
      variants: {
        webm: {
          path: "a-1.webm",
          mimeType: "video/webm",
          byteSize: 1,
          sha256: "0".repeat(64),
        },
        hevc: {
          path: "a-1.mov",
          mimeType: "video/quicktime",
          byteSize: 1,
          sha256: "0".repeat(64),
        },
      },
    },
  ],
};

function cachedCollection(path: string): CachedAvatarCollection {
  return {
    catalogVersion: "v1",
    collectionId: "a",
    assets: [{ id: "a-1", path, mimeType: "video/webm" }],
    failedAssetIds: [],
  };
}

describe("useAvatarLibrary", () => {
  beforeEach(() => {
    cacheWarmedListeners.length = 0;
    userLibraryChangedListeners.length = 0;
    vi.clearAllMocks();
    vi.mocked(getAvatarLibrarySnapshot).mockResolvedValue({
      catalog,
      cachedCollections: [cachedCollection("/cache/a-1.webm")],
      mediaRefreshing: false,
      mediaRefreshCompleted: true,
    });
    vi.mocked(refreshAvatarCache).mockResolvedValue();
  });

  it("loads the catalog and startup-cached assets without downloading", async () => {
    const { result } = renderHook(() => useAvatarLibrary(true));

    await waitFor(() => expect(result.current.catalog).toEqual(catalog));
    expect(result.current.cachedAvatarMediaById["a-1"].media.src).toBe(
      "/cache/a-1.webm",
    );
    expect(result.current.error).toBe(false);
  });

  it("keeps missing first-run media in progress while the initial refresh runs", async () => {
    vi.mocked(getAvatarLibrarySnapshot).mockResolvedValue({
      catalog,
      cachedCollections: [],
      mediaRefreshing: true,
      mediaRefreshCompleted: false,
    });
    const { result } = renderHook(() => useAvatarLibrary(true));

    await waitFor(() => expect(result.current.catalog).toEqual(catalog));
    expect(result.current.mediaError).toBe(false);
    expect(result.current.cacheChecking).toBe(true);
  });

  it("surfaces missing media after a failed refresh and retries", async () => {
    vi.mocked(getAvatarLibrarySnapshot).mockResolvedValue({
      catalog,
      cachedCollections: [],
      mediaRefreshing: false,
      mediaRefreshCompleted: true,
      mediaErrorCode: "unavailable",
    });
    const { result } = renderHook(() => useAvatarLibrary(true));

    await waitFor(() => expect(result.current.mediaError).toBe(true));
    vi.mocked(getAvatarLibrarySnapshot).mockResolvedValue({
      catalog,
      cachedCollections: [cachedCollection("/cache/a-1.webm")],
      mediaRefreshing: false,
      mediaRefreshCompleted: true,
    });
    act(() => result.current.retryMedia());

    await waitFor(() => expect(refreshAvatarCache).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.mediaError).toBe(false));
  });

  it("surfaces an incomplete poster fallback after a failed refresh", async () => {
    vi.mocked(getAvatarLibrarySnapshot).mockResolvedValue({
      catalog,
      cachedCollections: [
        {
          ...cachedCollection("/cache/a-1.png"),
          assets: [
            { id: "a-1", path: "/cache/a-1.png", mimeType: "image/png" },
          ],
          failedAssetIds: ["a-1"],
        },
      ],
      mediaRefreshing: false,
      mediaRefreshCompleted: true,
      mediaErrorCode: "networkAccess",
    });
    const { result } = renderHook(() => useAvatarLibrary(true));

    await waitFor(() => expect(result.current.mediaError).toBe(true));
    expect(result.current.cachedAvatarMediaById["a-1"].media.src).toBe(
      "/cache/a-1.png",
    );
    expect(result.current.mediaErrorCode).toBe("networkAccess");
  });

  it("surfaces a failed manual media refresh", async () => {
    vi.mocked(getAvatarLibrarySnapshot).mockResolvedValue({
      catalog,
      cachedCollections: [],
      mediaRefreshing: false,
      mediaRefreshCompleted: true,
      mediaErrorCode: "unavailable",
    });
    vi.mocked(refreshAvatarCache).mockRejectedValueOnce({
      code: "networkAccess",
      message: "offline",
    });
    const { result } = renderHook(() => useAvatarLibrary(true));

    await waitFor(() => expect(result.current.mediaError).toBe(true));
    act(() => result.current.retryMedia());

    await waitFor(() =>
      expect(result.current.mediaErrorCode).toBe("networkAccess"),
    );
  });

  it("reloads cached assets after the backend refresh event", async () => {
    const { result } = renderHook(() => useAvatarLibrary(true));
    await waitFor(() => expect(result.current.catalog).toEqual(catalog));

    vi.mocked(getAvatarLibrarySnapshot).mockResolvedValue({
      catalog,
      cachedCollections: [cachedCollection("/cache/refreshed.webm")],
      mediaRefreshing: false,
      mediaRefreshCompleted: true,
    });
    act(() => cacheWarmedListeners[0]?.());

    await waitFor(() =>
      expect(result.current.cachedAvatarMediaById["a-1"].media.src).toBe(
        "/cache/refreshed.webm",
      ),
    );
  });

  it("reconciles after delayed listener registration", async () => {
    let finishRegistration!: () => void;
    vi.mocked(listenUserAvatarLibraryChanged).mockImplementationOnce(
      async (handler: () => void) => {
        userLibraryChangedListeners.push(handler);
        await new Promise<void>((resolve) => {
          finishRegistration = resolve;
        });
        return () => {};
      },
    );
    const { result } = renderHook(() => useAvatarLibrary(true));
    await waitFor(() => expect(result.current.catalog).toEqual(catalog));

    vi.mocked(getAvatarLibrarySnapshot).mockResolvedValue({
      catalog,
      cachedCollections: [
        cachedCollection("/cache/a-1.webm"),
        {
          catalogVersion: "user-generated",
          collectionId: "generated-gloopies",
          assets: [
            {
              id: "gloopie-during-registration",
              path: "/user-avatars/gloopie-during-registration.mp4",
              mimeType: "video/mp4",
              alphaMode: "stacked",
            },
          ],
          failedAssetIds: [],
        },
      ],
      mediaRefreshing: false,
      mediaRefreshCompleted: true,
    });
    act(() => finishRegistration());

    await waitFor(() =>
      expect(result.current.userAvatarIds).toEqual([
        "gloopie-during-registration",
      ]),
    );
  });

  it("adds a newly created gloopie after the user library change event", async () => {
    const { result } = renderHook(() => useAvatarLibrary(true));
    await waitFor(() => expect(result.current.catalog).toEqual(catalog));

    vi.mocked(getAvatarLibrarySnapshot).mockResolvedValue({
      catalog,
      cachedCollections: [
        cachedCollection("/cache/a-1.webm"),
        {
          catalogVersion: "user-generated",
          collectionId: "generated-gloopies",
          assets: [
            {
              id: "gloopie-new",
              path: "/user-avatars/gloopie-new.mp4",
              mimeType: "video/mp4",
              alphaMode: "stacked",
            },
          ],
          failedAssetIds: [],
        },
      ],
      mediaRefreshing: false,
      mediaRefreshCompleted: true,
    });
    act(() => userLibraryChangedListeners[0]?.());

    await waitFor(() =>
      expect(result.current.userAvatarIds).toEqual(["gloopie-new"]),
    );
    expect(result.current.userAvatarMediaById["gloopie-new"]).toMatchObject({
      src: "/user-avatars/gloopie-new.mp4",
      mediaType: "video",
    });
    expect(result.current.cachedAvatarMediaById["gloopie-new"]).toBeUndefined();
  });
});
