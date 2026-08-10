import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, scheme?: string) =>
    `asset://localhost/${scheme ?? "asset"}${path}`,
}));

import { resolveImageContentSrc } from "../resolveImageContentSrc";

describe("resolveImageContentSrc", () => {
  it("prefers inline base64 data over a file:// uri", () => {
    const src = resolveImageContentSrc({
      data: "AAAA",
      mimeType: "image/png",
      uri: "file:///tmp/generated.png",
    });
    expect(src).toBe("data:image/png;base64,AAAA");
  });

  it("falls back to image/png when mimeType is missing", () => {
    const src = resolveImageContentSrc({ data: "AAAA" });
    expect(src).toBe("data:image/png;base64,AAAA");
  });

  it("routes a local file:// uri through the asset scheme when no data", () => {
    const src = resolveImageContentSrc({
      data: "",
      uri: "file:///tmp/with%20space.png",
    });
    expect(src).toBe("asset://localhost/asset/tmp/with space.png");
  });

  it.each([
    ["file:generated.png"],
    ["file:./generated.png"],
    ["file:///tmp/bad%ZZ.png"],
    ["file:///tmp/report.png?download=1"],
    ["file:///tmp/report.png#preview"],
    ["file://user@server/share/report.png"],
  ])("rejects an unsafe file uri %s", (uri) => {
    expect(resolveImageContentSrc({ data: "", uri })).toBeNull();
  });

  it("passes through a remote uri verbatim when no data", () => {
    const src = resolveImageContentSrc({
      data: "",
      uri: "https://example.com/a.png",
    });
    expect(src).toBe("https://example.com/a.png");
  });

  it("returns null when there is nothing renderable", () => {
    expect(resolveImageContentSrc({ data: "", uri: "" })).toBeNull();
    expect(resolveImageContentSrc({})).toBeNull();
  });
});
