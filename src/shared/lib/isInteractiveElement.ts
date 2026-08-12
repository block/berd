/**
 * Matches an element that behaves as an interactive control: native
 * form/link elements, ARIA widgets, editable content, or anything a caller
 * has explicitly opted in with `data-interactive`.
 *
 * A surface that reacts to blank clicks (e.g. a composer that focuses its
 * textarea when you click empty chrome) uses this to avoid stealing the
 * click or focus from a real control nested inside it.
 *
 * Escape hatch: add `data-interactive` (or `data-interactive="true"`) to an
 * element to have it treated as interactive without matching a standard tag
 * or role. `data-interactive="false"` opts back out. Prefer the attribute
 * over extending this list for bespoke inline controls.
 */
const INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='link']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='textbox']",
  "[data-interactive]:not([data-interactive='false'])",
].join(", ");

export function isInteractiveElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}
