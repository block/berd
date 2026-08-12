import { persistStarterTaskCompletion } from "./starterTaskProgress";

export const OPEN_STARTER_WIDGET_PICKER_EVENT =
  "berd:home:open-starter-widget-picker";
export const STARTER_WIDGET_ADDED_EVENT = "berd:home:starter-widget-added";

let starterWidgetPickerRequested = false;

export function requestStarterWidgetPicker(): void {
  starterWidgetPickerRequested = true;
  window.dispatchEvent(new Event(OPEN_STARTER_WIDGET_PICKER_EVENT));
}

export function hasStarterWidgetPickerRequest(): boolean {
  return starterWidgetPickerRequested;
}

export function resetStarterWidgetPickerRequestForTests(): void {
  starterWidgetPickerRequested = false;
}

export function consumeStarterWidgetPickerRequest(): boolean {
  if (!starterWidgetPickerRequested) return false;
  starterWidgetPickerRequested = false;
  return true;
}

export function notifyStarterWidgetAdded(): void {
  persistStarterTaskCompletion("add-widget");
  window.dispatchEvent(new Event(STARTER_WIDGET_ADDED_EVENT));
}
