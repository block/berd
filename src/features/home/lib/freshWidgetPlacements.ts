/**
 * Transient, session-local registry of widget instances that were just
 * created interactively (pinning, widget picker). Widgets consume their
 * entry once on first mount to play a placement animation — reloading the
 * layout or returning to Home must not replay it, so nothing here persists.
 */
const freshPlacements = new Set<string>();

export function markFreshWidgetPlacement(id: string): void {
  freshPlacements.add(id);
}

/**
 * Pure read — safe to call from render (e.g. a useState initializer, which
 * StrictMode runs twice). Pair with consumeFreshWidgetPlacement in a mount
 * effect so the one-shot entry survives discarded renders.
 */
export function hasFreshWidgetPlacement(id: string): boolean {
  return freshPlacements.has(id);
}

/** Clears the one-shot entry. Call from an effect, not during render. */
export function consumeFreshWidgetPlacement(id: string): void {
  freshPlacements.delete(id);
}
