import { useTranslation } from "react-i18next";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsSections } from "@/shared/ui/settings-section";
import { ArchivedChatsSection } from "./ArchivedChatsSection";
import { ArchivedProjectsSection } from "./ArchivedProjectsSection";
import { AutoArchiveChatsSection } from "./AutoArchiveChatsSection";

export function ArchiveSettings() {
  const { t } = useTranslation("settings");

  return (
    <SettingsPage title={t("archive.title")}>
      <SettingsSections>
        <AutoArchiveChatsSection />
        <ArchivedProjectsSection />
        <ArchivedChatsSection />
      </SettingsSections>
    </SettingsPage>
  );
}
