export const OPEN_SETTINGS_EVENT = "goose:open-settings";

export interface AgentBuilderProviderSetupReturnTarget {
  type: "agent-builder-provider-setup";
  sessionId: string;
  providerId: string;
}

export interface VoiceSetupReturnTarget {
  type: "voice-setup";
  sessionId: string;
}

export interface OpenSettingsEventDetail {
  section?: string;
  returnTarget?: AgentBuilderProviderSetupReturnTarget | VoiceSetupReturnTarget;
}

export function requestOpenSettings(
  section?: string,
  detail: Omit<OpenSettingsEventDetail, "section"> = {},
) {
  if (typeof window === "undefined") {
    return;
  }

  const eventDetail: OpenSettingsEventDetail = {};
  if (section) {
    eventDetail.section = section;
  }
  if (detail.returnTarget) {
    eventDetail.returnTarget = detail.returnTarget;
  }

  window.dispatchEvent(
    new CustomEvent(OPEN_SETTINGS_EVENT, {
      detail: section || detail.returnTarget ? eventDetail : undefined,
    }),
  );
}
