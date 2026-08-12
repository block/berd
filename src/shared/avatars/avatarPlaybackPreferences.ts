import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

const ANIMATED_AVATARS_STORAGE_KEY = "goose:animated-avatars-enabled";
export const ANIMATED_AVATARS_CHANGED_EVENT = "goose:animated-avatars-changed";

const animatedAvatarsPreference = createBooleanLocalStoragePreference({
  storageKey: ANIMATED_AVATARS_STORAGE_KEY,
  changedEvent: ANIMATED_AVATARS_CHANGED_EVENT,
});

export const getAnimatedAvatarsEnabled = animatedAvatarsPreference.get;
export const setAnimatedAvatarsEnabled = animatedAvatarsPreference.set;
export const useAnimatedAvatarsPreference = animatedAvatarsPreference.useValue;
