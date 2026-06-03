import type * as React from "react";

import { cn } from "@/shared/lib/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

/**
 * EditDialog — shared chrome primitive for create/edit modals.
 *
 * Codifies the column-layout pattern that every create/edit modal in the app
 * consumes: a sticky compact header, a scrollable body that owns the form,
 * and a `border-t`-divided footer pinned to the bottom. All padding and
 * geometry comes from tokens (`rounded-md`, `--card` via the
 * dialog default) — feature code only owns the content.
 *
 * Usage:
 *
 *   <EditDialog open={isOpen} onOpenChange={...}>
 *     <EditDialogContent>
 *       <EditDialogHeader title="New project" description="Optional" />
 *       <EditDialogBody>
 *         <form id="project-form" onSubmit={...}>...</form>
 *       </EditDialogBody>
 *       <EditDialogFooter>
 *         <Button type="button" variant="ghost" size="sm" onClick={onClose}>
 *           Cancel
 *         </Button>
 *         <Button type="submit" form="project-form" size="sm">Save</Button>
 *       </EditDialogFooter>
 *     </EditDialogContent>
 *   </EditDialog>
 *
 * Width preset via `size`: "md" (max-w-md) | "lg" (max-w-lg, default) | "xl"
 * (max-w-2xl, for dense provider/extension forms).
 */

type EditDialogSize = "md" | "lg" | "xl";

const SIZE_TO_MAX_W: Record<EditDialogSize, string> = {
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

function EditDialog({ ...props }: React.ComponentProps<typeof Dialog>) {
  return <Dialog {...props} />;
}

interface EditDialogContentProps
  extends React.ComponentProps<typeof DialogContent> {
  size?: EditDialogSize;
}

function EditDialogContent({
  className,
  size = "lg",
  children,
  ...props
}: EditDialogContentProps) {
  return (
    <DialogContent
      className={cn(
        // Reset shadcn defaults the Dialog primitive applies (gap-4, p-6),
        // then re-establish the create/edit column layout.
        "flex max-h-[85vh] flex-col gap-0 overflow-hidden bg-popover p-0",
        SIZE_TO_MAX_W[size],
        className,
      )}
      {...props}
    >
      {children}
    </DialogContent>
  );
}

type EditDialogHeaderProps = Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
};

function EditDialogHeader({
  title,
  description,
  className,
  children,
  ...props
}: EditDialogHeaderProps) {
  return (
    <DialogHeader className={cn("shrink-0 px-5 py-4", className)} {...props}>
      <DialogTitle className="text-sm">{title}</DialogTitle>
      {description ? (
        <DialogDescription className="text-xs">{description}</DialogDescription>
      ) : null}
      {children}
    </DialogHeader>
  );
}

function EditDialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="edit-dialog-body"
      className={cn(
        "min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5",
        className,
      )}
      {...props}
    />
  );
}

/**
 * EditDialogForm — scrollable form body. Use this when the modal's body is a
 * single form; the form element itself owns the scroll region so submit
 * semantics, focus, and Enter-to-submit behave correctly.
 */
function EditDialogForm({ className, ...props }: React.ComponentProps<"form">) {
  return (
    <form
      data-slot="edit-dialog-form"
      className={cn(
        "min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5",
        className,
      )}
      {...props}
    />
  );
}

function EditDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <DialogFooter
      className={cn("shrink-0 border-t border-border/80 px-5 py-4", className)}
      {...props}
    />
  );
}

export {
  EditDialog,
  EditDialogBody,
  EditDialogContent,
  EditDialogFooter,
  EditDialogForm,
  EditDialogHeader,
};
