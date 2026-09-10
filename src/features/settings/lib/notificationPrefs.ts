import {
  DEFAULT_NOTIFICATION_SOUND,
  normalizeNotificationSoundId,
  type NotificationSoundId,
} from "@/shared/notifications/notificationSounds";
import {
  DEFAULT_TOAST_DURATION_SECONDS,
  clampToastDurationSeconds,
} from "@/shared/notifications/toastDuration";

const STORAGE_KEY = "goose:notifications";

// Re-exported so existing settings-feature imports keep working; the
// canonical contract (bounds, sentinel, clamp) lives in the shared
// notifications domain since CompletionNotificationToast (shared) also
// depends on it and shouldn't depend on a feature module.
export {
  DEFAULT_TOAST_DURATION_SECONDS,
  MIN_TOAST_DURATION_SECONDS,
  MAX_TOAST_DURATION_SECONDS,
  NEVER_DISMISS_TOAST_DURATION_SECONDS,
  clampToastDurationSeconds,
} from "@/shared/notifications/toastDuration";

export interface NotificationPrefs {
  enabled: boolean;
  inApp: boolean;
  desktop: boolean;
  inAppSound: NotificationSoundId;
  desktopSound: NotificationSoundId;
  toastDurationSeconds: number;
}

const DEFAULTS: NotificationPrefs = {
  enabled: true,
  inApp: true,
  desktop: true,
  inAppSound: DEFAULT_NOTIFICATION_SOUND,
  desktopSound: DEFAULT_NOTIFICATION_SOUND,
  toastDurationSeconds: DEFAULT_TOAST_DURATION_SECONDS,
};

export function getNotificationPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      ...DEFAULTS,
      ...parsed,
      inAppSound: normalizeNotificationSoundId(parsed.inAppSound),
      desktopSound: normalizeNotificationSoundId(parsed.desktopSound),
      toastDurationSeconds: clampToastDurationSeconds(
        parsed.toastDurationSeconds,
      ),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setNotificationPrefs(prefs: Partial<NotificationPrefs>): void {
  try {
    const current = getNotificationPrefs();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...prefs }));
  } catch {
    // localStorage unavailable in some environments
  }
}
