/**
 * Save an image (from any src the lightbox may hold) to the OS Downloads folder.
 *
 * Fetching the src into a Blob normalizes every src shape the app produces —
 * `data:` (inline agent bytes), `asset://` (Tauri-served local files),
 * `http(s):` (remote), and `blob:` (draft previews) — into a single
 * downloadable blob, then reuses the app's established blob-anchor download
 * convention (see sessions/lib/exportSession.ts and skills/lib/skillsHelpers.ts).
 */

const FILENAME_MAX_LENGTH = 120;
const DEFAULT_EXTENSION = "png";

/** Map a blob MIME type to a file extension, defaulting to png. */
export function extensionFromMime(mime: string): string {
  const subtype = mime.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
  if (!subtype) {
    return DEFAULT_EXTENSION;
  }
  if (subtype === "jpeg") {
    return "jpg";
  }
  if (subtype === "svg+xml") {
    return "svg";
  }
  return subtype;
}

/**
 * Sanitize a filename hint using the same rules as
 * exportSession.ts:defaultExportFilename, stripping any extension so the
 * blob-derived one is authoritative.
 */
function sanitizeFilenameHint(hint: string): string {
  return hint
    .trim()
    .replace(/\.[^.]+$/, "")
    .replaceAll(/[<>:"/\\|?*]/g, "-")
    .replaceAll(/[\r\n\t]/g, "-")
    .split("")
    .map((char) => (char < " " ? "-" : char))
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, FILENAME_MAX_LENGTH);
}

/** Build the final download filename from an optional hint and the blob type. */
function resolveFilename(blobType: string, filenameHint?: string): string {
  const extension = extensionFromMime(blobType);
  const base = filenameHint ? sanitizeFilenameHint(filenameHint) : "";
  if (base) {
    return `${base}.${extension}`;
  }
  return `image-${Date.now()}.${extension}`;
}

/** Trigger a browser download of the given blob under `filename`. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Download the image at `src`, resolving a sensible filename. Returns the
 * filename used so callers can surface it in a toast.
 */
export async function downloadImage(
  src: string,
  filenameHint?: string,
): Promise<string> {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Failed to fetch image (${response.status})`);
  }
  const blob = await response.blob();
  const filename = resolveFilename(blob.type, filenameHint);
  saveBlob(blob, filename);
  return filename;
}
