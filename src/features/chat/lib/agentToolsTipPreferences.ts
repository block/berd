import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";
import {
  getProfileCapabilitySnapshot,
  useProfileCapability,
} from "@/shared/profile/capabilities";

const AGENT_TOOLS_TIPS_STORAGE_KEY = "goose:agent-tools-tips-enabled";
const AGENT_TOOLS_TIPS_CHANGED_EVENT = "goose:agent-tools-tips-changed";

const agentToolsTipsPreference = createBooleanLocalStoragePreference({
  storageKey: AGENT_TOOLS_TIPS_STORAGE_KEY,
  changedEvent: AGENT_TOOLS_TIPS_CHANGED_EVENT,
});

function getAgentToolsTipsCapability() {
  return getProfileCapabilitySnapshot("agentTools");
}

export function getAgentToolsTipsEnabled() {
  return getAgentToolsTipsCapability() && agentToolsTipsPreference.get();
}

export function setAgentToolsTipsEnabled(enabled: boolean) {
  if (getAgentToolsTipsCapability()) {
    agentToolsTipsPreference.set(enabled);
  }
}

export function useAgentToolsTipsPreference() {
  const preference = agentToolsTipsPreference.useValue();
  const enabledByRuntimeConfig = useProfileCapability("agentTools");
  if (enabledByRuntimeConfig) {
    return preference;
  }

  return {
    enabled: false,
    setEnabled: () => undefined,
  };
}
