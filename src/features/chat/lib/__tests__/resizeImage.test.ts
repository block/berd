import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dimensionsForProviderHistory,
  resizeImage,
  sniffAcceptedImageMimeType,
} from "../resizeImage";

const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_HEADER = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
// RIFF....WEBP
const WEBP_HEADER = [
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
];
// HEIC: ....ftypheic
const HEIC_HEADER = [
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
];
// TIFF little-endian: II*.
const TIFF_HEADER = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00];

function bytes(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("dimensionsForProviderHistory", () => {
  it("keeps images at the many-image request limit unchanged", () => {
    expect(dimensionsForProviderHistory(2_000, 1_500)).toEqual({
      width: 2_000,
      height: 1_500,
    });
  });

  it("scales a 2048px screenshot below the many-image request limit", () => {
    expect(dimensionsForProviderHistory(2_048, 1_338)).toEqual({
      width: 2_000,
      height: 1_307,
    });
    expect(dimensionsForProviderHistory(1_731, 2_048)).toEqual({
      width: 1_690,
      height: 2_000,
    });
  });
});

describe("resizeImage", () => {
  const originalImage = globalThis.Image;
  const originalCreateElement = document.createElement.bind(document);
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  let sourceWidth = 0;
  let sourceHeight = 0;
  let canvas: HTMLCanvasElement;
  let drawImage: ReturnType<typeof vi.fn>;
  let toDataURL: ReturnType<typeof vi.fn>;

  function imageBlob(): Blob {
    const source = bytes(PNG_HEADER);
    const blob = new Blob([source], { type: "image/png" });
    Object.defineProperty(blob, "arrayBuffer", {
      value: async () => source.buffer,
    });
    const originalSlice = blob.slice.bind(blob);
    Object.defineProperty(blob, "slice", {
      value: (...args: Parameters<Blob["slice"]>) => {
        const slice = originalSlice(...args);
        Object.defineProperty(slice, "arrayBuffer", {
          value: async () => source.slice(args[0] ?? 0, args[1]).buffer,
        });
        return slice;
      },
    });
    return blob;
  }

  beforeEach(() => {
    class MockImage {
      width = sourceWidth;
      height = sourceHeight;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.width = sourceWidth;
        this.height = sourceHeight;
        queueMicrotask(() => this.onload?.());
      }
    }

    drawImage = vi.fn();
    toDataURL = vi.fn(() => "data:image/png;base64,cmVzaXplZA==");
    canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toDataURL,
    } as unknown as HTMLCanvasElement;

    globalThis.Image = MockImage as unknown as typeof Image;
    URL.createObjectURL = vi.fn(() => "blob:test-image");
    URL.revokeObjectURL = vi.fn();
    document.createElement = vi.fn(((tagName: string) =>
      tagName === "canvas"
        ? canvas
        : originalCreateElement(tagName)) as typeof document.createElement);
  });

  afterEach(() => {
    globalThis.Image = originalImage;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    document.createElement = originalCreateElement;
  });

  it("re-encodes a 2048px screenshot at the many-image request limit", async () => {
    sourceWidth = 2_048;
    sourceHeight = 1_338;

    const normalized = await resizeImage(imageBlob());

    expect(canvas.width).toBe(2_000);
    expect(canvas.height).toBe(1_307);
    expect(drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ width: 2_048, height: 1_338 }),
      0,
      0,
      2_000,
      1_307,
    );
    expect(toDataURL).toHaveBeenCalledWith("image/png", undefined);
    expect(normalized).toEqual({
      base64: "cmVzaXplZA==",
      mimeType: "image/png",
    });
  });

  it("passes through a 2000px image without canvas encoding", async () => {
    sourceWidth = 2_000;
    sourceHeight = 1_500;
    const source = bytes(PNG_HEADER);

    const normalized = await resizeImage(imageBlob());

    expect(document.createElement).not.toHaveBeenCalledWith("canvas");
    expect(toDataURL).not.toHaveBeenCalled();
    expect(normalized.mimeType).toBe("image/png");
    expect(atob(normalized.base64)).toBe(String.fromCharCode(...source));
  });
});

describe("sniffAcceptedImageMimeType", () => {
  it("identifies the four accepted formats from magic bytes", () => {
    expect(sniffAcceptedImageMimeType(bytes(JPEG_HEADER))).toBe("image/jpeg");
    expect(sniffAcceptedImageMimeType(bytes(PNG_HEADER))).toBe("image/png");
    expect(sniffAcceptedImageMimeType(bytes(GIF_HEADER))).toBe("image/gif");
    expect(sniffAcceptedImageMimeType(bytes(WEBP_HEADER))).toBe("image/webp");
  });

  it("returns undefined for non-accepted formats regardless of claimed type", () => {
    // The claimed MIME type never enters the sniff, so a HEIC or TIFF
    // payload can never pass through mislabeled as an accepted format.
    expect(sniffAcceptedImageMimeType(bytes(HEIC_HEADER))).toBeUndefined();
    expect(sniffAcceptedImageMimeType(bytes(TIFF_HEADER))).toBeUndefined();
  });

  it("returns undefined for truncated or empty payloads", () => {
    expect(sniffAcceptedImageMimeType(bytes([]))).toBeUndefined();
    expect(sniffAcceptedImageMimeType(bytes([0xff, 0xd8]))).toBeUndefined();
    // RIFF prefix without the WEBP tag (could be a .wav or .avi)
    expect(
      sniffAcceptedImageMimeType(bytes([0x52, 0x49, 0x46, 0x46])),
    ).toBeUndefined();
  });

  it("is the discriminator for wrong-extension files: JPEG bytes always sniff as JPEG", () => {
    // A real JPEG renamed photo.png claims image/png via extension guessing
    // or File.type. The sniffer sees only bytes, so the pass-through label
    // is image/jpeg — the pre-fix code shipped the claimed image/png label,
    // which providers reject on data/media_type validation.
    expect(sniffAcceptedImageMimeType(bytes(JPEG_HEADER))).toBe("image/jpeg");
    expect(sniffAcceptedImageMimeType(bytes(JPEG_HEADER))).not.toBe(
      "image/png",
    );
  });
});
