export type ClockMode = "analog" | "digital";

export interface ClockWidgetState {
  mode?: ClockMode;
}

/** Reads the persisted clock mode; anything other than "digital" is analog. */
export function clockModeOf(instance: {
  state?: Record<string, unknown>;
}): ClockMode {
  return instance.state?.mode === "digital" ? "digital" : "analog";
}
