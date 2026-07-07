import type * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description: React.ReactNode;
  cancelLabel: React.ReactNode;
  confirmLabel: React.ReactNode;
  loadingLabel?: React.ReactNode;
  isLoading?: boolean;
  /**
   * Danger intent for the confirm action. Defaults to true because most
   * confirmation dialogs guard destructive operations; pass false for
   * neutral confirmations like archiving.
   */
  destructive?: boolean;
  contentClassName?: string;
  overlayClassName?: string;
  positionerClassName?: string;
  onConfirm: () => void | Promise<void>;
  onConfirmError?: (error: unknown) => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel,
  confirmLabel,
  loadingLabel,
  isLoading = false,
  destructive = true,
  contentClassName = "max-w-sm",
  overlayClassName,
  positionerClassName,
  onConfirm,
  onConfirmError,
}: ConfirmDialogProps) {
  const handleConfirm = async () => {
    try {
      await onConfirm();
    } catch (error) {
      onConfirmError?.(error);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isLoading) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent
        className={contentClassName}
        overlayClassName={overlayClassName}
        positionerClassName={positionerClassName}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isLoading}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="primary"
            destructive={destructive}
            disabled={isLoading}
            onClick={() => void handleConfirm()}
          >
            {isLoading && loadingLabel ? loadingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
