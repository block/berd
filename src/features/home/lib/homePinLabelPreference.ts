import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

const HOME_PIN_LABELS_STORAGE_KEY = "goose:home-pin-labels-always-visible";
const HOME_PIN_LABELS_CHANGED_EVENT = "goose:home-pin-labels-changed";

// Hover-only labels are the historical default; opting in keeps pinned agent
// and project names always visible on the home screen.
const homePinLabelPreference = createBooleanLocalStoragePreference({
  storageKey: HOME_PIN_LABELS_STORAGE_KEY,
  changedEvent: HOME_PIN_LABELS_CHANGED_EVENT,
  defaultValue: false,
});

export const getHomePinLabelsAlwaysVisible = homePinLabelPreference.get;
export const setHomePinLabelsAlwaysVisible = homePinLabelPreference.set;
export const useHomePinLabelsPreference = homePinLabelPreference.useValue;
