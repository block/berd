import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";

interface SessionWorkspaceCleanupDialogProps {
  open: boolean;
  worktreeCount: number;
  branchCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

function cleanupResourceKind(worktreeCount: number, branchCount: number) {
  if (worktreeCount > 0 && branchCount > 0) return "worktreesAndBranches";
  if (worktreeCount > 0) return "worktrees";
  return "branches";
}

export function SessionWorkspaceCleanupDialog({
  open,
  worktreeCount,
  branchCount,
  onCancel,
  onConfirm,
}: SessionWorkspaceCleanupDialogProps) {
  const { t } = useTranslation(["chat", "common"]);
  const resourceKind = cleanupResourceKind(worktreeCount, branchCount);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
      title={t(`chat:gitCleanup.archiveConfirmTitle.${resourceKind}`)}
      description={t(
        `chat:gitCleanup.archiveConfirmDescriptionWithFiles.${resourceKind}`,
      )}
      cancelLabel={t("common:actions.cancel")}
      confirmLabel={t("chat:gitCleanup.archiveConfirmAction")}
      destructive
      onConfirm={onConfirm}
    />
  );
}
