export const HOME_WIDGET_SAVE_CONFIRMED_EVENT =
  "home-widget-save-confirmed" as const;
export const HOME_WIDGET_SAVE_DISCARDED_EVENT =
  "home-widget-save-discarded" as const;
export const HOME_CAMERA_SAVE_CONFIRMED_EVENT =
  "home-camera-save-confirmed" as const;
export const HOME_CAMERA_SAVE_DISCARDED_EVENT =
  "home-camera-save-discarded" as const;

function notify(type: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(type));
}

export function notifyHomeWidgetSaveConfirmed(): void {
  notify(HOME_WIDGET_SAVE_CONFIRMED_EVENT);
}

export function notifyHomeWidgetSaveDiscarded(): void {
  notify(HOME_WIDGET_SAVE_DISCARDED_EVENT);
}

export function notifyHomeCameraSaveConfirmed(): void {
  notify(HOME_CAMERA_SAVE_CONFIRMED_EVENT);
}

export function notifyHomeCameraSaveDiscarded(): void {
  notify(HOME_CAMERA_SAVE_DISCARDED_EVENT);
}
