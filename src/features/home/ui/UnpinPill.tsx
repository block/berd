import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

interface UnpinPillProps {
  open: boolean;
  cursorClientX: number;
  cursorClientY: number;
  onUnpin: () => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * UnpinPill — a single floating black "Unpin" button anchored at the cursor.
 *
 * This is portaled to `document.body` with fixed coordinates so it is never
 * offset by the canvas transform and never flashes at Radix's pre-measurement
 * origin on first open.
 */
export function UnpinPill({
  open,
  cursorClientX,
  cursorClientY,
  onUnpin,
  onOpenChange,
}: UnpinPillProps) {
  const { t } = useTranslation("home");
  const pillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (pillRef.current?.contains(event.target as Node)) {
        return;
      }
      onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={pillRef}
      style={{
        left: cursorClientX,
        top: cursorClientY + 4,
        boxShadow: "none",
      }}
      className="fixed z-50 w-auto border-0 bg-transparent p-0 shadow-none outline-none"
    >
      <button
        type="button"
        onPointerDownCapture={(event) => event.stopPropagation()}
        onClick={() => {
          onUnpin();
          onOpenChange(false);
        }}
        className="rounded-full bg-popover-inverse px-4 py-2 text-sm text-popover-inverse-foreground transition-opacity hover:opacity-70"
      >
        {t("widgets.unpin.label")}
      </button>
    </div>,
    document.body,
  );
}
