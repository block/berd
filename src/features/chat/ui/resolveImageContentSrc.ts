import { convertFileSrc } from "@tauri-apps/api/core";

interface ImageContentLike {
  data?: string | null;
  mimeType?: string | null;
  uri?: string | null;
}

/**
 * Resolve the best renderable `src` for an ACP image content block.
 *
 * ACP image blocks always carry base64 `data` and may *also* carry a `uri`
 * (e.g. an image-generating MCP can return `file:///tmp/generated.png` plus the
 * base64 bytes). The previous `uri ?? data:` ordering preferred the `file://`
 * URI, which the webview/CSP cannot load — so a perfectly valid inline image
 * rendered broken. Resolution order:
 *
 *   1. Inline base64 `data` when present — always loadable in the webview.
 *   2. A local `file://` URI converted through the Tauri `asset:` scheme so the
 *      webview can actually fetch it (a raw `file://` is blocked).
 *   3. Any other URI (http(s)/data) verbatim.
 *
 * Returns `null` when there is nothing renderable.
 */
export function resolveImageContentSrc(
  content: ImageContentLike,
): string | null {
  const data = typeof content.data === "string" ? content.data : "";
  const mimeType =
    typeof content.mimeType === "string" && content.mimeType.length > 0
      ? content.mimeType
      : "image/png";

  // Prefer inline bytes whenever present — they always render in the webview.
  if (data.length > 0) {
    return `data:${mimeType};base64,${data}`;
  }

  const uri = typeof content.uri === "string" ? content.uri.trim() : "";
  if (uri.length === 0) {
    return null;
  }

  // A raw file:// URI is not loadable under the webview/CSP; route local files
  // through the asset scheme. convertFileSrc expects a decoded filesystem path.
  if (uri.toLowerCase().startsWith("file://")) {
    const path = decodeFileUriPath(uri);
    return path.length > 0 ? convertFileSrc(path, "asset") : null;
  }

  return uri;
}

function decodeFileUriPath(uri: string): string {
  const withoutScheme = uri.slice("file://".length);
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}
