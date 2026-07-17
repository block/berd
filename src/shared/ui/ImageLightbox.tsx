import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
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
}

export function ImageLightbox({
  src,
  alt = "Image preview",
  open,
  onOpenChange,
  onPrevious,
  onNext,
  downloadFilename,
}: ImageLightboxProps) {
  const { t } = useTranslation("chat");

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
        className="focus-override w-auto origin-center flex items-center justify-center border-none bg-transparent p-0 shadow-none outline-none motion-safe:data-[state=closed]:zoom-out-95 motion-safe:data-[state=open]:zoom-in-95 motion-safe:duration-200 motion-safe:ease-out motion-reduce:animate-none focus:outline-none focus-visible:outline-none sm:max-w-[90vw]"
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
        <img
          src={src}
          alt={alt}
          className="max-h-[85vh] max-w-[90vw] rounded-md object-contain motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=open]:zoom-in-95 motion-safe:data-[state=open]:duration-200 motion-safe:data-[state=open]:ease-out motion-reduce:animate-none"
          data-state={open ? "open" : "closed"}
        />
        {src && (
          <GlassButton
            type="button"
            size="icon"
            aria-label={t("image.download")}
            className="absolute top-4 right-4"
            onClick={handleDownload}
          >
            <Download />
          </GlassButton>
        )}
      </DialogContent>
    </Dialog>
  );
}
