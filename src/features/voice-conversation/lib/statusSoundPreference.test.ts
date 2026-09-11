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

  it("defaults to repeating only while working", () => {
    expect(getDefaultStatusSoundPreference()).toEqual({ mode: "working" });
    expect(getStatusSoundPreference()).toEqual(
      getDefaultStatusSoundPreference(),
    );
  });

  it("persists the working-and-waiting mode", () => {
    setStatusSoundPreference({ mode: "working-and-waiting" });
    expect(getStatusSoundPreference()).toEqual({
      mode: "working-and-waiting",
    });
  });

  it("normalizes malformed persisted values", () => {
    window.localStorage.setItem(
      "goose:voice-status-sound-preference",
      JSON.stringify({ mode: "unexpected" }),
    );
    expect(getStatusSoundPreference()).toEqual({ mode: "working" });
  });

  it.each([
    ["continuous", "working-and-waiting"],
    ["continuous-while-working", "working"],
    ["once", "working"],
    ["off", "working"],
  ] as const)("migrates the legacy %s mode to %s", (legacy, expected) => {
    window.localStorage.setItem(
      "goose:voice-status-sound-preference",
      JSON.stringify({ mode: legacy }),
    );
    expect(getStatusSoundPreference()).toEqual({ mode: expected });
  });

  it("notifies runtime subscribers with the applied preference", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToStatusSoundPreference(listener);

    setStatusSoundPreference({ mode: "working-and-waiting" });

    expect(listener).toHaveBeenCalledWith({ mode: "working-and-waiting" });
    unsubscribe();
  });

  it("keeps the renderer preference usable when storage writes fail", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    setStatusSoundPreference({ mode: "working-and-waiting" });
    expect(getStatusSoundPreference()).toEqual({
      mode: "working-and-waiting",
    });
  });
});
