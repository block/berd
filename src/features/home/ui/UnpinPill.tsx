import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Popover, PopoverAnchor, PopoverContent } from "@/shared/ui/popover";

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
 * The anchor span is portaled to `document.body` so `position: fixed` resolves
 * against the viewport, not the canvas's transformed parent (which would
 * otherwise become the containing block and offset the popover by the camera
 * translation). Radix continues to own dismiss-on-outside-click and Escape.
 */
export function UnpinPill({
  open,
  cursorClientX,
  cursorClientY,
  onUnpin,
  onOpenChange,
}: UnpinPillProps) {
  const { t } = useTranslation("home");

  const anchor =
    typeof document !== "undefined"
      ? createPortal(
          <PopoverAnchor asChild>
            <span
              aria-hidden="true"
              className="pointer-events-none fixed size-0"
              style={{ left: cursorClientX, top: cursorClientY }}
            />
          </PopoverAnchor>,
          document.body,
        )
      : null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {anchor}
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        onPointerDownCapture={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => event.preventDefault()}
        style={{ boxShadow: "none" }}
        className="w-auto border-0 bg-transparent p-0 shadow-none outline-none"
      >
        <button
          type="button"
          onClick={() => {
            onUnpin();
            onOpenChange(false);
          }}
          className="rounded-pill bg-popover-inverse px-4 py-2 text-sm text-popover-inverse-foreground transition-opacity hover:opacity-70"
        >
          {t("widgets.unpin.label")}
        </button>
      </PopoverContent>
    </Popover>
  );
}
