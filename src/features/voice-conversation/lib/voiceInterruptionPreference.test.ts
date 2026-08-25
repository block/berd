import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultVoiceInterruptionPreference,
  getVoiceInterruptionPreference,
  setVoiceInterruptionPreference,
} from "./voiceInterruptionPreference";

describe("voice interruption preference", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("defaults to automatic with the existing VAD thresholds", () => {
    expect(getDefaultVoiceInterruptionPreference()).toEqual({
      mode: "automatic",
      sensitivity: "balanced",
      speechSensitivity: "more",
    });
    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "automatic",
      sensitivity: "balanced",
      speechSensitivity: "more",
    });
  });

  it("persists the selected mode and sensitivities", () => {
    setVoiceInterruptionPreference({
      mode: "allowInterruptions",
      sensitivity: "more",
      speechSensitivity: "less",
    });

    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "allowInterruptions",
      sensitivity: "more",
      speechSensitivity: "less",
    });
  });

  it("falls back field-by-field for malformed storage", () => {
    window.localStorage.setItem(
      "goose:voice-interruption-preference",
      JSON.stringify({ mode: "preventFeedback", sensitivity: "maximum" }),
    );

    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "preventFeedback",
      sensitivity: "balanced",
      speechSensitivity: "more",
    });
  });

  it("keeps the renderer preference usable when storage writes fail", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    setVoiceInterruptionPreference({
      mode: "preventFeedback",
      sensitivity: "less",
      speechSensitivity: "balanced",
    });

    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "preventFeedback",
      sensitivity: "less",
      speechSensitivity: "balanced",
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
      sensitivity: "less",
      speechSensitivity: "balanced",
    });
    setItem.mockRestore();
    window.localStorage.setItem(
      "goose:voice-interruption-preference",
      JSON.stringify({
        mode: "allowInterruptions",
        sensitivity: "more",
        speechSensitivity: "less",
      }),
    );

    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "allowInterruptions",
      sensitivity: "more",
      speechSensitivity: "less",
    });
  });
});
