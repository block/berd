import gooseIconMask from "@/shared/assets/goose-icon-mask.png";
import { cn } from "@/shared/lib/cn";

/** Goose agent mark — silhouette mask tinted with `currentColor`. */
export function GooseIcon({ className = "" }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Goose"
      className={cn("inline-block bg-current", className)}
      style={{
        WebkitMaskImage: `url(${gooseIconMask})`,
        maskImage: `url(${gooseIconMask})`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}
