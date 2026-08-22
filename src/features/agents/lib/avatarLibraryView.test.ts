import { describe, expect, it, vi } from "vitest";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import type { AvatarCatalog } from "@/shared/avatars/catalog";
import { buildAvatarDisplayCollections } from "./avatarLibraryView";

const catalog: AvatarCatalog = {
  schemaVersion: 1,
  catalogVersion: "v1",
  collections: [
    {
      id: "gloopies",
      label: "Gloopies",
      coverAvatarId: "bundled-cover",
      avatarIds: ["shared-id", "bundled-cover"],
    },
    {
      id: "pollies",
      label: "Pollies",
      coverAvatarId: "pollie-cover",
      avatarIds: ["pollie-first", "pollie-cover"],
    },
  ],
  assets: [
    ["shared-id", "gloopies"],
    ["bundled-cover", "gloopies"],
    ["pollie-first", "pollies"],
    ["pollie-cover", "pollies"],
  ].map(([id, collectionId]) => ({
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
  })),
};

function library(
  overrides: Partial<AvatarLibraryState> = {},
): AvatarLibraryState {
  return {
    catalog,
    userAvatarIds: [],
    userAvatarMediaById: {},
    cachedAvatarMediaById: Object.fromEntries(
      catalog.assets.map((asset) => [
        asset.id,
        {
          catalogVersion: "v1",
          media: { src: `bundled:${asset.id}`, mediaType: "video" as const },
        },
      ]),
    ),
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

describe("buildAvatarDisplayCollections", () => {
  it("preserves a catalog-authored cover independently of tile order", () => {
    const pollies = buildAvatarDisplayCollections(library()).find(
      (collection) => collection.id === "pollies",
    );

    expect(pollies?.entries.map((entry) => entry.ref)).toEqual([
      "app-avatar:pollie-first",
      "app-avatar:pollie-cover",
    ]);
    expect(pollies?.cover?.ref).toBe("app-avatar:pollie-cover");
  });

  it("uses the newest custom gloopie as cover without collapsing ref namespaces", () => {
    const gloopies = buildAvatarDisplayCollections(
      library({
        userAvatarIds: ["shared-id"],
        userAvatarMediaById: {
          "shared-id": { src: "custom:shared-id", mediaType: "video" },
        },
      }),
    ).find((collection) => collection.id === "gloopies");

    expect(gloopies?.cover?.ref).toBe("user-avatar:shared-id");
    expect(gloopies?.entries.slice(0, 2).map((entry) => entry.ref)).toEqual([
      "user-avatar:shared-id",
      "app-avatar:shared-id",
    ]);
    expect(
      gloopies?.entries.slice(0, 2).map((entry) => entry.media?.src),
    ).toEqual(["custom:shared-id", "bundled:shared-id"]);
  });
});
