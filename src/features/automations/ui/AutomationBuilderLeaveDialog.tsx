import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

export interface AutomationBuilderLeaveDialogProps {
  open: boolean;
  isSaving?: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function AutomationBuilderLeaveDialog({
  open,
  isSaving = false,
  onOpenChange,
  onCancel,
  onDiscard,
  onSave,
}: AutomationBuilderLeaveDialogProps) {
  const { t } = useTranslation("automations");

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSaving) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("builder.leaveTitle")}</DialogTitle>
          <DialogDescription>{t("builder.leaveBody")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={isSaving}
            onClick={onCancel}
          >
            {t("builder.leaveCancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            destructive
            disabled={isSaving}
            onClick={onDiscard}
          >
            {t("builder.leaveDiscard")}
          </Button>
          <Button type="button" disabled={isSaving} onClick={onSave}>
            {isSaving ? t("builder.saving") : t("builder.leaveSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
