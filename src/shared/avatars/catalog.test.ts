import { afterEach, describe, expect, it, vi } from "vitest";

const catalogAssetsModule = "@/shared/avatars/catalog-assets";

const webmModules = {
  "../assets/avatars/webm/fuzzies/fuzzy-1.webm": "/assets/fuzzy-1.webm",
  "../assets/avatars/webm/gloopies/gloopy-1.webm": "/assets/gloopy-1.webm",
};

const hevcModules = {
  "../assets/avatars/hevc/fuzzies/fuzzy-1.mov": "/assets/fuzzy-1.mov",
  "../assets/avatars/hevc/gloopies/gloopy-1.mov": "/assets/gloopy-1.mov",
};

const hevcMp4Modules = {
  "../assets/avatars/hevc/fuzzies/fuzzy-1.mp4": "/assets/fuzzy-1.mp4",
  "../assets/avatars/hevc/gloopies/gloopy-1.mp4": "/assets/gloopy-1.mp4",
};

type AvatarFormat = "webm" | "hevc";

async function loadCatalog(
  format: AvatarFormat,
  modules: Record<string, string>,
) {
  vi.resetModules();
  vi.doMock(catalogAssetsModule, () => ({
    avatarAssetFormat: format,
    avatarModules: modules,
  }));

  return import("./catalog");
}

afterEach(() => {
  vi.doUnmock(catalogAssetsModule);
  vi.resetModules();
});

describe("avatar catalog", () => {
  it("builds matching avatar ids for WebM and HEVC modules", async () => {
    const webmCatalog = await loadCatalog("webm", webmModules);
    const webmIds = webmCatalog.avatarCatalog.map((entry) => entry.id);

    const hevcCatalog = await loadCatalog("hevc", hevcModules);
    const hevcIds = hevcCatalog.avatarCatalog.map((entry) => entry.id);

    expect(webmIds).toEqual(hevcIds);
  });

  it("resolves bundled avatar refs to WebM when the WebM module is selected", async () => {
    const catalog = await loadCatalog("webm", webmModules);

    expect(catalog.avatarCatalogFormat).toBe("webm");
    expect(catalog.resolveBundledAvatarMedia("app-avatar:gloopy-1")).toEqual({
      src: "/assets/gloopy-1.webm",
      mediaType: "video",
    });
  });

  it("resolves bundled avatar refs to MOV when the HEVC module is selected", async () => {
    const catalog = await loadCatalog("hevc", hevcModules);

    expect(catalog.avatarCatalogFormat).toBe("hevc");
    expect(catalog.resolveBundledAvatarMedia("app-avatar:gloopy-1")).toEqual({
      src: "/assets/gloopy-1.mov",
      mediaType: "video",
    });
  });

  it("resolves bundled avatar refs to MP4 when HEVC MP4 assets are selected", async () => {
    const catalog = await loadCatalog("hevc", hevcMp4Modules);

    expect(catalog.avatarCatalogFormat).toBe("hevc");
    expect(catalog.resolveBundledAvatarMedia("app-avatar:gloopy-1")).toEqual({
      src: "/assets/gloopy-1.mp4",
      mediaType: "video",
    });
  });
});
