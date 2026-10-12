import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyImage } from "./copyImage";

const mocks = vi.hoisted(() => ({ nativeWrite: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeImage: mocks.nativeWrite,
}));

describe("copyImage", () => {
  let png: Promise<Blob> | undefined;
  let decodeFails: boolean;
  const write = vi.fn();
  const drawImage = vi.fn();

  beforeEach(() => {
    png = undefined;
    decodeFails = false;
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(data: Record<string, Promise<Blob>>) {
          png = data["image/png"];
        }
      },
    );
    // The browser resolves the supplied image before completing the write.
    write.mockImplementation(async () => {
      await png;
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, blob: async () => new Blob(["image"]) }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:decoded-image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = createElement(tag);
      if (tag === "img") {
        Object.defineProperties(element, {
          naturalWidth: { value: 3024 },
          naturalHeight: { value: 1964 },
          src: {
            set: () =>
              queueMicrotask(() =>
                element.dispatchEvent(
                  new Event(decodeFails ? "error" : "load"),
                ),
              ),
          },
        });
      }
      return element;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["png"], { type: "image/png" })),
    );
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("starts the browser write immediately and supplies full-resolution PNG asynchronously", async () => {
    const copying = copyImage("asset://preview.jpg");
    expect(write).toHaveBeenCalledOnce();
    expect(drawImage).not.toHaveBeenCalled();
    await copying;
    expect(fetch).toHaveBeenCalledWith("asset://preview.jpg");
    expect((await png)?.type).toBe("image/png");
    expect(drawImage).toHaveBeenCalledOnce();
    expect(
      vi.mocked(HTMLCanvasElement.prototype.toBlob).mock.instances[0],
    ).toMatchObject({ width: 3024, height: 1964 });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:decoded-image");
  });

  it("copies PNG bytes directly without canvas conversion", async () => {
    const original = new Blob(["png"], { type: "image/png" });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      blob: async () => original,
    } as Response);
    await copyImage("asset://retina-screenshot.png");
    expect(await png).toBe(original);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("uses the same browser API inside Berd without native clipboard writes", async () => {
    window.__TAURI_INTERNALS__ = {};
    await copyImage("data:image/png;base64,abc");
    expect(write).toHaveBeenCalledOnce();
    expect(mocks.nativeWrite).not.toHaveBeenCalled();
  });

  it("reports unavailable clipboard support before fetching the image", async () => {
    vi.stubGlobal("navigator", {});
    await expect(copyImage("blob:preview")).rejects.toThrow("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing ClipboardItem API without a native fallback", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    await expect(copyImage("blob:preview")).rejects.toThrow("unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.nativeWrite).not.toHaveBeenCalled();
  });

  it("propagates a clipboard permission rejection", async () => {
    write.mockRejectedValue(new Error("denied"));
    await expect(copyImage("blob:preview")).rejects.toThrow("denied");
    await png;
    expect(mocks.nativeWrite).not.toHaveBeenCalled();
  });

  it("observes image errors even when clipboard permissions reject immediately", async () => {
    write.mockRejectedValue(new Error("denied"));
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    await expect(copyImage("blob:preview")).rejects.toThrow("denied");
    await expect(png).rejects.toThrow("offline");
  });

  it("reports fetch failures without attempting image decode", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403 } as Response);
    await expect(copyImage("https://example.com/image.png")).rejects.toThrow(
      "403",
    );
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("cleans up the blob when decoding fails", async () => {
    decodeFails = true;
    await expect(copyImage("blob:preview")).rejects.toThrow("decode");
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("cleans up the blob when canvas rendering is unavailable", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    await expect(copyImage("blob:preview")).rejects.toThrow("unavailable");
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("reports failed PNG encoding", async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(
      (callback) => callback(null),
    );
    await expect(copyImage("blob:preview")).rejects.toThrow("encode");
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
});
