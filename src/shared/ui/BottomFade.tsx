import { cn } from "@/shared/lib/cn";

interface BottomFadeProps {
  className?: string;
  surface?: string;
}

export function BottomFade({
  className,
  surface = "var(--canvas-base)",
}: BottomFadeProps) {
  return (
    <div
      className={cn(
        "pointer-events-none sticky bottom-0 left-0 h-64 w-full",
        className,
      )}
      style={{
        background: `linear-gradient(to bottom, transparent 0%, ${surface} 100%)`,
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        maskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.4) 50%, black 100%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.4) 50%, black 100%)",
      }}
      aria-hidden="true"
    />
  );
}
