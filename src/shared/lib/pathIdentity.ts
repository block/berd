/**
 * One narrow home for filesystem path identity, containment, display
 * formatting, and `file://` URL decoding — so the same Windows/Unix rules are
 * not re-derived (differently) at every call site.
 *
 * Three contracts are kept deliberately distinct:
 *
 *  1. **Display formatting** (`toComparablePath`, `getPathBasename`): normalizes
 *     separators to `/`, resolves lexical dot segments, and preserves the
 *     original spelling and case. Use for anything the user reads.
 *  2. **Filesystem identity** (`toIdentityKey`, `isSamePath`, `isPathWithin`,
 *     `getRelativePath`): decides whether two strings name the same location.
 *     Windows drive/UNC paths and macOS paths fold case; Linux paths preserve
 *     it. Containment is segment-boundary terminated, so `/work-secrets` is
 *     never "inside" `/work`.
 *  3. **File-URL decoding** (`fileUrlToPath`): converts a `file://` URL to a
 *     real path using URL semantics — percent escapes are decoded, UNC
 *     authorities are preserved, and malformed or unsafe values are rejected
 *     (returns `null`).
 */

import { getPlatform, type Platform } from "@/shared/lib/platform";

const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;
const WINDOWS_DRIVE_ROOT_PATTERN = /^[a-zA-Z]:\/$/;
const WINDOWS_UNC_PATTERN =
  /^(?:\\\\|\/\/)(?!\.{1,2}(?:[\\/]|$))[^\\/]+[\\/](?!\.{1,2}(?:[\\/]|$))[^\\/]+(?:[\\/]|$)/;
const ENCODED_PATH_SEPARATOR_PATTERN = /%(?:2f|5c)/i;
const ABSOLUTE_FILE_URL_PATTERN = /^file:(?:\/|[a-zA-Z]:[\\/])/i;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

/** Replace backslash separators with `/`. Case and everything else preserved. */
export function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

function hasWindowsDriveRoot(path: string): boolean {
  return WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(path);
}

function hasWindowsUncRoot(path: string): boolean {
  return WINDOWS_UNC_PATTERN.test(path);
}

function removeTrailingSeparators(path: string): string {
  if (path === "/" || WINDOWS_DRIVE_ROOT_PATTERN.test(path)) {
    return path;
  }
  return path.replace(/\/+$/, "");
}

function filesystemRoot(path: string): {
  prefix: string;
  remainder: string;
} {
  const driveMatch = /^([a-zA-Z]:)\/(.*)$/.exec(path);
  if (driveMatch) {
    return { prefix: `${driveMatch[1]}/`, remainder: driveMatch[2] };
  }

  const driveRelativeMatch = /^([a-zA-Z]:)(?!\/)(.*)$/.exec(path);
  if (driveRelativeMatch) {
    return { prefix: driveRelativeMatch[1], remainder: driveRelativeMatch[2] };
  }

  const uncMatch = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (uncMatch && uncMatch[1] !== "." && uncMatch[2] !== "..") {
    return {
      prefix: `//${uncMatch[1]}/${uncMatch[2]}`,
      remainder: uncMatch[3] ?? "",
    };
  }

  if (path.startsWith("/")) {
    return { prefix: "/", remainder: path.slice(1) };
  }

  return { prefix: "", remainder: path };
}

function normalizeLexicalPath(path: string): string {
  const normalized = removeTrailingSeparators(normalizePathSeparators(path));
  const { prefix, remainder } = filesystemRoot(normalized);
  const clampsParentTraversal =
    prefix === "/" || prefix.endsWith("/") || prefix.startsWith("//");
  const segments: string[] = [];

  for (const segment of remainder.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!clampsParentTraversal) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  if (!prefix) return segments.join("/");
  if (prefix === "/") return segments.length ? `/${segments.join("/")}` : "/";
  if (prefix.endsWith("/") || /^[a-zA-Z]:$/.test(prefix)) {
    return segments.length ? `${prefix}${segments.join("/")}` : prefix;
  }
  return segments.length ? `${prefix}/${segments.join("/")}` : prefix;
}

/**
 * Display/comparison base form: separators normalized to `/`, lexical `.` and
 * `..` segments resolved, and trailing separators stripped without changing
 * case. Unix and Windows roots retain their root separators.
 */
export function toComparablePath(path: string): string {
  return normalizeLexicalPath(path);
}

/**
 * True when a path carries an absolute Windows drive-letter root (`C:\` or
 * `c:/`) or a UNC authority (`\\server\share` / `//server/share`). Only these
 * paths get case folding for identity; bare `C:` stays drive-relative.
 */
export function isWindowsPath(path: string): boolean {
  const trimmed = path.trim();
  return hasWindowsDriveRoot(trimmed) || hasWindowsUncRoot(trimmed);
}

/**
 * Filesystem identity key. Windows drive/UNC paths always fold case. Unix-style
 * paths fold on macOS, whose default APFS/HFS+ volumes are case-insensitive,
 * and remain case-sensitive on Linux. The platform parameter is injectable so
 * tests and non-browser callers do not have to counterfeit navigator state.
 */
export function toIdentityKey(
  path: string,
  platform: Platform = getPlatform(),
): string {
  const comparable = toComparablePath(path);
  return isWindowsPath(path) || platform === "mac"
    ? comparable.toLowerCase()
    : comparable;
}

