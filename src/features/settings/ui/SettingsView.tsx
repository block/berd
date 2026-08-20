import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppearanceSettings } from "./AppearanceSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { BehaviorSettings } from "./BehaviorSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { NotificationSettings } from "./NotificationSettings";
import { SecuritySettings } from "./SecuritySettings";
import { SystemSettings } from "./SystemSettings";
import type { SectionId } from "./settingsSections";
import { ExperimentsSettings } from "@/features/experiments/ExperimentsSettings";
import { KeyboardShortcutsSettings } from "@/features/shortcuts/ui/KeyboardShortcutsSettings";
import { ConnectionsSettings } from "@/features/connections/ui/ConnectionsSettings";
import { VoiceSettings } from "@/features/voice-conversation/ui/VoiceSettings";
import type { AuthStatus } from "@/features/auth/api/auth";
import { SettingsPane } from "@/shared/ui/SettingsPage";
import type { SetupChatRequest } from "@/features/chat/lib/setupChatRequest";
import type { AgentSetupTroubleshootingRequest } from "@/features/providers/lib/agentSetupTroubleshooting";
import { refreshDoctorReportFreshness } from "@/shared/api/useDoctorReport";
import { useProfileCapability } from "@/shared/profile/capabilities";

interface SettingsViewProps {
  activeSection: SectionId;
  authStatus?: AuthStatus;
  onLoggedOut?: (status: AuthStatus) => void;
  onStartTroubleshootingChat?: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
  onStartConnectionSetupChat?: (request: SetupChatRequest) => void;
  onReturnToAgentDraft?: () => void;
}

// Rev 3 (Aug 10): "general" split into appearance/chat/system/about (see
// settingsSections.ts for the full rationale). Security is now permanent --
// no more securityMl gate at this level; SecuritySettings.tsx gates its own
// ML rows internally.
//
// Rev 5 (Aug 19): "about" is no longer a routable section -- its content
// (app identity, Account, and the embedded Updates card) moved into
// SystemSettings.tsx, under an "About" subhead at the bottom of the page.
//
// Rev 4: Doctor is no longer a routable settings section at all -- it opens
// as a dialog from a row inside SystemSettings.tsx instead (see
// SystemSettings.tsx and DoctorSettings.tsx for the rationale). SettingsView
// still warms the shared doctor report on every Settings visit below, since
// the AI providers page and the Doctor dialog both read that same cache.
export function SettingsView({
  activeSection,
  authStatus,
  onLoggedOut,
  onStartTroubleshootingChat,
  onStartConnectionSetupChat,
  onReturnToAgentDraft,
}: SettingsViewProps) {
  const queryClient = useQueryClient();
  const doctorEnabled = useProfileCapability("doctor");
  const voiceConversationEnabled = useProfileCapability("voiceConversation");

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
      {activeSection === "appearance" && <AppearanceSettings />}
      {activeSection === "behavior" && <BehaviorSettings />}
      {activeSection === "connections" && (
        <ConnectionsSettings onAskAgentToAddMcp={onStartConnectionSetupChat} />
      )}
      {activeSection === "providers" && (
        <ProvidersSettings
          onStartTroubleshootingChat={onStartTroubleshootingChat}
          onReturnToAgentDraft={onReturnToAgentDraft}
        />
      )}
      {activeSection === "notifications" && <NotificationSettings />}
      {activeSection === "shortcuts" && <KeyboardShortcutsSettings />}
      {activeSection === "voice" && voiceConversationEnabled && (
        <VoiceSettings />
      )}
      {activeSection === "archive" && <ArchiveSettings />}
      {activeSection === "security" && <SecuritySettings />}
      {activeSection === "system" && (
        <SystemSettings authStatus={authStatus} onLoggedOut={onLoggedOut} />
      )}
      {activeSection === "experiments" && <ExperimentsSettings />}
    </SettingsPane>
  );
}
