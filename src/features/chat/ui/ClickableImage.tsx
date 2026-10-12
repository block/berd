import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createVirtualLayoutStabilityAttributes } from "@/features/chat/transcript/measurement";
import { useTranscriptOpenOverlayProtection } from "@/features/chat/transcript/row-state";
import { ImageLightbox } from "@/shared/ui/ImageLightbox";

export function ClickableImage({
  src,
  alt,
  onError,
  localFilePath,
}: {
  src: string;
  alt: string;
  onError?: () => void;
  localFilePath?: string;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [settledSrc, setSettledSrc] = useState<string | null>(null);
  const isImagePending = settledSrc !== src;
  useTranscriptOpenOverlayProtection({
    open,
    overlayKind: "lightbox",
    overlayId: "image-lightbox",
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer rounded-lg"
        aria-label={t("image.view", { label: alt })}
        {...createVirtualLayoutStabilityAttributes({
          isPending: isImagePending,
          reason: "image-loading",
          reservedBlockSize: 192,
        })}
      >
        <img
          src={src}
          alt={alt}
          onError={() => {
            setSettledSrc(src);
            onError?.();
          }}
          onLoad={() => setSettledSrc(src)}
          className="max-h-48 max-w-xs rounded-lg object-contain"
        />
      </button>
      <ImageLightbox
        src={src}
        alt={alt}
        localFilePath={localFilePath}
        downloadFilename={localFilePath?.replace(/\\/g, "/").split("/").pop()}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
