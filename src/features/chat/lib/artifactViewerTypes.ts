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
 * Returns the single viewable artifact (markdown/image) across the given
 * tool requests, or null when there are zero or several distinct ones.
 * Shared by the transcript's chain/work headers to surface a "View" action
 * that stays reachable while the steps are collapsed — one file keeps the
 * action unambiguous; several fall back to expand-to-choose.
 */
export function singleViewableArtifact(
  requests: Iterable<ToolRequestContent | undefined>,
): ViewableArtifactTarget | null {
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
  return viewable.length === 1 ? viewable[0] : null;
}

export function isViewableArtifact(path: string): boolean {
  return classifyArtifactView(path) !== null;
}
