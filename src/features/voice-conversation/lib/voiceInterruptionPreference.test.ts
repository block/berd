import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultVoiceInterruptionPreference,
  getVoiceInterruptionPreference,
  setVoiceInterruptionPreference,
  useVoiceInterruptionPreference,
} from "./voiceInterruptionPreference";

describe("voice interruption preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.dispatchEvent(
      new StorageEvent("storage", { key: null, newValue: null }),
    );
  });
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

  it("accepts a same-value cross-window storage event after a failed write", () => {
    const { result, unmount } = renderHook(() =>
      useVoiceInterruptionPreference(),
    );
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("storage unavailable");
      });

    act(() => {
      setVoiceInterruptionPreference({
        mode: "preventFeedback",
        sensitivity: "less",
        speechSensitivity: "balanced",
      });
    });
    expect(result.current.mode).toBe("preventFeedback");
    setItem.mockRestore();

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "goose:voice-interruption-preference",
          newValue: null,
        }),
      );
    });
    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "automatic",
      sensitivity: "balanced",
      speechSensitivity: "more",
    });
    unmount();
  });
});
