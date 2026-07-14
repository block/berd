import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageOffIcon } from "lucide-react";
import { type ComponentProps, memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useArtifactActionsContext } from "@/features/chat/hooks/ArtifactPolicyContext";
import { LOCAL_MARKDOWN_IMAGES_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  setExperimentEnabled,
  useExperiment,
} from "@/features/experiments/experimentPreferences";
import { Button } from "@/shared/ui/button";
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
 * `ArtifactPolicyContext`. Gated behind the local-markdown-images experiment;
 * remote http(s) images are left to the (CSP-blocking) default renderer.
 *
 * Lives in `features/chat` (not `shared/ui`) because it depends on the chat
 * experiment + artifact-policy machinery; it is injected into the shared
 * `MessageResponse` via the `imageRenderer` prop so `shared/ui` stays free of
 * chat-feature imports.
 */
export const MarkdownImage = memo(
  ({
    src,
    alt,
    node: _node,
    ...rest
  }: ComponentProps<"img"> & { node?: unknown }) => {
    const experiment = useExperiment(LOCAL_MARKDOWN_IMAGES_EXPERIMENT_ID);
    const { resolveMarkdownHref, pathExists } = useArtifactActionsContext();
    const [assetSrc, setAssetSrc] = useState<string | null>(null);

    const rawSrc = typeof src === "string" ? src : "";
    const enabled = experiment?.enabled ?? false;
    const isLocalCandidate =
      enabled && rawSrc.length > 0 && !isRemoteOrDataSrc(rawSrc);

    useEffect(() => {
      if (!isLocalCandidate) {
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
    }, [isLocalCandidate, rawSrc, resolveMarkdownHref, pathExists]);

    if (assetSrc) {
      return <ClickableImage src={assetSrc} alt={alt ?? ""} />;
    }

    // The experiment is off but this looks like a local image the rescue
    // path could render: show a discoverable enable hint in place of the
    // broken image instead of failing silently.
    if (
      !enabled &&
      rawSrc.length > 0 &&
      !isRemoteOrDataSrc(rawSrc) &&
      IMAGE_EXTENSION_RE.test(rawSrc.split("#")[0]?.split("?")[0] ?? "")
    ) {
      return <LocalImageHint />;
    }

    // Fall back to the default rendering (remote images, disabled experiment,
    // or unresolved/missing local files behave exactly as before).
    return <img src={src} alt={alt ?? ""} {...rest} />;
  },
);
MarkdownImage.displayName = "MarkdownImage";

/**
 * Shown in place of a local image while the local-markdown-images experiment
 * is off. Enabling flips the experiment preference; `useExperiment` is backed
 * by `useSyncExternalStore`, so every mounted MarkdownImage re-renders and
 * resolves immediately.
 */
function LocalImageHint() {
  const { t } = useTranslation("chat");
  return (
    <span className="inline-flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <ImageOffIcon aria-hidden className="size-3.5 shrink-0" />
      {t("markdownImages.disabledHint")}
      <Button
        variant="link"
        size="xs"
        onClick={(event) => {
          // The image may be wrapped in a markdown link
          // ([![alt](img)](target)); enabling previews must not also
          // navigate/open the wrapping anchor.
          event.preventDefault();
          event.stopPropagation();
          setExperimentEnabled(LOCAL_MARKDOWN_IMAGES_EXPERIMENT_ID, true);
        }}
      >
        {t("markdownImages.enable")}
      </Button>
    </span>
  );
}
