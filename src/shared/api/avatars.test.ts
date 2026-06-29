import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_CACHE_WARMED_EVENT,
  AvatarLibraryError,
  ensureAvatarCollection,
  getAvatarCatalog,
  getAvatarLibrarySnapshot,
  getCachedAvatarCollections,
  getCachedAvatarForRef,
  getCachedAvatarsForRefs,
  listenAvatarCacheWarmed,
  normalizeAvatarLibraryError,
} from "./avatars";
import type { AvatarCatalog } from "@/shared/avatars/catalog";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const catalog = {
  schemaVersion: 1,
  catalogVersion: "v1",
  collections: [
    {
      id: "gloopies",
      label: "Gloopies",
      coverAvatarId: "gloopy-1",
      avatarIds: ["gloopy-1"],
    },
  ],
  assets: [
    {
      id: "gloopy-1",
      label: "Gloopy 1",
      collectionId: "gloopies",
      variants: {
        webm: {
          path: "webm/gloopies/gloopy-1.webm",
          mimeType: "video/webm",
          byteSize: 100,
          sha256: "a".repeat(64),
        },
        hevc: {
          path: "hevc/gloopies/gloopy-1.mp4",
          mimeType: "video/mp4",
          byteSize: 200,
          sha256: "b".repeat(64),
        },
      },
    },
  ],
} satisfies AvatarCatalog;
const cachedCollections = [
  {
    catalogVersion: "v1",
    collectionId: "gloopies",
    assets: [
      {
        id: "gloopy-1",
        path: "/tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
        mimeType: "video/webm",
      },
    ],
  },
];

describe("avatars api", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("loads the library snapshot from Rust and parses the catalog", async () => {
    invokeMock.mockResolvedValueOnce({ catalog, cachedCollections });

    await expect(getAvatarLibrarySnapshot()).resolves.toEqual({
      catalog,
      cachedCollections,
    });

    expect(invokeMock).toHaveBeenCalledWith("get_avatar_library_snapshot");
  });

  it("normalizes avatar library command errors", async () => {
    invokeMock.mockRejectedValueOnce({
      code: "networkAccess",
      message:
        "Unable to load avatar library. Connect to Cloudflare WARP and try again.",
    });

    await expect(getAvatarLibrarySnapshot()).rejects.toMatchObject({
      name: "AvatarLibraryError",
      code: "networkAccess",
      message:
        "Unable to load avatar library. Connect to Cloudflare WARP and try again.",
    });

    const legacyError = normalizeAvatarLibraryError("Avatar library exploded");
    expect(legacyError).toBeInstanceOf(AvatarLibraryError);
    expect(legacyError).toMatchObject({
      name: "AvatarLibraryError",
      code: "unavailable",
      message: "Avatar library exploded",
    });
  });

  it("keeps compatibility helpers on the snapshot command without catalog round-trips", async () => {
    invokeMock.mockResolvedValue({ catalog, cachedCollections });

    await expect(getAvatarCatalog()).resolves.toEqual(catalog);
    await expect(getCachedAvatarCollections({ catalog })).resolves.toEqual(
      cachedCollections,
    );

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "get_avatar_library_snapshot",
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "get_avatar_library_snapshot",
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ catalog }),
    );
  });

  it("ensures collections by catalog version and collection id", async () => {
    invokeMock.mockResolvedValueOnce({
      catalogVersion: "v1",
      collectionId: "gloopies",
      assets: [],
      failedAssetIds: ["gloopy-2"],
      errorCode: "networkAccess",
    });

    await expect(
      ensureAvatarCollection({
        catalogVersion: "v1",
        collectionId: "gloopies",
      }),
    ).resolves.toMatchObject({
      catalogVersion: "v1",
      errorCode: "networkAccess",
    });

    expect(invokeMock).toHaveBeenCalledWith("ensure_avatar_collection", {
      catalogVersion: "v1",
      collectionId: "gloopies",
    });
  });

  it("resolves saved refs with the batched cached-only command", async () => {
    invokeMock.mockResolvedValueOnce({
      "app-avatar:gloopy-1": {
        catalogVersion: "v1",
        collectionId: "gloopies",
        asset: cachedCollections[0].assets[0],
      },
    });
    await expect(
      getCachedAvatarForRef({ avatarRef: "app-avatar:gloopy-1" }),
    ).resolves.toMatchObject({
      catalogVersion: "v1",
      collectionId: "gloopies",
    });

    expect(invokeMock).toHaveBeenCalledWith("get_cached_avatars_for_refs", {
      avatarRefs: ["app-avatar:gloopy-1"],
    });
  });

  it("coalesces same-tick cached avatar lookups", async () => {
    invokeMock.mockResolvedValueOnce({
      "app-avatar:gloopy-1": {
        catalogVersion: "v1",
        collectionId: "gloopies",
        asset: cachedCollections[0].assets[0],
      },
      "app-avatar:gloopy-2": null,
    });

    const first = getCachedAvatarForRef({ avatarRef: "app-avatar:gloopy-1" });
    const second = getCachedAvatarForRef({ avatarRef: "app-avatar:gloopy-2" });

    await expect(first).resolves.toMatchObject({
      catalogVersion: "v1",
      collectionId: "gloopies",
    });
    await expect(second).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("get_cached_avatars_for_refs", {
      avatarRefs: ["app-avatar:gloopy-1", "app-avatar:gloopy-2"],
    });
  });

  it("resolves an explicit cached avatar batch", async () => {
    invokeMock.mockResolvedValueOnce({
      "app-avatar:gloopy-1": {
        catalogVersion: "v1",
        collectionId: "gloopies",
        asset: cachedCollections[0].assets[0],
      },
    });

    await expect(
      getCachedAvatarsForRefs({ avatarRefs: ["app-avatar:gloopy-1"] }),
    ).resolves.toHaveProperty("app-avatar:gloopy-1");
    expect(invokeMock).toHaveBeenCalledWith("get_cached_avatars_for_refs", {
      avatarRefs: ["app-avatar:gloopy-1"],
    });
  });

  it("does not subscribe to avatar warm events outside Tauri", async () => {
    await expect(listenAvatarCacheWarmed(vi.fn())).resolves.toEqual(
      expect.any(Function),
    );
    expect(AVATAR_CACHE_WARMED_EVENT).toBe("berd:avatar-cache-warmed");
  });
});
