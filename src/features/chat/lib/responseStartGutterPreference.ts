import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const RESPONSE_START_GUTTER_STORAGE_KEY =
  "goose:response-start-gutter-enabled";
export const RESPONSE_START_GUTTER_CHANGED_EVENT =
  "goose:response-start-gutter-changed";

const responseStartGutterPreference = createBooleanLocalStoragePreference({
  storageKey: RESPONSE_START_GUTTER_STORAGE_KEY,
  changedEvent: RESPONSE_START_GUTTER_CHANGED_EVENT,
  defaultValue: false,
});

export const getResponseStartGutterEnabled = responseStartGutterPreference.get;
export const setResponseStartGutterEnabled = responseStartGutterPreference.set;
export const useResponseStartGutterPreference =
  responseStartGutterPreference.useValue;
