/**
 * Classifies a file path into a viewer "view mode". This is the extension
 * point for the in-app artifact viewer: new renderable types (code, csv,
 * pdf, html) are added here without touching the panel or the trigger.
 *
 * v1 supports:
 *  - "markdown": rendered (Streamdown) with a Preview <-> Raw toggle
 *  - "image": rendered via convertFileSrc
 *
 * Files that don't map to a view mode are never opened in the viewer — the
 * caller keeps the existing "open externally" behavior for them.
 */
import type { ToolRequestContent } from "@/shared/types/messages";
export type ArtifactViewMode = "markdown" | "image";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

/** Basename of a path, tolerant of both `/` and `\` separators. */
export function artifactBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || path;
}

export function fileExtension(path: string): string {
  const name = artifactBasename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot).toLowerCase();
}

export function classifyArtifactView(path: string): ArtifactViewMode | null {
  const ext = fileExtension(path);
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return null;
}

/**
 * True when this path can be previewed inside the app. When false, callers
 * keep the existing "open externally" behavior — the viewer never mounts.
 */
export interface ViewableArtifactTarget {
  path: string;
  filename: string;
}

/**
 * Every distinct viewable artifact (markdown/image) across the given tool
 * requests, in first-seen order.
 *
 * This replaced an earlier `singleViewableArtifact` helper that collapsed to
 * null whenever a chain touched two or more files. That kept a *header* action
 * unambiguous, but it also meant the busiest chains — the ones where getting
 * back to a file matters most — offered no way back, and the same document
 * surfaced as a different-looking control depending on how the run grouped.
 * Inline chips render one affordance per file, so they need the full list.
 */
export function viewableArtifacts(
  requests: Iterable<ToolRequestContent | undefined>,
): ViewableArtifactTarget[] {
  const seen = new Set<string>();
  const viewable: ViewableArtifactTarget[] = [];
  for (const request of requests) {
    for (const location of request?.locations ?? []) {
      const path = location.path;
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (!isViewableArtifact(path)) continue;
      viewable.push({ path, filename: artifactBasename(path) });
    }
  }
  return viewable;
}

export function isViewableArtifact(path: string): boolean {
  return classifyArtifactView(path) !== null;
}
