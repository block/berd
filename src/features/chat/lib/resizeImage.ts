const MAX_IMAGE_DIMENSION = 2048;
const JPEG_QUALITY = 0.85;

export interface NormalizedImage {
  base64: string;
  mimeType: string;
}

/** Bytes needed to distinguish the accepted image signatures (WEBP's
 * "WEBP" tag sits at offset 8-11). */
const SNIFF_BYTE_COUNT = 12;

/**
 * Identify an image payload by its magic bytes, returning one of the MIME
 * types the LLM providers accept for image content blocks (Anthropic's
 * whitelist, which is the strictest), or undefined for anything else.
 *
 * The claimed MIME type (file extension guess, clipboard flavor, File.type)
 * can lie — a real JPEG named photo.png would otherwise ship mislabeled and
 * fail provider-side data/media_type validation. The bytes are the source
 * of truth for the label we send (BOT-1463).
 */
export function sniffAcceptedImageMimeType(
  bytes: Uint8Array,
): string | undefined {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function splitDataUrl(dataUrl: string): NormalizedImage {
  const [header, base64] = dataUrl.split(",");
  const mimeType = header.replace("data:", "").replace(";base64", "");
  return { base64, mimeType };
}

function readBlobBase64(blob: Blob): Promise<NormalizedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(splitDataUrl(reader.result as string));
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(blob);
  });
}

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };
    img.src = url;
  });
}

function encodeWithCanvas(
  img: HTMLImageElement,
  sourceMimeType: string,
): NormalizedImage {
  const maxDim = Math.max(img.width, img.height);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / maxDim);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get canvas context");
  }
  ctx.drawImage(img, 0, 0, width, height);

  // PNG sources keep lossless encoding and transparency; everything else
  // (including HEIC/TIFF re-encodes) becomes JPEG. If the browser cannot
  // encode the requested type, toDataURL falls back to PNG — parsing the
  // header keeps the reported mimeType honest either way.
  const outputType =
    sourceMimeType === "image/png" ? "image/png" : "image/jpeg";
  const quality = outputType === "image/jpeg" ? JPEG_QUALITY : undefined;
  return splitDataUrl(canvas.toDataURL(outputType, quality));
}

/**
 * Normalize an image for sending as an ACP image content block. Every image
 * attachment entry point (paste, file picker, drag-and-drop) must pass
 * through here — there is deliberately no raw pass-through path.
 *
 * Payloads whose magic bytes identify an accepted format, at or under the
 * dimension cap, pass through unchanged (preserving GIF animation and
 * avoiding recompression) — labeled with the sniffed type, never the
 * claimed one. Everything else is decoded and re-encoded to PNG/JPEG,
 * downscaling to the dimension cap. Rejects when the blob cannot be
 * decoded as an image.
 */
export async function resizeImage(file: Blob): Promise<NormalizedImage> {
  const img = await loadImageElement(file);
  const maxDim = Math.max(img.width, img.height);

  const header = new Uint8Array(
    await file.slice(0, SNIFF_BYTE_COUNT).arrayBuffer(),
  );
  const sniffedMimeType = sniffAcceptedImageMimeType(header);
  if (sniffedMimeType && maxDim <= MAX_IMAGE_DIMENSION) {
    const { base64 } = await readBlobBase64(file);
    return { base64, mimeType: sniffedMimeType };
  }

  return encodeWithCanvas(img, file.type);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Normalize an image that arrived as base64 (e.g. read from disk by the
 * Tauri backend) through the same pipeline as browser `File` images.
 *
 * There is deliberately no size- or type-based shortcut here: the reported
 * MIME type for path attachments is guessed from the file extension, so the
 * decode inside `resizeImage` is the only proof the payload is a real,
 * renderable image. Rejects when the bytes cannot be decoded.
 */
export async function normalizeImageBase64(
  base64: string,
  mimeType: string | undefined,
): Promise<NormalizedImage> {
  return resizeImage(base64ToBlob(base64, mimeType ?? ""));
}
