/** True when the path points into the user's home directory via a `~` prefix. */
export function isHomeRelativePath(path: string): boolean {
  return path === "~" || path.startsWith("~/");
}

/**
 * Expand a leading `~` to the user's home directory so both spellings of the
 * same directory (`~/foo` and `/Users/me/foo`) collapse to one canonical path
 * — and therefore one backend request/cache entry wherever paths are used as
 * keys. Non-home-relative paths pass through untouched.
 */
export function expandHomePath(path: string, homeDir: string): string {
  if (!isHomeRelativePath(path)) {
    return path;
  }
  const normalizedHome = homeDir.replace(/\/+$/, "");
  return path === "~"
    ? normalizedHome || "/"
    : `${normalizedHome}${path.slice(1)}`;
}
