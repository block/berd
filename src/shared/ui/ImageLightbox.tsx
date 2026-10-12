import { Copy, Download, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
import { copyImage } from "@/shared/ui/copyImage";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { pathExists } from "@/shared/api/system";
import { getPlatform } from "@/shared/lib/platform";
import { downloadImage } from "@/shared/ui/downloadImage";
import { GlassButton } from "@/shared/ui/glass-button";
import { openDownloadsFolder } from "@/shared/ui/openDownloadsFolder";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  /**
   * Optional filename hint for the download. Callers pass a real attachment
   * name where they have one; otherwise the helper defaults to
   * `image-<timestamp>.<ext>`.
   */
  downloadFilename?: string;
  /** Original local file provenance, never inferred from asset/data URLs. */
  localFilePath?: string;
}

export function ImageLightbox({
  src,
  alt = "Image preview",
  open,
  onOpenChange,
  onPrevious,
  onNext,
  downloadFilename,
  localFilePath,
}: ImageLightboxProps) {
  const { t } = useTranslation("chat");
  const [copying, setCopying] = useState(false);
  const [existingLocalPath, setExistingLocalPath] = useState<string | null>(
    null,
  );
  useEffect(() => {
    setExistingLocalPath(null);
    if (!open || !localFilePath || !window.__TAURI_INTERNALS__) return;
    let cancelled = false;
    void pathExists(localFilePath)
      .then((exists) => {
        if (!cancelled) setExistingLocalPath(exists ? localFilePath : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, localFilePath]);
  const revealLabel = t(`common:labels.revealInFileManager_${getPlatform()}`);

  const handleCopy = () => {
    if (copying) return;
    setCopying(true);
    void copyImage(src)
      .then(() => toast.message(t("image.copied")))
      .catch((error) => {
        console.error("Failed to copy image:", error);
        toast.error(t("image.copyError"));
      })
      .finally(() => setCopying(false));
  };

  const handleReveal = () => {
    if (!existingLocalPath || existingLocalPath !== localFilePath) return;
    void revealInFileManager(existingLocalPath).catch((error) => {
      console.error("Failed to reveal image:", error);
      toast.error(t("image.revealError"));
    });
  };

  const handleDownload = () => {
    void downloadImage(src, downloadFilename)
      .then((filename) => {
        const options = window.__TAURI_INTERNALS__
          ? {
              action: {
                label: t("image.openDownloads"),
                onClick: () => {
                  void openDownloadsFolder().catch((error) => {
                    console.error("Failed to open Downloads folder:", error);
                    toast.error(t("image.openDownloadsError"));
                  });
                },
              },
            }
          : {};
        toast.message(t("image.downloadStarted", { filename }), options);
      })
      .catch((error) => {
        console.error("Failed to download image:", error);
        toast.error(t("image.downloadError"));
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="focus-override w-auto origin-center flex flex-col gap-2 items-center justify-center border-none bg-transparent p-0 shadow-none outline-none motion-safe:data-[state=closed]:zoom-out-95 motion-safe:data-[state=open]:zoom-in-95 motion-safe:duration-200 motion-safe:ease-out motion-reduce:animate-none focus:outline-none focus-visible:outline-none sm:max-w-[90vw]"
        showCloseButton={false}
        aria-describedby={undefined}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && onPrevious) {
            event.preventDefault();
            onPrevious();
          }
          if (event.key === "ArrowRight" && onNext) {
            event.preventDefault();
            onNext();
          }
        }}
      >
        {/* Visually hidden title for accessibility */}
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        {src && (
          <div
            role="toolbar"
            aria-label={t("image.actions")}
            className="flex w-full justify-end gap-2"
          >
            <GlassButton
              type="button"
              size="icon"
              title={t("image.copy")}
              aria-label={t("image.copy")}
              feedbackState={copying ? "loading" : "idle"}
              loadingVisual="spinner"
              onClick={handleCopy}
            >
              <Copy />
            </GlassButton>
            <GlassButton
              type="button"
              size="icon"
              title={t("image.download")}
              aria-label={t("image.download")}
              onClick={handleDownload}
            >
              <Download />
            </GlassButton>
            {existingLocalPath && existingLocalPath === localFilePath && (
              <GlassButton
                type="button"
                size="icon"
                title={revealLabel}
                aria-label={revealLabel}
                onClick={handleReveal}
              >
                <FolderOpen />
              </GlassButton>
            )}
          </div>
        )}
        <img
          src={src || undefined}
          alt={alt}
          className="max-h-[calc(85vh-3rem)] max-w-[90vw] rounded-md object-contain motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=open]:zoom-in-95 motion-safe:data-[state=open]:duration-200 motion-safe:data-[state=open]:ease-out motion-reduce:animate-none"
          data-state={open ? "open" : "closed"}
        />
      </DialogContent>
    </Dialog>
  );
}
