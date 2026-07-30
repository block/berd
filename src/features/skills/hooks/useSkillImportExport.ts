import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { useFileImportZone } from "@/shared/hooks/useFileImportZone";
import { exportSkill, importSkills, type SkillInfo } from "../api/skills";
import { downloadExport } from "../lib/skillsHelpers";

export function useSkillImportExport() {
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

  const handleImport = async (fileBytes: number[], fileName: string) => {
    try {
      await importSkills(fileBytes, fileName);
      toast.success(t("view.importSuccess"));
    } catch (error) {
      toast.error(formatAcpErrorMessage(error, t("view.importError")));
    }
  };

  const fileImport = useFileImportZone({ onImportFile: handleImport });

  return { ...fileImport, handleExport };
}
