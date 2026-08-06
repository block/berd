import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArchiveSettings } from "./ArchiveSettings";
import { DoctorSettings } from "./DoctorSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { GeneralSettings } from "./GeneralSettings";
import { NotificationSettings } from "./NotificationSettings";
import { SecuritySettings } from "./SecuritySettings";
import type { SectionId } from "./settingsSections";
import { ExperimentsSettings } from "@/features/experiments/ExperimentsSettings";
import { KeyboardShortcutsSettings } from "@/features/shortcuts/ui/KeyboardShortcutsSettings";
import { UpdatesSettings } from "@/features/updates/ui/UpdatesSettings";
import { ConnectionsSettings } from "@/features/connections/ui/ConnectionsSettings";
import { VoiceSettings } from "@/features/voice-conversation/ui/VoiceSettings";
import type { AuthStatus } from "@/features/auth/api/auth";
import { SettingsPane } from "@/shared/ui/SettingsPage";
import type { AgentSetupTroubleshootingRequest } from "@/features/providers/lib/agentSetupTroubleshooting";
import { refreshDoctorReportFreshness } from "@/shared/api/useDoctorReport";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";

interface SettingsViewProps {
  activeSection: SectionId;
  authStatus?: AuthStatus;
  onLoggedOut?: (status: AuthStatus) => void;
  onStartTroubleshootingChat?: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
  onReturnToAgentDraft?: () => void;
}

export function SettingsView({
  activeSection,
  authStatus,
  onLoggedOut,
  onStartTroubleshootingChat,
  onReturnToAgentDraft,
}: SettingsViewProps) {
  const queryClient = useQueryClient();
  const doctorEnabled = useProfileCapability("doctor");
  const updatesEnabled = useProfileCapability("updates");
  const voiceConversationEnabled = useProfileCapability("voiceConversation");
  const securityMlEnabled = getBuildFeatureState().securityMl;

  // Warm the shared doctor report once per Settings visit. SettingsView mounts
  // whenever Settings opens (every entry path: sidebar, restored URL, returning
  // from design-system), so the Doctor and AI providers detail pages consume an
  // already-warming cache instead of each kicking off its own `run_doctor`.
  //
  // `refreshDoctorReportFreshness` first runs the fast, offline status read
  // (`ensureQueryData`, deduped + staleTime-respecting, so a re-open within the
  // window is a no-op) to paint immediately, then runs the slower
  // network-touching freshness pass off that path and seeds version/update
  // badges into the same cache entry without blocking first paint.
  useEffect(() => {
    if (!doctorEnabled) {
      return;
    }
    void refreshDoctorReportFreshness(queryClient);
  }, [doctorEnabled, queryClient]);

  return (
    <SettingsPane>
      {activeSection === "connections" && <ConnectionsSettings />}
      {activeSection === "providers" && (
        <ProvidersSettings
          onStartTroubleshootingChat={onStartTroubleshootingChat}
          onReturnToAgentDraft={onReturnToAgentDraft}
        />
      )}
      {activeSection === "doctor" && doctorEnabled && <DoctorSettings />}
      {activeSection === "experiments" && <ExperimentsSettings />}
      {activeSection === "general" && (
        <GeneralSettings authStatus={authStatus} onLoggedOut={onLoggedOut} />
      )}
      {activeSection === "security" && securityMlEnabled && (
        <SecuritySettings />
      )}
      {activeSection === "notifications" && <NotificationSettings />}
      {activeSection === "voice" && voiceConversationEnabled && (
        <VoiceSettings />
      )}
      {activeSection === "shortcuts" && <KeyboardShortcutsSettings />}
      {activeSection === "archive" && <ArchiveSettings />}
      {activeSection === "updates" && updatesEnabled && <UpdatesSettings />}
    </SettingsPane>
  );
}
