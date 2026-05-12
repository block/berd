import { describe, expect, it } from "vitest";
import { isRemoteAvatarUrl, normalizeAvatarUrl } from "./avatarUrl";

describe("avatarUrl", () => {
  it("accepts http and https avatar URLs", () => {
    expect(isRemoteAvatarUrl("https://example.test/avatar.png")).toBe(true);
    expect(normalizeAvatarUrl(" http://example.test/avatar.png ")).toBe(
      "http://example.test/avatar.png",
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
});
