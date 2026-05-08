import { ArchiveSettings } from "./ArchiveSettings";
import { DoctorSettings } from "./DoctorSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { VoiceInputSettings } from "./VoiceInputSettings";
import { GeneralSettings } from "./GeneralSettings";
import type { SectionId } from "./settingsSections";
import { PageShell } from "@/shared/ui/page-shell";

interface SettingsViewProps {
  activeSection: SectionId;
}

export function SettingsView({ activeSection }: SettingsViewProps) {
  return (
    <PageShell contentWidth="narrow" contentClassName="gap-0">
      {activeSection === "providers" && <ProvidersSettings />}
      {activeSection === "voice" && <VoiceInputSettings />}
      {activeSection === "doctor" && <DoctorSettings />}
      {activeSection === "general" && <GeneralSettings />}
      {activeSection === "archive" && <ArchiveSettings />}
    </PageShell>
  );
}