/** True when both paths name the same filesystem location. */
export function isSamePath(
  a: string | null | undefined,
  b: string | null | undefined,
  platform: Platform = getPlatform(),
): boolean {
  if (!a || !b) return false;
  return toIdentityKey(a, platform) === toIdentityKey(b, platform);
}

/**
 * True when `target` is `base` itself or a descendant of it. Boundary-terminated
 * so a sibling (`/work-secrets` under `/work`) is never contained.
 */
export function isPathWithin(
  base: string | null | undefined,
  target: string | null | undefined,
  platform: Platform = getPlatform(),
): boolean {
  if (!base || !target) return false;
  const basePath = splitIdentityPath(base, platform);
  const targetPath = splitIdentityPath(target, platform);
  if (basePath.windows !== targetPath.windows) return false;
  if (
    identitySegment(basePath.root, basePath.caseInsensitive) !==
    identitySegment(targetPath.root, targetPath.caseInsensitive)
  ) {
    return false;
  }
  if (targetPath.segments.length < basePath.segments.length) return false;
  return basePath.segments.every(
    (segment, index) =>
      identitySegment(segment, basePath.caseInsensitive) ===
      identitySegment(targetPath.segments[index], targetPath.caseInsensitive),
  );
}

interface NormalizedIdentityPath {
  root: string;
  segments: string[];
  windows: boolean;
  caseInsensitive: boolean;
}

function splitIdentityPath(
  path: string,
  platform: Platform,
): NormalizedIdentityPath {
  const comparable = toComparablePath(path);
  const { prefix, remainder } = filesystemRoot(comparable);
  const windows = isWindowsPath(path);
  return {
    root: prefix,
    segments: remainder ? remainder.split("/") : [],
    windows,
    caseInsensitive: windows || platform === "mac",
  };
}

function identitySegment(value: string, caseInsensitive: boolean): string {
  return caseInsensitive ? value.toLowerCase() : value;
}

/**
 * Path of `path` relative to `root`, or `null` when `path` is not contained in
 * `root`. Returns `""` when they are the same location. The remainder preserves
 * the original spelling/case of `path` (identity only decides containment).
 */
export function getRelativePath(
  path: string,
  root: string | null | undefined,
  platform: Platform = getPlatform(),
): string | null {
  if (!root) return null;
  const target = splitIdentityPath(path, platform);
  const base = splitIdentityPath(root, platform);
  if (target.windows !== base.windows) return null;
  if (
    identitySegment(target.root, target.caseInsensitive) !==
    identitySegment(base.root, base.caseInsensitive)
  ) {
    return null;
  }
  if (target.segments.length < base.segments.length) return null;

  for (let index = 0; index < base.segments.length; index += 1) {
    if (
      identitySegment(target.segments[index], target.caseInsensitive) !==
      identitySegment(base.segments[index], base.caseInsensitive)
    ) {
      return null;
    }
  }

  return target.segments.slice(base.segments.length).join("/");
}

/** Last path segment, in display form (case/spelling preserved). */
export function getPathBasename(path: string): string {
  const comparable = toComparablePath(path);
  if (comparable === "/" || WINDOWS_DRIVE_ROOT_PATTERN.test(comparable)) {
    return comparable;
  }
  const lastSlash = comparable.lastIndexOf("/");
  return lastSlash === -1 ? comparable : comparable.slice(lastSlash + 1);
}

/**
 * True when `input` uses the `file:` scheme, regardless of whether it is safe
 * to convert. Callers use this to distinguish "not a file URL, handle normally"
 * from "a file URL that `fileUrlToPath` rejected as malformed/unsafe" — the
 * latter must never fall through to ordinary URI/path handling.
 */
export function isFileUrl(input: string | null | undefined): boolean {
  return typeof input === "string" && /^file:/i.test(input.trim());
}

/**
 * Convert an absolute `file:` URL to a filesystem path using URL semantics,
 * or `null` when the input is not a `file:` URL or is malformed/unsafe.
 *
 * - Percent escapes are decoded (`%20` -> space, `%23` -> `#`, Unicode, ...).
 * - A `localhost` (or empty) authority yields a local path; any other authority
 *   is preserved as a UNC path (`//server/share/...`).
 * - Windows drive URLs (`file:///C:/x`) drop the leading slash to `C:/x`.
 * - Relative forms (`file:report.md`, `file:./report.md`) are rejected before
 *   the URL parser can silently reinterpret them as root-absolute paths.
 * - Malformed percent sequences and embedded control characters are rejected.
 */
export function fileUrlToPath(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (
    !isFileUrl(trimmed) ||
    !ABSOLUTE_FILE_URL_PATTERN.test(trimmed) ||
    hasControlCharacter(trimmed)
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    url.protocol !== "file:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    ENCODED_PATH_SEPARATOR_PATTERN.test(url.pathname)
  ) {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent escape (e.g. `%ZZ`, dangling `%`).
    return null;
  }

  // Control characters (NUL included) are never valid in a real path and are a
  // classic smuggling vector.
  if (hasControlCharacter(pathname)) return null;

  const host = url.hostname;
  if (host && host !== "localhost") {
    // UNC authority: preserve it as `//server/<pathname>`.
    return `//${host}${pathname}`;
  }

  const driveMatch = /^\/([A-Za-z]:)(\/.*)?$/.exec(pathname);
  if (driveMatch) {
    return `${driveMatch[1]}${driveMatch[2] ?? ""}`;
  }

  return pathname;
}
