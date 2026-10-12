import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon } from "lucide-react";
import { type ComponentProps, memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ArtifactLinkCandidate,
  useArtifactActionsContext,
} from "@/features/chat/hooks/ArtifactPolicyContext";
import { artifactBasename } from "@/features/chat/lib/artifactViewerTypes";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { ClickableImage } from "./ClickableImage";

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

function isRemoteOrDataSrc(src: string): boolean {
  // Browser/CSP-owned sources are not local-file grants.
  return /^(https?:|data:|blob:)/i.test(src.trim());
}

function LocalMarkdownImage({
  candidate,
  rawSrc,
  alt,
  pathExists,
}: {
  candidate: ArtifactLinkCandidate | null;
  rawSrc: string;
  alt: string;
  pathExists: (path: string) => Promise<boolean>;
}) {
  const { t } = useTranslation("chat");
  const path = candidate?.resolvedPath ?? rawSrc;
  const supported = Boolean(candidate && IMAGE_EXTENSION_RE.test(path));
  const [result, setResult] = useState<"loading" | "ready" | "unavailable">(
    "loading",
  );
  const label = alt.trim() || artifactBasename(path) || t("image.label");

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    setResult("loading");
    void pathExists(path)
      .then((exists) => {
        if (!cancelled) setResult(exists ? "ready" : "unavailable");
      })
      .catch(() => {
        if (!cancelled) setResult("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [supported, path, pathExists]);

  if (supported && result === "ready") {
    return (
      <ClickableImage
        src={convertFileSrc(path, "asset")}
        alt={alt}
        localFilePath={path}
        onError={() => setResult("unavailable")}
      />
    );
  }

  return (
    <Alert role="status" title={path}>
      <ImageIcon aria-hidden="true" />
      <AlertTitle wrap>{label}</AlertTitle>
      <AlertDescription>
        {supported && result === "loading"
          ? t("image.loading")
          : t("image.unavailable")}
      </AlertDescription>
    </Alert>
  );
}

/** Resolve local image paths against the chat cwd, then let the existing
 * Tauri asset scope decide access. Never probe local disk for SSH paths. */
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
    const rawSrc = typeof src === "string" ? src : "";
    const isLocalCandidate = rawSrc.length > 0 && !isRemoteOrDataSrc(rawSrc);
    const candidate = isLocalCandidate ? resolveMarkdownHref(rawSrc) : null;

    // Local-looking remote paths belong to the SSH host, never local disk.
    if (isLocalCandidate && filesAreRemote) {
      const resolvedPath = candidate?.resolvedPath ?? rawSrc;
      const displayName = artifactBasename(resolvedPath);
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

    if (isLocalCandidate) {
      return (
        <LocalMarkdownImage
          key={JSON.stringify([rawSrc, candidate?.resolvedPath])}
          candidate={candidate}
          rawSrc={rawSrc}
          alt={alt ?? ""}
          pathExists={pathExists}
        />
      );
    }

    // Remote URLs and inline data keep their existing browser/CSP behavior.
    return <img src={src} alt={alt ?? ""} {...rest} />;
  },
);
MarkdownImage.displayName = "MarkdownImage";
