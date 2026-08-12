import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { useFileImportZone } from "@/shared/hooks/useFileImportZone";
import {
  exportSkill,
  importSkills,
  isSkillImportFileName,
  type SkillInfo,
} from "../api/skills";
import { downloadExport } from "../lib/skillsHelpers";

const MAX_SKILL_IMPORT_BYTES = 10 * 1024 * 1024;

function validateSkillImportFile(
  file: Pick<File, "name" | "type" | "size">,
): string | null {
  return isSkillImportFileName(file.name)
    ? null
    : "view.importDialog.unsupportedFile";
}

export function useSkillImportExport({
  onImportSuccess,
}: {
  onImportSuccess?: () => void;
} = {}) {
  const { t } = useTranslation(["skills"]);

  const handleExport = async (skill: SkillInfo) => {
    if (skill.readonly) {
      return;
    }

    try {
      const result = await exportSkill(skill.path);
      downloadExport(result.json, result.filename);
      toast.success(t("view.exportedTo", { filename: result.filename }));
    } catch (error) {
      toast.error(formatAcpErrorMessage(error, t("view.exportError")));
    }
  };

  const handleImport = async (fileBytes: Uint8Array, fileName: string) => {
    try {
      await importSkills(Array.from(fileBytes), fileName);
      toast.success(t("view.importSuccess"));
      onImportSuccess?.();
    } catch (error) {
      toast.error(formatAcpErrorMessage(error, t("view.importError")));
    }
  };

  const fileImport = useFileImportZone({
    onImportFile: handleImport,
    validateFile: (file) => {
      const errorKey = validateSkillImportFile(file);
      return errorKey ? t(errorKey) : null;
    },
    onImportError: (message) => toast.error(message),
    maxBytes: MAX_SKILL_IMPORT_BYTES,
    fileTooLargeMessage: t("view.importDialog.fileTooLarge"),
  });

  return { ...fileImport, handleExport };
}
