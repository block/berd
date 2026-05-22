import { SettingsPage } from "@/shared/ui/SettingsPage";
import { ArchivedChatsSection } from "./ArchivedChatsSection";
import { ArchivedProjectsSection } from "./ArchivedProjectsSection";

export function ArchiveSettings() {
  return (
    <SettingsPage contentClassName="space-y-8">
      <ArchivedProjectsSection />
      <ArchivedChatsSection />
    </SettingsPage>
  );
}
