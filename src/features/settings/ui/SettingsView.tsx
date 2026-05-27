import { ArchiveSettings } from "./ArchiveSettings";
import { DoctorSettings } from "./DoctorSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { GeneralSettings } from "./GeneralSettings";
import type { SectionId } from "./settingsSections";
import { ConnectionsSettings } from "@/features/connections/ui/ConnectionsSettings";
import { ExtensionsSettings } from "@/features/extensions/ui/ExtensionsSettings";
import { UpdatesSettings } from "@/features/updates/ui/UpdatesSettings";
import { PageShell } from "@/shared/ui/page-shell";

interface SettingsViewProps {
  activeSection: SectionId;
}

export function SettingsView({ activeSection }: SettingsViewProps) {
  return (
    <PageShell contentWidth="narrow" contentClassName="gap-0">
      {activeSection === "providers" && <ProvidersSettings />}
      {activeSection === "extensions" && <ExtensionsSettings />}
      {activeSection === "connections" && <ConnectionsSettings />}
      {activeSection === "doctor" && <DoctorSettings />}
      {activeSection === "general" && <GeneralSettings />}
      {activeSection === "archive" && <ArchiveSettings />}
      {activeSection === "updates" && <UpdatesSettings />}
    </PageShell>
  );
}
