import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

const AGENT_TOOLS_TIPS_STORAGE_KEY = "goose:agent-tools-tips-enabled";
const AGENT_TOOLS_TIPS_CHANGED_EVENT = "goose:agent-tools-tips-changed";

const agentToolsTipsPreference = createBooleanLocalStoragePreference({
  storageKey: AGENT_TOOLS_TIPS_STORAGE_KEY,
  changedEvent: AGENT_TOOLS_TIPS_CHANGED_EVENT,
});

export const getAgentToolsTipsEnabled = agentToolsTipsPreference.get;
export const setAgentToolsTipsEnabled = agentToolsTipsPreference.set;
export const useAgentToolsTipsPreference = agentToolsTipsPreference.useValue;
