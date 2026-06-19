export const OPEN_SETTINGS_EVENT = "goose:open-settings";

export interface AgentBuilderProviderSetupReturnTarget {
  type: "agent-builder-provider-setup";
  sessionId: string;
  providerId: string;
}

export type OpenConnectionsTab =
  | "companyManaged"
  | "custom"
  | "gooseCapabilities";

export interface OpenSettingsEventDetail {
  section?: string;
  connectionsTab?: OpenConnectionsTab;
  returnTarget?: AgentBuilderProviderSetupReturnTarget;
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
  if (detail.connectionsTab) {
    eventDetail.connectionsTab = detail.connectionsTab;
  }
  if (detail.returnTarget) {
    eventDetail.returnTarget = detail.returnTarget;
  }

  window.dispatchEvent(
    new CustomEvent(OPEN_SETTINGS_EVENT, {
      detail:
        section || detail.connectionsTab || detail.returnTarget
          ? eventDetail
          : undefined,
    }),
  );
}
