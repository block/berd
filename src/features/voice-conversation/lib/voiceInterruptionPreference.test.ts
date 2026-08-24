import { beforeEach, describe, expect, it } from "vitest";
import {
  getDefaultVoiceInterruptionPreference,
  getVoiceInterruptionPreference,
  setVoiceInterruptionPreference,
} from "./voiceInterruptionPreference";

describe("voice interruption preference", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to automatic with balanced sensitivity", () => {
    expect(getDefaultVoiceInterruptionPreference()).toEqual({
      mode: "automatic",
      sensitivity: "balanced",
    });
    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "automatic",
      sensitivity: "balanced",
    });
  });

  it("persists the selected mode and sensitivity", () => {
    setVoiceInterruptionPreference({
      mode: "allowInterruptions",
      sensitivity: "more",
    });

    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "allowInterruptions",
      sensitivity: "more",
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
    });
  });
});
