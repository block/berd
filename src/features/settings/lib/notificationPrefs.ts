const STORAGE_KEY = "goose:notifications";

export interface NotificationPrefs {
  enabled: boolean;
  inApp: boolean;
  desktop: boolean;
}

const DEFAULTS: NotificationPrefs = {
  enabled: true,
  inApp: true,
  desktop: true,
};

export function getNotificationPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
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
