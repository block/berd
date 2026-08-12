import {
  normalizePathSeparators,
  toComparablePath,
} from "@/shared/lib/pathIdentity";

export function shortenPath(fullPath: string): string {
  const normalizedPath = normalizePathSeparators(fullPath);
  const home =
    typeof window !== "undefined"
      ? normalizedPath.replace(/^\/Users\/[^/]+/, "~")
      : normalizedPath;
  const comparable = toComparablePath(home);
  const parts = comparable.split("/");
  if (parts.length > 3) {
    return `\u2026/${parts.slice(-2).join("/")}`;
  }
  return comparable || fullPath;
}
