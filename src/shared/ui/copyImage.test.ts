import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyImage } from "./copyImage";

const mocks = vi.hoisted(() => ({ nativeWrite: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeImage: mocks.nativeWrite,
}));

describe("copyImage", () => {
  let png: Promise<Blob> | undefined;
  let decodeFails: boolean;
  let decodedImage: HTMLImageElement | undefined;
  const write = vi.fn();
  const drawImage = vi.fn();

  beforeEach(() => {
    png = undefined;
    decodeFails = false;
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public data: Record<string, Promise<Blob>>) {
          png = data["image/png"];
        }
      },
    );
    // The browser resolves the supplied image before completing the write.
    write.mockImplementation(
      async (items: { data: Record<string, Promise<Blob>> }[]) => {
        expect(items).toHaveLength(1);
        expect(Object.keys(items[0].data)).toEqual(["image/png"]);
        const blob = await items[0].data["image/png"];
        expect(blob.type).toBe("image/png");
      },
    );
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
        decodedImage = element as HTMLImageElement;
        Object.defineProperties(element, {
          naturalWidth: { value: 3024 },
          naturalHeight: { value: 1964 },
          src: {
            configurable: true,
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
      (callback, type) => callback(new Blob(["png"], { type })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(fetch).toHaveBeenCalledWith("asset://preview.jpg", {
      signal: expect.any(AbortSignal),
    });
    expect((await png)?.type).toBe("image/png");
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(decodedImage, 0, 0);
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/png",
    );
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
    await expect(copyImage("data:image/jpeg;base64,abc")).rejects.toThrow(
      "unavailable",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing ClipboardItem API without a native fallback", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    await expect(copyImage("data:image/jpeg;base64,abc")).rejects.toThrow(
      "unavailable",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.nativeWrite).not.toHaveBeenCalled();
  });

  it("propagates a clipboard permission rejection", async () => {
    write.mockRejectedValue(new Error("denied"));
    await expect(copyImage("data:image/jpeg;base64,abc")).rejects.toThrow(
      "denied",
    );
    await png?.catch(() => {});
    expect(mocks.nativeWrite).not.toHaveBeenCalled();
  });

  it("observes image errors even when clipboard permissions reject immediately", async () => {
    write.mockRejectedValue(new Error("denied"));
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    await expect(copyImage("data:image/jpeg;base64,abc")).rejects.toThrow(
      "denied",
    );
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
    await expect(copyImage("data:image/jpeg;base64,abc")).rejects.toThrow(
      "decode",
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("cleans up the blob when canvas rendering is unavailable", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    await expect(copyImage("data:image/jpeg;base64,abc")).rejects.toThrow(
      "unavailable",
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("reports failed PNG encoding", async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(
      (callback) => callback(null),
    );
    await expect(copyImage("data:image/jpeg;base64,abc")).rejects.toThrow(
      "encode",
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
  it("copies a displayed blob preview without fetching its CSP-blocked URL", async () => {
    const image = document.createElement("img");
    image.setAttribute("src", "blob:preview");
    Object.defineProperty(image, "complete", { value: true });
    vi.mocked(fetch).mockRejectedValue(new Error("CSP blocks blob fetch"));
    await copyImage("blob:preview", { image });
    expect(fetch).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0);
  });
  it.each([
    "headers",
    "body",
  ])("times out stalled %s and prevents a late image from reaching the clipboard", async (stage) => {
    vi.useFakeTimers();
    let finish: ((value: unknown) => void) | undefined;
    const waiting = new Promise((resolve) => {
      finish = resolve;
    });
    vi.mocked(fetch).mockImplementation((_src, options) => {
      expect(options?.signal).toBeDefined();
      return (
        stage === "headers"
          ? waiting
          : Promise.resolve({ ok: true, blob: () => waiting })
      ) as Promise<Response>;
    });
    const copying = copyImage("asset://slow.png");
    const failure = copying.catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await failure).message).toContain("timed out");
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(true);
    await expect(png).rejects.toThrow("timed out");
    finish?.(
      stage === "headers"
        ? {
            ok: true,
            blob: async () => new Blob(["late"], { type: "image/png" }),
          }
        : new Blob(["late"], { type: "image/png" }),
    );
    await Promise.resolve();
    expect(drawImage).not.toHaveBeenCalled();
  });
  it("aborts before image preparation can complete and cancels fetching", async () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const copying = copyImage("asset://slow.png", {
      signal: controller.signal,
    });
    const failure = copying.catch((error) => error);
    controller.abort();
    expect((await failure).name).toBe("AbortError");
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(png).rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out decoding and cleans up its temporary URL", async () => {
    vi.useFakeTimers();
    const element = document.createElement("img");
    Object.defineProperty(element, "src", {
      set: () => {},
      configurable: true,
    });
    vi.mocked(document.createElement).mockReturnValue(element);
    const copying = copyImage("asset://undecodable.jpg");
    const failure = copying.catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await failure).message).toContain("timed out");
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(element.onload).toBeNull();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("rejects the submitted PNG when encoding stalls, even if encoding finishes later", async () => {
    vi.useFakeTimers();
    let encode: BlobCallback | undefined;
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(
      (callback) => {
        encode = callback;
      },
    );
    const copying = copyImage("asset://encoding.jpg");
    const failure = copying.catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await failure).message).toContain("timed out");
    await expect(png).rejects.toThrow("timed out");
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    encode?.(new Blob(["late"], { type: "image/png" }));
    await expect(png).rejects.toThrow("timed out");
  });
});
