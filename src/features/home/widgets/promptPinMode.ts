export type PromptPinMode = "edit" | "ready";

/**
 * The catalog sizes a pin's frame from this, so it has to agree with what
 * PromptPinWidget renders. Only the persisted `mode` decides: the widget
 * writes it on every transition, so the two cannot disagree.
 *
 * Deliberately does NOT infer the mode from saved text. Text is persisted on a
 * debounce while the editor is open, so inferring "has text ⇒ ready" collapsed
 * the frame to the one-row ready height on the first keystroke in the textarea,
 * clipping the editor inside `overflow-hidden` and leaving the pin unusable.
 *
 * A pin with no mode yet opens in the editor. That is the recoverable
 * direction — the worst case is one extra Done click, where guessing "ready"
 * can strand an in-progress edit.
 */
export function promptPinMode(
  state: Record<string, unknown> | undefined,
): PromptPinMode {
  return state?.mode === "ready" ? "ready" : "edit";
}
