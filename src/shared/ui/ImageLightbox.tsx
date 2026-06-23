import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrevious?: () => void;
  onNext?: () => void;
}

export function ImageLightbox({
  src,
  alt = "Image preview",
  open,
  onOpenChange,
  onPrevious,
  onNext,
}: ImageLightboxProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="focus-override w-auto flex items-center justify-center border-none bg-transparent p-0 shadow-none outline-none focus:outline-none focus-visible:outline-none sm:max-w-[90vw]"
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
          className="max-h-[85vh] max-w-[90vw] rounded-md object-contain"
        />
      </DialogContent>
    </Dialog>
  );
}
