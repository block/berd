import { describe, expect, it } from "vitest";
import {
  avatarRef,
  isAppAvatarRef,
  parseAvatarCatalog,
  parseAvatarRef,
} from "./catalog";

const validCatalog = {
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
        poster: {
          path: "poster/gloopies/gloopy-1.png",
          mimeType: "image/png",
          byteSize: 50,
          sha256: "c".repeat(64),
        },
      },
    },
  ],
};

describe("avatar catalog", () => {
  it("parses a schema v1 remote catalog", () => {
    expect(parseAvatarCatalog(validCatalog)).toMatchObject({
      schemaVersion: 1,
      catalogVersion: "v1",
      collections: [{ id: "gloopies" }],
      assets: [{ id: "gloopy-1" }],
    });
  });

  it("overrides the pollies display label to Figgies", () => {
    // The published catalog still says "Pollies"; the rename is applied at
    // the parse boundary so every surface shows the new name without waiting
    // on a catalog republish. The id must stay `pollies` so existing
    // `app-avatar:pollies-*` refs keep resolving.
    const catalog = JSON.parse(JSON.stringify(validCatalog));
    catalog.collections[0] = {
      ...catalog.collections[0],
      id: "pollies",
      label: "Pollies",
    };
    catalog.assets[0] = { ...catalog.assets[0], collectionId: "pollies" };

    expect(parseAvatarCatalog(catalog)).toMatchObject({
      collections: [{ id: "pollies", label: "Figgies" }],
    });
  });

  it("rejects unsupported schemas and unsafe paths", () => {
    expect(() =>
      parseAvatarCatalog({ ...validCatalog, schemaVersion: 2 }),
    ).toThrow(/schema/);
    expect(() =>
      parseAvatarCatalog({
        ...validCatalog,
        assets: [
          {
            ...validCatalog.assets[0],
            variants: {
              webm: {
                ...validCatalog.assets[0].variants.webm,
                path: "../gloopy-1.webm",
              },
            },
          },
        ],
      }),
    ).toThrow(/contents/);
  });

  it("keeps compatibility with catalogs that predate poster variants", () => {
    const variants = { ...validCatalog.assets[0].variants };
    delete (variants as Partial<typeof variants>).poster;

    expect(
      parseAvatarCatalog({
        ...validCatalog,
        assets: [{ ...validCatalog.assets[0], variants }],
      }).assets[0].variants.poster,
    ).toBeUndefined();
  });

  it("rejects an invalid optional poster consistently with backend validation", () => {
    expect(() =>
      parseAvatarCatalog({
        ...validCatalog,
        assets: [
          {
            ...validCatalog.assets[0],
            variants: {
              ...validCatalog.assets[0].variants,
              poster: {
                ...validCatalog.assets[0].variants.poster,
                path: "../gloopy-1.png",
              },
            },
          },
        ],
      }),
    ).toThrow(/contents/);
  });

  it("rejects catalogs missing either platform variant", () => {
    expect(() =>
      parseAvatarCatalog({
        ...validCatalog,
        assets: [
          {
            ...validCatalog.assets[0],
            variants: {
              webm: validCatalog.assets[0].variants.webm,
            },
          },
        ],
      }),
    ).toThrow(/contents/);

    expect(() =>
      parseAvatarCatalog({
        ...validCatalog,
        assets: [
          {
            ...validCatalog.assets[0],
            variants: {
              hevc: validCatalog.assets[0].variants.hevc,
            },
          },
        ],
      }),
    ).toThrow(/contents/);
  });

  it("rejects catalogs with invalid collection references", () => {
    expect(() =>
      parseAvatarCatalog({
        ...validCatalog,
        collections: [
          {
            ...validCatalog.collections[0],
            avatarIds: ["missing-avatar"],
          },
        ],
      }),
    ).toThrow(/contents/);
  });

  it("normalizes app-avatar references by syntax", () => {
    expect(avatarRef("gloopy-99")).toBe("app-avatar:gloopy-99");
    expect(parseAvatarRef(" app-avatar:gloopy-99 ")).toBe("gloopy-99");
    expect(isAppAvatarRef("app-avatar:unknown-but-safe")).toBe(true);
    expect(parseAvatarRef("app-avatar:../gloopy-1")).toBeUndefined();
  });
});
