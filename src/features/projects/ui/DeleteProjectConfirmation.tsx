import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/cn";

interface DeleteProjectConfirmationProps {
  /** Whether the confirmation overlay is visible. The parent tile component
   * owns the open/close state so this component can be unconditionally
   * mounted inside the tile's positioned container. */
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  className?: string;
  /** When true, the overlay traps Escape (closes) and outside-click (closes).
   * Defaults to true. Disable only for non-interactive design demos. */
  dismissable?: boolean;
}

/**
 * Translucent in-place confirmation that appears OVER a project tile (not a
 * centered Dialog). Renders `absolute inset-0` so it covers its
 * relatively-positioned parent; the parent owns sizing. Per the Q2 2026
 * Figma:
 *   - Scrim: `bg-black/40` + `backdrop-blur-sm` over the underlying tile
 *   - Centered white body copy
 *   - "Yes, delete" text-only action + small WHITE pill "Cancel"
 *
 * Dismissed on Escape or outside-click (clicks on the scrim itself, not on
 * the body or actions).
 */
export function DeleteProjectConfirmation({
  open,
  onCancel,
  onConfirm,
  className,
  dismissable = true,
}: DeleteProjectConfirmationProps) {
  const { t } = useTranslation(["projects", "common"]);

  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismissable, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("view.deleteConfirmBody")}
      className={cn(
        "absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 rounded-[inherit] px-6 text-center",
        className,
      )}
    >
      {/* Scrim — separate element so the dialog wrapper doesn't carry
          a click handler (avoids a11y/useKeyWithClickEvents on a div).
          Escape dismissal lives on the document via the effect above. */}
      <button
        type="button"
        aria-label={t("common:actions.cancel")}
        tabIndex={-1}
        onClick={() => {
          if (dismissable) onCancel();
        }}
        className="absolute inset-0 rounded-[inherit] bg-black/40 backdrop-blur-sm"
      />
      <p className="relative max-w-[20rem] text-sm leading-[15px] text-white">
        {t("view.deleteConfirmBody")}
      </p>
      <div className="relative flex items-center gap-3">
        <button
          type="button"
          onClick={onConfirm}
          className="text-sm leading-[15px] text-white hover:opacity-80"
        >
          {t("view.deleteConfirmYes")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-[30px] items-center rounded-sm bg-popover px-3 text-sm leading-[15px] text-foreground"
        >
          {t("common:actions.cancel")}
        </button>
      </div>
    </div>
  );
}
