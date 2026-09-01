import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon } from "lucide-react";
import { type ComponentProps, memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useArtifactActionsContext } from "@/features/chat/hooks/ArtifactPolicyContext";
import { ClickableImage } from "./ClickableImage";

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

function isRemoteOrDataSrc(src: string): boolean {
  // Remote (http/https) and inline (data:/blob:) sources are handled by the
  // browser/CSP directly — this override only rescues LOCAL file paths.
  return /^(https?:|data:|blob:)/i.test(src.trim());
}

/**
 * Renders a Markdown image whose `src` points at a local file in the session
 * working directory by routing it through the Tauri `asset:` scheme (the same
 * mechanism avatars/artifacts use), so `![alt](./photo.jpg)` renders inline
 * instead of a broken image. Scoped to the session working directory via
 * `ArtifactPolicyContext`; remote http(s) images are left to the
 * (CSP-blocking) default renderer.
 *
 * Lives in `features/chat` (not `shared/ui`) because it depends on the chat
 * artifact-policy machinery; it is injected into the shared `MessageResponse`
 * via the `imageRenderer` prop so `shared/ui` stays free of chat-feature
 * imports.
 */
export const MarkdownImage = memo(
  ({
    src,
    alt,
    node: _node,
    ...rest
  }: ComponentProps<"img"> & { node?: unknown }) => {
    const { t } = useTranslation("chat");
    const { resolveMarkdownHref, pathExists, filesAreRemote, remoteHost } =
      useArtifactActionsContext();
    const [assetSrc, setAssetSrc] = useState<string | null>(null);

    const rawSrc = typeof src === "string" ? src : "";
    const isLocalCandidate = rawSrc.length > 0 && !isRemoteOrDataSrc(rawSrc);

    useEffect(() => {
      if (!isLocalCandidate || filesAreRemote) {
        setAssetSrc(null);
        return;
      }
      let cancelled = false;
      // Clear any previously resolved image immediately so switching between
      // two valid local images never shows the stale one while the new
      // existence check is in flight.
      setAssetSrc(null);
      const candidate = resolveMarkdownHref(rawSrc);
      // resolveMarkdownHref returns null for blocked schemes (e.g. remote) and
      // resolves relative paths against the session cwd. Require the resolved
      // path to actually be contained within the session cwd, so absolute
      // paths (`/abs/private.png`) and `..`-escapes (`../../private.png`) are
      // rejected rather than rendered from outside the working directory.
      if (
        !candidate?.isWithinSessionCwd ||
        !IMAGE_EXTENSION_RE.test(candidate.resolvedPath)
      ) {
        return;
      }
      void pathExists(candidate.resolvedPath)
        .then((exists) => {
          if (cancelled) return;
          setAssetSrc(
            exists ? convertFileSrc(candidate.resolvedPath, "asset") : null,
          );
        })
        .catch(() => {
          // A failed existence check must not leave a stale image rendered or
          // surface as an unhandled rejection — fall back to the default <img>.
          if (!cancelled) setAssetSrc(null);
        });
      return () => {
        cancelled = true;
      };
    }, [
      filesAreRemote,
      isLocalCandidate,
      rawSrc,
      resolveMarkdownHref,
      pathExists,
    ]);

    // A local-looking path in a remote session names a file on the SSH host:
    // the asset: scheme would 404 against the local disk. Render a compact
    // placeholder (file name + host chip) instead of a broken image.
    if (isLocalCandidate && filesAreRemote) {
      const resolvedPath = resolveMarkdownHref(rawSrc)?.resolvedPath ?? rawSrc;
      const displayName =
        resolvedPath.split("/").filter(Boolean).pop() ?? resolvedPath;
      return (
        <span
          data-testid="remote-image-placeholder"
          title={resolvedPath}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/80 bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
        >
          <ImageIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{alt?.trim() || displayName}</span>
          <span className="shrink-0 rounded-full border border-border/80 px-1.5 py-px">
            {t("remoteSessionGuards.onHostChip", { host: remoteHost })}
          </span>
        </span>
      );
    }

    if (assetSrc) {
      return <ClickableImage src={assetSrc} alt={alt ?? ""} />;
    }

    // Fall back to the default rendering for remote images and local files
    // that are missing, unsupported, or outside the session working directory.
    return <img src={src} alt={alt ?? ""} {...rest} />;
  },
);
MarkdownImage.displayName = "MarkdownImage";
