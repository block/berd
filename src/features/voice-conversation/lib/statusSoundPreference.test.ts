import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultStatusSoundPreference,
  getStatusSoundPreference,
  setStatusSoundPreference,
  subscribeToStatusSoundPreference,
} from "./statusSoundPreference";

describe("status sound preference", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("defaults to working pulses and one waiting cue", () => {
    expect(getDefaultStatusSoundPreference()).toEqual({
      mode: "continuous-while-working",
      volume: 0.4,
    });
    expect(getStatusSoundPreference()).toEqual(
      getDefaultStatusSoundPreference(),
    );
  });

  it("persists mode and volume", () => {
    setStatusSoundPreference({ mode: "once", volume: 0.65 });
    expect(getStatusSoundPreference()).toEqual({ mode: "once", volume: 0.65 });
  });

  it("normalizes malformed persisted values", () => {
    window.localStorage.setItem(
      "goose:voice-status-sound-preference",
      JSON.stringify({ mode: "unexpected", volume: 4 }),
    );
    expect(getStatusSoundPreference()).toEqual({
      mode: "continuous-while-working",
      volume: 1,
    });
  });

  it("notifies runtime subscribers with the applied preference", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToStatusSoundPreference(listener);

    setStatusSoundPreference({ mode: "continuous", volume: 0.7 });

    expect(listener).toHaveBeenCalledWith({ mode: "continuous", volume: 0.7 });
    unsubscribe();
  });

  it("keeps the renderer preference usable when storage writes fail", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    setStatusSoundPreference({ mode: "off", volume: 0.2 });
    expect(getStatusSoundPreference()).toEqual({ mode: "off", volume: 0.2 });
  });
});
