import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const SESSION_COST_STORAGE_KEY = "goose:session-cost-enabled";
export const SESSION_COST_CHANGED_EVENT = "goose:session-cost-changed";

const sessionCostPreference = createBooleanLocalStoragePreference({
  storageKey: SESSION_COST_STORAGE_KEY,
  changedEvent: SESSION_COST_CHANGED_EVENT,
});

export const getSessionCostEnabled = sessionCostPreference.get;
export const setSessionCostEnabled = sessionCostPreference.set;
export const useSessionCostPreference = sessionCostPreference.useValue;
