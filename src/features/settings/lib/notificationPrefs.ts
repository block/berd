import {
  DEFAULT_NOTIFICATION_SOUND,
  normalizeNotificationSoundId,
  type NotificationSoundId,
} from "@/shared/notifications/notificationSounds";
import {
  DEFAULT_TOAST_DURATION_SECONDS,
  NEVER_DISMISS_TOAST_DURATION_SECONDS,
  clampTimedToastDurationSeconds,
  clampToastDurationSeconds,
} from "@/shared/notifications/toastDuration";

const STORAGE_KEY = "goose:notifications";

export interface NotificationPrefs {
  enabled: boolean;
  inApp: boolean;
  desktop: boolean;
  inAppSound: NotificationSoundId;
  desktopSound: NotificationSoundId;
  toastDurationSeconds: number;
  /**
   * The most recent *timed* duration the user chose. Restored when leaving
   * never-dismiss mode, including across navigation/remount of the settings
   * surface. Always a timed value (never the never-dismiss sentinel).
   */
  lastTimedToastDurationSeconds: number;
}

const DEFAULTS: NotificationPrefs = {
  enabled: true,
  inApp: true,
  desktop: true,
  inAppSound: DEFAULT_NOTIFICATION_SOUND,
  desktopSound: DEFAULT_NOTIFICATION_SOUND,
  toastDurationSeconds: DEFAULT_TOAST_DURATION_SECONDS,
  lastTimedToastDurationSeconds: DEFAULT_TOAST_DURATION_SECONDS,
};

export function getNotificationPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    const toastDurationSeconds = clampToastDurationSeconds(
      parsed.toastDurationSeconds,
    );
    return {
      ...DEFAULTS,
      ...parsed,
      inAppSound: normalizeNotificationSoundId(parsed.inAppSound),
      desktopSound: normalizeNotificationSoundId(parsed.desktopSound),
      toastDurationSeconds,
      // Older stored prefs predate this field; derive it from the active
      // timed duration so restoration behaves sensibly after upgrade.
      lastTimedToastDurationSeconds: clampTimedToastDurationSeconds(
        parsed.lastTimedToastDurationSeconds ??
          (toastDurationSeconds !== NEVER_DISMISS_TOAST_DURATION_SECONDS
            ? toastDurationSeconds
            : undefined),
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
