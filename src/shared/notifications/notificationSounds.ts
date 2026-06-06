export const SILENT_NOTIFICATION_SOUND = "silent";
export const DEFAULT_NOTIFICATION_SOUND = "goose-sounds-4.mp3";

export const NOTIFICATION_SOUNDS = [
  {
    id: DEFAULT_NOTIFICATION_SOUND,
    labelKey: "notifications.sounds.politeHonk",
    resource: "goose-sounds-4.mp3",
    url: new URL("../../../resources/goose-sounds-4.mp3", import.meta.url).href,
  },
  {
    id: "goose-sounds-0.mp3",
    labelKey: "notifications.sounds.quickPeep",
    resource: "goose-sounds-0.mp3",
    url: new URL("../../../resources/goose-sounds-0.mp3", import.meta.url).href,
  },
  {
    id: "goose-sounds-1.mp3",
    labelKey: "notifications.sounds.youHaveGotGoose",
    resource: "goose-sounds-1.mp3",
    url: new URL("../../../resources/goose-sounds-1.mp3", import.meta.url).href,
  },
  {
    id: "goose-sounds-2.mp3",
    labelKey: "notifications.sounds.dingDongGoose",
    resource: "goose-sounds-2.mp3",
    url: new URL("../../../resources/goose-sounds-2.mp3", import.meta.url).href,
  },
  {
    id: "goose-sounds-3.mp3",
    labelKey: "notifications.sounds.paidInBread",
    resource: "goose-sounds-3.mp3",
    url: new URL("../../../resources/goose-sounds-3.mp3", import.meta.url).href,
  },
  {
    id: "goose-sounds-5.mp3",
    labelKey: "notifications.sounds.beakYeah",
    resource: "goose-sounds-5.mp3",
    url: new URL("../../../resources/goose-sounds-5.mp3", import.meta.url).href,
  },
  {
    id: "goose-sounds-6.mp3",
    labelKey: "notifications.sounds.badNewsBird",
    resource: "goose-sounds-6.mp3",
    url: new URL("../../../resources/goose-sounds-6.mp3", import.meta.url).href,
  },
] as const;

export type NotificationSoundId =
  | typeof SILENT_NOTIFICATION_SOUND
  | (typeof NOTIFICATION_SOUNDS)[number]["id"];

export function isNotificationSoundId(
  sound: unknown,
): sound is NotificationSoundId {
  return (
    sound === SILENT_NOTIFICATION_SOUND ||
    NOTIFICATION_SOUNDS.some((item) => item.id === sound)
  );
}

export function normalizeNotificationSoundId(
  sound: unknown,
): NotificationSoundId {
  return isNotificationSoundId(sound) ? sound : DEFAULT_NOTIFICATION_SOUND;
}

export function getNotificationSoundResource(
  sound: NotificationSoundId,
): string | undefined {
  if (sound === SILENT_NOTIFICATION_SOUND) return undefined;
  return NOTIFICATION_SOUNDS.find((item) => item.id === sound)?.resource;
}

export function playNotificationSound(sound: NotificationSoundId): void {
  if (sound === SILENT_NOTIFICATION_SOUND || typeof Audio === "undefined") {
    return;
  }

  const url = NOTIFICATION_SOUNDS.find((item) => item.id === sound)?.url;
  if (!url) return;

  void new Audio(url).play().catch(() => {});
}
