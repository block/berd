import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadImage, extensionFromMime } from "./downloadImage";

describe("extensionFromMime", () => {
  it("returns the subtype for common image types", () => {
    expect(extensionFromMime("image/png")).toBe("png");
    expect(extensionFromMime("image/webp")).toBe("webp");
    expect(extensionFromMime("image/gif")).toBe("gif");
  });

  it("normalizes jpeg to jpg", () => {
    expect(extensionFromMime("image/jpeg")).toBe("jpg");
  });

  it("normalizes svg+xml to svg", () => {
    expect(extensionFromMime("image/svg+xml")).toBe("svg");
  });

  it("ignores parameters after the subtype", () => {
    expect(extensionFromMime("image/png; charset=binary")).toBe("png");
  });

  it("defaults to png when the mime is empty or malformed", () => {
    expect(extensionFromMime("")).toBe("png");
    expect(extensionFromMime("application")).toBe("png");
  });
});

describe("downloadImage", () => {
  let anchor: HTMLAnchorElement;
  let clickSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:object-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    clickSpy = vi.fn();
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === "a") {
        anchor = el as HTMLAnchorElement;
        anchor.click = clickSpy as unknown as HTMLAnchorElement["click"];
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(mime: string) {
    const blob = new Blob(["fake-bytes"], { type: mime });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) }),
    );
    return blob;
  }

  it("fetches the src, triggers an anchor download, and revokes the url", async () => {
    mockFetch("image/png");

    const filename = await downloadImage(
      "data:image/png;base64,AAAA",
      "diagram",
    );

    expect(fetch).toHaveBeenCalledWith("data:image/png;base64,AAAA");
    expect(anchor.href).toContain("blob:object-url");
    expect(anchor.download).toBe("diagram.png");
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:object-url");
    expect(filename).toBe("diagram.png");
  });

  it("derives the extension from the blob mime type", async () => {
    mockFetch("image/jpeg");

    const filename = await downloadImage("http://example.com/pic", "photo");

    expect(filename).toBe("photo.jpg");
    expect(anchor.download).toBe("photo.jpg");
  });

  it("falls back to a timestamped name when no hint is given", async () => {
    mockFetch("image/webp");
    vi.spyOn(Date, "now").mockReturnValue(1234);

    const filename = await downloadImage("blob:local");

    expect(filename).toBe("image-1234.webp");
  });

  it("strips an existing extension from the hint and uses the blob type", async () => {
    mockFetch("image/png");

    const filename = await downloadImage(
      "asset://local/thing.jpeg",
      "thing.jpeg",
    );

    expect(filename).toBe("thing.png");
  });

  it("sanitizes unsafe characters in the hint", async () => {
    mockFetch("image/png");

    const filename = await downloadImage(
      "data:image/png;base64,AAAA",
      "a/b:c*d",
    );

    expect(filename).toBe("a-b-c-d.png");
  });

  it("rejects and does not download when the response is not ok", async () => {
    const blobFn = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, blob: blobFn }),
    );

    await expect(
      downloadImage("http://example.com/missing.png"),
    ).rejects.toThrow(/404/);
    expect(blobFn).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
