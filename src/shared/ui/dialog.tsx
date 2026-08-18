import type * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Slot } from "@radix-ui/react-slot";
function SolidXIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M3.76 2.35a1 1 0 0 0-1.41 1.41L6.59 8l-4.24 4.24a1 1 0 1 0 1.41 1.41L8 9.41l4.24 4.24a1 1 0 0 0 1.41-1.41L9.41 8l4.24-4.24a1 1 0 0 0-1.41-1.41L8 6.59 3.76 2.35Z" />
    </svg>
  );
}

import { cn } from "@/shared/lib/cn";

/**
 * Dialog — the app's one modal surface.
 *
 * Compose what the use case needs; the anatomy is built in, not forked into
 * separate components (industry-standard single-dialog model):
 *
 * - `DialogContent` owns the glass surface, close button, and a `size`
 *   preset ("md" | "lg" | "xl") instead of ad-hoc `max-w-*` classes.
 * - Simple dialogs: `DialogHeader` + content + `DialogFooter`, everything
 *   scrolls together (default).
 * - Content-heavy dialogs: add `DialogBody` around the scrollable middle.
 *   Its presence automatically pins the header and footer, moves padding to
 *   the zones, and gives the footer its divider — no separate "structured"
 *   component. Use `asChild` to make the body a `<form>` so submit/Enter
 *   semantics live on the scroll region.
 *
 * Semantic variants stay separate on purpose: `AlertDialog` (interruptive)
 * and `ConfirmDialog` (yes/no preset). Everything else is this Dialog.
 */

type DialogSize = "md" | "lg" | "xl";

const DIALOG_SIZE_TO_MAX_W: Record<DialogSize, string> = {
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-[60] bg-[var(--overlay-scrim)] [backdrop-filter:var(--backdrop-overlay-glass)] [-webkit-backdrop-filter:var(--backdrop-overlay-glass)]",
        className,
      )}
      {...props}
    />
  );
}

type DialogSurface = "glass" | "solid";

function DialogContent({
  className,
  children,
  overlayClassName,
  positionerClassName,
  showCloseButton = true,
  closeLabel = "Close",
  size = "lg",
  surface = "glass",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  overlayClassName?: string;
  positionerClassName?: string;
  showCloseButton?: boolean;
  closeLabel?: string;
  size?: DialogSize;
  surface?: DialogSurface;
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay className={overlayClassName} />
      <div
        data-slot="dialog-positioner"
        className={cn(
          "pointer-events-none fixed inset-0 z-[61] grid place-items-center p-4",
          positionerClassName,
        )}
      >
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className={cn(
            "group/dialog pointer-events-auto relative grid max-h-[calc(100dvh-2rem)] w-full gap-4 overflow-y-auto rounded-md p-6 shadow-[var(--shadow-modal)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
            surface === "glass"
              ? "bg-[var(--surface-popover-glass)] [backdrop-filter:var(--backdrop-popover-glass)] [-webkit-backdrop-filter:var(--backdrop-popover-glass)]"
              : "bg-popover text-popover-foreground backdrop-filter-none [-webkit-backdrop-filter:none]",
            // Zoned mode: a DialogBody child switches the content to a pinned
            // header / scrollable body / pinned footer column. Padding moves
            // from the surface to the zones (see DialogHeader/Body/Footer).
            "has-data-[slot=dialog-body]:flex has-data-[slot=dialog-body]:flex-col has-data-[slot=dialog-body]:gap-0 has-data-[slot=dialog-body]:overflow-hidden has-data-[slot=dialog-body]:p-0",
            DIALOG_SIZE_TO_MAX_W[size],
            className,
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              className="focus-visible:ring-ring/50 data-[state=open]:bg-muted data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
            >
              <SolidXIcon />
              <span className="sr-only">{closeLabel}</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </div>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex flex-col gap-1.5 text-center sm:text-left",
        // Zoned mode: pinned above the scrolling DialogBody, owns its padding.
        "group-has-data-[slot=dialog-body]/dialog:shrink-0 group-has-data-[slot=dialog-body]/dialog:px-6 group-has-data-[slot=dialog-body]/dialog:pt-6 group-has-data-[slot=dialog-body]/dialog:pb-4",
        className,
      )}
      {...props}
    />
  );
}

/**
 * DialogBody — opt-in scrollable middle zone. Rendering one automatically
 * pins DialogHeader/DialogFooter and moves padding to the zones. Use
 * `asChild` with a `<form>` when the body is a single form, so submit and
 * Enter semantics live on the scroll region.
 */
function DialogBody({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      data-slot="dialog-body"
      className={cn(
        "min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-1 pb-6",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end",
        // Zoned mode: pinned below the scrolling DialogBody with a divider.
        "group-has-data-[slot=dialog-body]/dialog:shrink-0 group-has-data-[slot=dialog-body]/dialog:border-t group-has-data-[slot=dialog-body]/dialog:border-border/80 group-has-data-[slot=dialog-body]/dialog:px-6 group-has-data-[slot=dialog-body]/dialog:py-4",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-display text-base font-medium leading-none tracking-[-0.01em]",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
