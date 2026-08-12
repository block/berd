export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const element = target.closest(
    "input, textarea, select, [contenteditable=''], [contenteditable='true']",
  );
  if (!element) {
    return false;
  }

  if (element.closest(".xterm")) {
    return false;
  }

  if (element instanceof HTMLInputElement) {
    return element.type !== "button" && element.type !== "submit";
  }

  return true;
}
