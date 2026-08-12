import { describe, expect, it } from "vitest";
import {
  isRemoteAvatarUrl,
  isSafePngAvatarDataUrl,
  isSupportedAvatarUrl,
  normalizeAvatarRef,
  normalizeAvatarUrl,
  resolveAvatarMedia,
  resolveAvatarSrc,
} from "./avatarUrl";

describe("avatarUrl", () => {
  it("accepts http and https avatar URLs", () => {
    expect(isRemoteAvatarUrl("https://example.test/avatar.png")).toBe(true);
    expect(normalizeAvatarUrl(" http://example.test/avatar.png ")).toBe(
      "http://example.test/avatar.png",
    );
  });

  it("accepts known bundled avatar refs", () => {
    expect(isSupportedAvatarUrl("app-avatar:gloopy-1")).toBe(true);
    expect(normalizeAvatarUrl(" app-avatar:gloopy-1 ")).toBe(
      "app-avatar:gloopy-1",
    );
    expect(normalizeAvatarRef("app-avatar:gloopy-2")).toBe(
      "app-avatar:gloopy-2",
    );
    expect(resolveAvatarSrc("app-avatar:gloopy-1")).toBeUndefined();
    expect(resolveAvatarMedia("app-avatar:gloopy-1")).toBeUndefined();
  });

  it("accepts unknown but safe app avatar refs", () => {
    expect(normalizeAvatarUrl("app-avatar:unknown")).toBe("app-avatar:unknown");
    expect(resolveAvatarSrc("app-avatar:../gloopy-1")).toBeUndefined();
  });

  it("accepts generated user avatar refs", () => {
    expect(isSupportedAvatarUrl("user-avatar:gloopie-1")).toBe(true);
    expect(normalizeAvatarUrl(" user-avatar:gloopie-1 ")).toBe(
      "user-avatar:gloopie-1",
    );
    expect(resolveAvatarSrc("user-avatar:gloopie-1")).toBeUndefined();
    expect(resolveAvatarMedia("user-avatar:gloopie-1")).toBeUndefined();
    expect(normalizeAvatarUrl("user-avatar:../secret")).toBeUndefined();
  });

  it("accepts only bounded, structurally valid PNG data URLs", () => {
    const value =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
    expect(isSafePngAvatarDataUrl(value)).toBe(true);
    expect(normalizeAvatarUrl(value)).toBe(value);
    expect(resolveAvatarSrc(value)).toBe(value);
    expect(isSafePngAvatarDataUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(
      false,
    );
    expect(isSafePngAvatarDataUrl("data:image/png;base64,aWNvbg==")).toBe(
      false,
    );
    expect(isSafePngAvatarDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(
      false,
    );
  });

  it("rejects unsafe avatar URL schemes and credentials", () => {
    expect(normalizeAvatarUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeAvatarUrl("file:///tmp/avatar.png")).toBeUndefined();
    expect(
      normalizeAvatarUrl("data:image/png;base64,aWNvbg=="),
    ).toBeUndefined();
    expect(normalizeAvatarUrl("https://")).toBeUndefined();
    expect(
      normalizeAvatarUrl("https://user:pass@example.test/avatar.png"),
    ).toBeUndefined();
  });

  it("rejects local paths and traversal-like strings", () => {
    expect(normalizeAvatarUrl("/tmp/avatar.png")).toBeUndefined();
    expect(normalizeAvatarUrl("C:\\tmp\\avatar.png")).toBeUndefined();
    expect(normalizeAvatarUrl("../avatar.png")).toBeUndefined();
    expect(
      normalizeAvatarUrl("https://example.test/../avatar.png"),
    ).toBeUndefined();
    expect(
      normalizeAvatarUrl("https://example.test/%2e%2e/avatar.png"),
    ).toBeUndefined();
    expect(normalizeAvatarUrl("gloopy-1.png")).toBeUndefined();
  });
});
