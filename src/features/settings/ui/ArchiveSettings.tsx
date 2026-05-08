import { useTranslation } from "react-i18next";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { ArchivedChatsSection } from "./ArchivedChatsSection";
import { ArchivedProjectsSection } from "./ArchivedProjectsSection";

export function ArchiveSettings() {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <SettingsPage title={t("archive.title")} contentClassName="space-y-8">
      <ArchivedProjectsSection />
      <ArchivedChatsSection />
    </SettingsPage>
  );
}
