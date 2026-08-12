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

export interface AgentBuilderLeaveDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onDiscard: () => void;
  onKeep: () => void;
}

export function AgentBuilderLeaveDraftDialog({
  open,
  onOpenChange,
  onCancel,
  onDiscard,
  onKeep,
}: AgentBuilderLeaveDraftDialogProps) {
  const { t } = useTranslation(["agents"]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("builderRail.leaveDraftTitle")}</DialogTitle>
          <DialogDescription>
            {t("builderRail.leaveDraftBody")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("builderRail.leaveDraftCancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            destructive
            onClick={onDiscard}
          >
            {t("builderRail.leaveDraftDiscard")}
          </Button>
          <Button type="button" onClick={onKeep}>
            {t("builderRail.leaveDraftSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
