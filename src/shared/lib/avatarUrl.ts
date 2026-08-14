import { isAppAvatarRef, isUserAvatarRef } from "@/shared/avatars/catalog";
import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";

export const MAX_PNG_AVATAR_BYTES = 2 * 1024 * 1024;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const PNG_IHDR_LENGTH = 13;
const MAX_PNG_AVATAR_DIMENSION = 8_192;
const MAX_PNG_AVATAR_PIXELS = 16_777_216;

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isStructurallyValidPng(bytes: Uint8Array): boolean {
  if (
    bytes.length < 45 ||
    !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) {
    return false;
  }

  let offset: number = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let sawIhdr = false;
  let sawIdat = false;

  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) return false;

    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    if (
      readUint32(bytes, dataEnd) !== crc32(bytes.subarray(offset + 4, dataEnd))
    ) {
      return false;
    }

    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== PNG_IHDR_LENGTH) return false;
      const width = readUint32(bytes, dataStart);
      const height = readUint32(bytes, dataStart + 4);
      if (
        width === 0 ||
        height === 0 ||
        width > MAX_PNG_AVATAR_DIMENSION ||
        height > MAX_PNG_AVATAR_DIMENSION ||
        width * height > MAX_PNG_AVATAR_PIXELS
      ) {
        return false;
      }
      sawIhdr = true;
    } else if (type === "IHDR") {
      return false;
    }

    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      return length === 0 && sawIhdr && sawIdat && chunkEnd === bytes.length;
    }

    offset = chunkEnd;
    chunkIndex += 1;
  }

  return false;
}

export function isSafePngAvatarDataUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(PNG_DATA_URL_PREFIX)) return false;
  const encoded = trimmed.slice(PNG_DATA_URL_PREFIX.length);
  if (!encoded || encoded.length > Math.ceil(MAX_PNG_AVATAR_BYTES / 3) * 4) {
    return false;
  }
  try {
    const decoded = atob(encoded);
    if (decoded.length > MAX_PNG_AVATAR_BYTES) return false;
    const bytes = Uint8Array.from(decoded, (character) =>
      character.charCodeAt(0),
    );
    return isStructurallyValidPng(bytes);
  } catch {
    return false;
  }
}

function decodePathLikeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasTraversalSegment(value: string): boolean {
  return decodePathLikeValue(value)
    .split(/[\\/]/)
    .some((segment) => segment === "..");
}

export function isRemoteAvatarUrl(value: string): boolean {
  const trimmed = value.trim();

  // Guard non-URL path-like inputs before URL parsing normalizes them.
  if (hasTraversalSegment(trimmed)) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      !hasTraversalSegment(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isSupportedAvatarRef(value: string): boolean {
  return (
    isRemoteAvatarUrl(value) ||
    isAppAvatarRef(value) ||
    isUserAvatarRef(value) ||
    isSafePngAvatarDataUrl(value)
  );
}

export function normalizeAvatarRef(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return isSupportedAvatarRef(trimmed) ? trimmed : undefined;
}

export function resolveAvatarSrc(value: unknown): string | undefined {
  const normalized = normalizeAvatarRef(value);
  if (!normalized) {
    return undefined;
  }

  return isAppAvatarRef(normalized) || isUserAvatarRef(normalized)
    ? undefined
    : normalized;
}

export function resolveAvatarMedia(
  value: unknown,
): ResolvedAvatarMedia | undefined {
  const normalized = normalizeAvatarRef(value);
  if (!normalized) {
    return undefined;
  }

  return isAppAvatarRef(normalized) || isUserAvatarRef(normalized)
    ? undefined
    : {
        src: normalized,
        mediaType: "image",
      };
}

export const isSupportedAvatarUrl = isSupportedAvatarRef;
export const normalizeAvatarUrl = normalizeAvatarRef;
