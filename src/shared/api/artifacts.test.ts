import { describe, expect, it, vi } from "vitest";
import {
  selectAvatarImageUrl,
  selectCollectionImageUrl,
  type Artifact,
  type Artifacts,
} from "./artifacts";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(),
}));

function image(collectionId: string, id: string): Artifact {
  return {
    kind: "collectionImage",
    path: `/cache/images/${collectionId}/${id}.png`,
    collectionId,
    mimeType: "image/png",
    byteSize: 1,
    sha256: "a".repeat(64),
  };
}

const retired = image("pollies", "pollies-22");
const replacement = image("gloopies", "gloopies-14");
const survivor = image("pollies", "pollies-21");
const artifacts: Artifacts = {
  catalogVersion: "stale-offline-catalog",
  assets: [retired, replacement, survivor],
};

describe("avatar artifact retirement", () => {
  it("uses the replacement even when the retired image is still cached", () => {
    expect(selectAvatarImageUrl(artifacts, "pollies-22")).toBe(
      `asset://${replacement.path}`,
    );
    expect(selectCollectionImageUrl(artifacts, "pollies", "pollies-22")).toBe(
      `asset://${replacement.path}`,
    );
    expect(artifacts.assets).toContain(retired);
  });

  it("never falls back to retired bytes when the replacement is missing", () => {
    const oldCache = { ...artifacts, assets: [retired, survivor] };
    expect(selectAvatarImageUrl(oldCache, "pollies-22")).toBeUndefined();
    expect(
      selectCollectionImageUrl(oldCache, "pollies", "pollies-22"),
    ).toBeUndefined();
    expect(selectAvatarImageUrl(null, "pollies-22")).toBeUndefined();
  });

  it("preserves a same-named image in a different collection", () => {
    const unrelatedImage = image("fuzzies", "pollies-22");
    expect(
      selectCollectionImageUrl(
        { ...artifacts, assets: [...artifacts.assets, unrelatedImage] },
        "fuzzies",
        "pollies-22",
      ),
    ).toBe(`asset://${unrelatedImage.path}`);
  });

  it("leaves unaffected avatars and collection scoping unchanged", () => {
    expect(selectAvatarImageUrl(artifacts, "pollies-21")).toBe(
      `asset://${survivor.path}`,
    );
    expect(selectCollectionImageUrl(artifacts, "pollies", "pollies-21")).toBe(
      `asset://${survivor.path}`,
    );
    expect(
      selectCollectionImageUrl(artifacts, "gloopies", "pollies-21"),
    ).toBeUndefined();
  });
});
