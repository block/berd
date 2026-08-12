import { describe, expect, it } from "vitest";
import { sniffAcceptedImageMimeType } from "../resizeImage";

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
