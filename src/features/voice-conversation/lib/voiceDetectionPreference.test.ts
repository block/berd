import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultVoiceDetectionPreference,
  getVoiceDetectionPreference,
  setVoiceDetectionPreference,
} from "./voiceDetectionPreference";

describe("voice detection preference", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("defaults to the existing native thresholds", () => {
    expect(getDefaultVoiceDetectionPreference()).toEqual({
      speechSensitivity: "more",
      endOfSpeechPause: "standard",
    });
    expect(getVoiceDetectionPreference()).toEqual(
      getDefaultVoiceDetectionPreference(),
    );
  });

  it("persists speech sensitivity and end-of-speech pause", () => {
    setVoiceDetectionPreference({
      speechSensitivity: "less",
      endOfSpeechPause: "long",
    });

    expect(getVoiceDetectionPreference()).toEqual({
      speechSensitivity: "less",
      endOfSpeechPause: "long",
    });
  });

  it("normalizes invalid stored values independently", () => {
    window.localStorage.setItem(
      "goose:voice-detection-preference",
      JSON.stringify({
        speechSensitivity: "maximum",
        endOfSpeechPause: "short",
      }),
    );

    expect(getVoiceDetectionPreference()).toEqual({
      speechSensitivity: "more",
      endOfSpeechPause: "short",
    });
  });

  it("keeps the latest choice when local storage rejects the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    setVoiceDetectionPreference({
      speechSensitivity: "balanced",
      endOfSpeechPause: "short",
    });

    expect(getVoiceDetectionPreference()).toEqual({
      speechSensitivity: "balanced",
      endOfSpeechPause: "short",
    });
  });

  it("accepts a later storage update after a rejected write", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("storage unavailable");
      });
    setVoiceDetectionPreference({
      speechSensitivity: "balanced",
      endOfSpeechPause: "short",
    });

    setItem.mockRestore();
    window.localStorage.setItem(
      "goose:voice-detection-preference",
      JSON.stringify({
        speechSensitivity: "less",
        endOfSpeechPause: "long",
      }),
    );

    expect(getVoiceDetectionPreference()).toEqual({
      speechSensitivity: "less",
      endOfSpeechPause: "long",
    });
  });
});
