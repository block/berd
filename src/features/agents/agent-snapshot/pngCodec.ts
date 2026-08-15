import {
  AgentSnapshotError,
  MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES,
  MAX_SNAPSHOT_IMAGE_DIMENSION,
  MAX_SNAPSHOT_IMAGE_PIXELS,
  MAX_SNAPSHOT_PNG_BYTES,
  MAX_SNAPSHOT_PNG_CHUNKS,
  SNAPSHOT_PNG_KEYWORD,
  type SnapshotV1,
  validateSnapshotV1,
} from "./schema";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const AVATAR_ANIMATION_CHUNK = "bdAV";

export interface EmbeddedAvatarAnimation {
  bytes: Uint8Array;
  mimeType: "video/webm" | "video/mp4";
  alphaMode?: "stacked";
}
const textEncoder = new TextEncoder();
const asciiDecoder = new TextDecoder("ascii");

interface Chunk {
  start: number;
  end: number;
  type: string;
  data: Uint8Array;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    offset,
    value,
  );
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function getPngDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  const chunks = parseChunks(bytes);
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== "IHDR") {
    throw new AgentSnapshotError("PNG must begin with IHDR", "invalid-png");
  }
  return {
    width: readU32(ihdr.data, 0),
    height: readU32(ihdr.data, 4),
  };
}

function parseChunks(bytes: Uint8Array): Chunk[] {
  if (bytes.length > MAX_SNAPSHOT_PNG_BYTES) {
    throw new AgentSnapshotError(
      "Agent image exceeds the 10 MiB limit",
      "too-large",
    );
  }
  if (
    bytes.length < PNG_SIGNATURE.length ||
    !PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)
  ) {
    throw new AgentSnapshotError("Invalid PNG signature", "invalid-png");
  }

  const chunks: Chunk[] = [];
  let offset = PNG_SIGNATURE.length;
  let sawIend = false;
  while (offset < bytes.length) {
    if (chunks.length >= MAX_SNAPSHOT_PNG_CHUNKS) {
      throw new AgentSnapshotError(
        "PNG contains too many chunks",
        "invalid-png",
      );
    }
    if (bytes.length - offset < 12) {
      throw new AgentSnapshotError("Truncated PNG chunk", "invalid-png");
    }
    const length = readU32(bytes, offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) {
      throw new AgentSnapshotError(
        "PNG chunk exceeds file bounds",
        "invalid-png",
      );
    }
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (
      !typeBytes.every(
        (byte) => byte >= 65 && byte <= 122 && (byte < 91 || byte > 96),
      )
    ) {
      throw new AgentSnapshotError(
        "PNG contains an invalid chunk type",
        "invalid-png",
      );
    }
    const type = String.fromCharCode(...typeBytes);
    const expectedCrc = readU32(bytes, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== expectedCrc) {
      throw new AgentSnapshotError(
        `Invalid CRC for PNG ${type} chunk`,
        "invalid-png",
      );
    }
    if (chunks.length === 0 && type !== "IHDR") {
      throw new AgentSnapshotError("PNG must begin with IHDR", "invalid-png");
    }
    if (type === "IHDR" && (chunks.length !== 0 || length !== 13)) {
      throw new AgentSnapshotError(
        "PNG contains an invalid IHDR",
        "invalid-png",
      );
    }
    if (type === "IHDR") {
      const dataOffset = offset + 8;
      const width = readU32(bytes, dataOffset);
      const height = readU32(bytes, dataOffset + 4);
      if (
        width === 0 ||
        height === 0 ||
        width > MAX_SNAPSHOT_IMAGE_DIMENSION ||
        height > MAX_SNAPSHOT_IMAGE_DIMENSION ||
        width > Math.floor(MAX_SNAPSHOT_IMAGE_PIXELS / height)
      ) {
        throw new AgentSnapshotError(
          "PNG dimensions exceed the safe preview limit",
          "invalid-png",
        );
      }
    }
    if (type === "IEND" && length !== 0) {
      throw new AgentSnapshotError(
        "PNG contains an invalid IEND",
        "invalid-png",
      );
    }
    if (sawIend)
      throw new AgentSnapshotError(
        "PNG contains data after IEND",
        "invalid-png",
      );
    chunks.push({
      start: offset,
      end,
      type,
      data: bytes.subarray(offset + 8, end - 4),
    });
    sawIend = type === "IEND";
    offset = end;
  }
  if (!sawIend)
    throw new AgentSnapshotError("PNG is missing IEND", "invalid-png");
  return chunks;
}

