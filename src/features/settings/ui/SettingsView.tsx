import { ArchiveSettings } from "./ArchiveSettings";
import { DoctorSettings } from "./DoctorSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { GeneralSettings } from "./GeneralSettings";
import type { SectionId } from "./settingsSections";
import {
  ConnectionsSettings,
  type ConnectionsTab,
} from "@/features/connections/ui/ConnectionsSettings";
import { UpdatesSettings } from "@/features/updates/ui/UpdatesSettings";
import { PageShell } from "@/shared/ui/page-shell";
import type { AgentSetupTroubleshootingRequest } from "@/features/providers/lib/agentSetupTroubleshooting";

interface SettingsViewProps {
  activeSection: SectionId;
  activeConnectionsTab: ConnectionsTab;
  onConnectionsTabChange: (tab: ConnectionsTab) => void;
  onStartTroubleshootingChat?: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
  onReturnToAgentDraft?: () => void;
}

export function SettingsView({
  activeSection,
  activeConnectionsTab,
  onConnectionsTabChange,
  onStartTroubleshootingChat,
  onReturnToAgentDraft,
}: SettingsViewProps) {
  return (
    <PageShell contentWidth="narrow" contentClassName="gap-0">
      {activeSection === "providers" && (
        <ProvidersSettings
          onStartTroubleshootingChat={onStartTroubleshootingChat}
          onReturnToAgentDraft={onReturnToAgentDraft}
        />
      )}
      {activeSection === "connections" && (
        <ConnectionsSettings
          activeTab={activeConnectionsTab}
          onActiveTabChange={onConnectionsTabChange}
        />
      )}
      {activeSection === "doctor" && <DoctorSettings />}
      {activeSection === "general" && <GeneralSettings />}
      {activeSection === "archive" && <ArchiveSettings />}
      {activeSection === "updates" && <UpdatesSettings />}
    </PageShell>
  );
}
