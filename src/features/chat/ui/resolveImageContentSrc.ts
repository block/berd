import { convertFileSrc } from "@tauri-apps/api/core";
import { fileUrlToPath, isFileUrl } from "@/shared/lib/pathIdentity";

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
  // A file:// URI that fails to convert is malformed/unsafe — return null
  // rather than handing the raw file:// string to the webview.
  if (isFileUrl(uri)) {
    const filePath = fileUrlToPath(uri);
    return filePath && filePath.length > 0
      ? convertFileSrc(filePath, "asset")
      : null;
  }

  return uri;
}
