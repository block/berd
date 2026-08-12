import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { buttonVariants } from "@/shared/ui/button";
import { SkillEditor } from "./SkillEditor";
import type { EditingSkill, SkillInfo } from "../api/skills";

interface SkillsDialogsProps {
  dialogOpen: boolean;
  onDialogClose: () => void;
  onSaved: (savedSkill?: SkillInfo) => void | Promise<void>;
  editingSkill?: EditingSkill;
  initialProjectId?: string | null;
  deletingSkill: SkillInfo | null;
  onDeletingSkillChange: (skill: SkillInfo | null) => void;
  onConfirmDelete: () => void | Promise<void>;
  onDeleteFromEditor?: (editingSkill: EditingSkill) => void;
}

export function SkillsDialogs({
  dialogOpen,
  onDialogClose,
  onSaved,
  editingSkill,
  initialProjectId,
  deletingSkill,
  onDeletingSkillChange,
  onConfirmDelete,
  onDeleteFromEditor,
}: SkillsDialogsProps) {
  const { t } = useTranslation(["skills", "common"]);

  return (
    <>
      <SkillEditor
        isOpen={dialogOpen}
        onClose={onDialogClose}
        onSaved={onSaved}
        editingSkill={editingSkill}
        initialProjectId={initialProjectId}
        onDelete={onDeleteFromEditor}
      />

      <AlertDialog
        open={!!deletingSkill}
        onOpenChange={(open) => !open && onDeletingSkillChange(null)}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("view.deleteTitle", { name: deletingSkill?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("view.deleteDescription", {
                name: deletingSkill?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({
                variant: "primary",
                destructive: true,
              })}
              onClick={onConfirmDelete}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