function snapshotText(chunk: Chunk): string | undefined {
  if (chunk.type !== "tEXt") return undefined;
  const separator = chunk.data.indexOf(0);
  if (separator <= 0 || separator > 79) return undefined;
  const keyword = asciiDecoder.decode(chunk.data.subarray(0, separator));
  if (keyword !== SNAPSHOT_PNG_KEYWORD) return undefined;
  // Decode the manifest in one native pass. Appending multi-megabyte metadata
  // byte-by-byte repeatedly copies the growing JS string and can consume GBs.
  return asciiDecoder.decode(chunk.data.subarray(separator + 1));
}

function isBase64Character(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  );
}

function hasValidBase64Shape(input: string): boolean {
  if (!input || input.length % 4 !== 0) return false;
  const firstPadding = input.indexOf("=");
  const contentEnd = firstPadding === -1 ? input.length : firstPadding;
  const paddingLength = input.length - contentEnd;
  if (paddingLength > 2) return false;
  for (let index = 0; index < contentEnd; index += 1) {
    if (!isBase64Character(input.charCodeAt(index))) return false;
  }
  for (let index = contentEnd; index < input.length; index += 1) {
    if (input.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function decodeBase64(value: string): Uint8Array {
  const input = value.trim();
  // Validate in a linear scan. A single regex over multi-megabyte snapshots
  // can exceed the JS regex engine's limits and reject valid embedded videos.
  if (!hasValidBase64Shape(input)) {
    throw new AgentSnapshotError(
      "Snapshot chunk contains invalid base64",
      "invalid-base64",
    );
  }
  try {
    const binary = atob(input);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new AgentSnapshotError(
      "Snapshot chunk contains invalid base64",
      "invalid-base64",
    );
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  writeU32(chunk, 0, data.length);
  chunk.set(textEncoder.encode(type), 4);
  chunk.set(data, 8);
  writeU32(chunk, chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
  return chunk;
}

function makeTextChunk(text: string): Uint8Array {
  const data = textEncoder.encode(`${SNAPSHOT_PNG_KEYWORD}\0${text}`);
  return makeChunk("tEXt", data);
}

/** Decodes and validates the single compatible manifest embedded in a PNG. */
export function decodeAgentImage(bytes: Uint8Array): SnapshotV1 {
  const matching = parseChunks(bytes)
    .map(snapshotText)
    .filter((text) => text !== undefined);
  if (matching.length === 0) {
    throw new AgentSnapshotError(
      "PNG does not contain an agent snapshot",
      "missing-snapshot",
    );
  }
  if (matching.length !== 1) {
    throw new AgentSnapshotError(
      "PNG contains duplicate agent snapshots",
      "duplicate-snapshot",
    );
  }

  const jsonBytes = decodeBase64(matching[0]);
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  } catch {
    throw new AgentSnapshotError(
      "Snapshot JSON is not valid UTF-8",
      "invalid-utf8",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new AgentSnapshotError(
      "Snapshot chunk contains invalid JSON",
      "invalid-json",
    );
  }
  const snapshot = validateSnapshotV1(value);
  // Early Berd animated-card builds stored video as a multi-megabyte base64
  // string inside profile JSON. Do not retain that legacy payload in React
  // state; current exports use the binary bdAV chunk instead.
  if (snapshot.profile) {
    delete snapshot.profile.avatarAnimationDataUrl;
    delete snapshot.profile.avatarAnimationAlphaMode;
  }
  return snapshot;
}

export function decodeAvatarAnimation(
  imageBytes: Uint8Array,
): EmbeddedAvatarAnimation | null {
  const chunks = parseChunks(imageBytes).filter(
    (chunk) => chunk.type === AVATAR_ANIMATION_CHUNK,
  );
  if (chunks.length === 0) return null;
  if (chunks.length !== 1 || chunks[0].data.length < 2) {
    throw new AgentSnapshotError(
      "Invalid avatar animation chunk",
      "invalid-png",
    );
  }
  if (chunks[0].data.length - 1 > MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES) {
    throw new AgentSnapshotError(
      "Avatar animation exceeds the 5 MiB limit",
      "too-large",
    );
  }
  const flags = chunks[0].data[0];
  if (flags & ~0b11) {
    throw new AgentSnapshotError(
      "Unsupported avatar animation flags",
      "invalid-png",
    );
  }
  return {
    bytes: chunks[0].data.subarray(1),
    mimeType: flags & 1 ? "video/mp4" : "video/webm",
    alphaMode: flags & 2 ? "stacked" : undefined,
  };
}

/** Preserves the PNG image and replaces any existing snapshot chunk with one v1 manifest. */
export function encodeAgentImage(
  imageBytes: Uint8Array,
  snapshot: SnapshotV1,
  animation?: EmbeddedAvatarAnimation | null,
): Uint8Array {
  const chunks = parseChunks(imageBytes);
  const validated = validateSnapshotV1(snapshot);
  const manifest = makeTextChunk(
    encodeBase64(textEncoder.encode(JSON.stringify(validated))),
  );
  const kept = chunks.filter(
    (chunk) =>
      snapshotText(chunk) === undefined &&
      chunk.type !== AVATAR_ANIMATION_CHUNK,
  );
  let animationChunk: Uint8Array | null = null;
  if (animation) {
    if (animation.bytes.length > MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES) {
      throw new AgentSnapshotError(
        "Avatar animation exceeds the 5 MiB limit",
        "too-large",
      );
    }
    const animationData = new Uint8Array(animation.bytes.length + 1);
    animationData[0] =
      (animation.mimeType === "video/mp4" ? 1 : 0) |
      (animation.alphaMode === "stacked" ? 2 : 0);
    animationData.set(animation.bytes, 1);
    animationChunk = makeChunk(AVATAR_ANIMATION_CHUNK, animationData);
  }
  const outputLength =
    PNG_SIGNATURE.length +
    manifest.length +
    (animationChunk?.length ?? 0) +
    kept.reduce((sum, chunk) => sum + chunk.end - chunk.start, 0);
  if (outputLength > MAX_SNAPSHOT_PNG_BYTES) {
    throw new AgentSnapshotError(
      "Encoded agent image exceeds the 10 MiB limit",
      "too-large",
    );
  }
  const output = new Uint8Array(outputLength);
  output.set(PNG_SIGNATURE);
  let offset = PNG_SIGNATURE.length;
  let insertedManifest = false;
  for (const chunk of kept) {
    // Buzz's png decoder exposes metadata discovered before image data. Keep
    // the compatibility tEXt chunk before the first IDAT rather than merely
    // anywhere before IEND.
    if (!insertedManifest && (chunk.type === "IDAT" || chunk.type === "IEND")) {
      output.set(manifest, offset);
      offset += manifest.length;
      if (animationChunk) {
        output.set(animationChunk, offset);
        offset += animationChunk.length;
      }
      insertedManifest = true;
    }
    output.set(imageBytes.subarray(chunk.start, chunk.end), offset);
    offset += chunk.end - chunk.start;
  }
  return output;
}
