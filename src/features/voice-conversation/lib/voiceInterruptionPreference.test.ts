import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIXED_INTERRUPTION_SENSITIVITY,
  getDefaultVoiceInterruptionPreference,
  getVoiceInterruptionPreference,
  setVoiceInterruptionPreference,
} from "./voiceInterruptionPreference";

describe("voice interruption preference", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("defaults to automatic", () => {
    expect(FIXED_INTERRUPTION_SENSITIVITY).toBe("less");
    expect(getDefaultVoiceInterruptionPreference()).toEqual({
      mode: "automatic",
    });
    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "automatic",
    });
  });

  it("persists the selected mode", () => {
    setVoiceInterruptionPreference({
      mode: "allowInterruptions",
    });

    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "allowInterruptions",
    });
  });

  it("ignores retired sensitivity fields in storage", () => {
    window.localStorage.setItem(
      "goose:voice-interruption-preference",
      JSON.stringify({ mode: "preventFeedback", sensitivity: "maximum" }),
    );

    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "preventFeedback",
    });
  });

  it("keeps the renderer preference usable when storage writes fail", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    setVoiceInterruptionPreference({
      mode: "preventFeedback",
    });

    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "preventFeedback",
    });
  });

  it("accepts a newer persisted value after a failed write", () => {
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("storage unavailable");
      });

    setVoiceInterruptionPreference({
      mode: "preventFeedback",
    });
    setItem.mockRestore();
    window.localStorage.setItem(
      "goose:voice-interruption-preference",
      JSON.stringify({
        mode: "allowInterruptions",
      }),
    );

    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "allowInterruptions",
    });
  });
});
