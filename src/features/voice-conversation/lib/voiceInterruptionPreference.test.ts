import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultVoiceInterruptionPreference,
  getVoiceInterruptionPreference,
  setVoiceInterruptionPreference,
  useVoiceInterruptionPreference,
} from "./voiceInterruptionPreference";

describe("voice interruption preference", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

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

  it("keeps the renderer preference usable when storage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    setVoiceInterruptionPreference({
      mode: "preventFeedback",
      sensitivity: "less",
    });

    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "preventFeedback",
      sensitivity: "less",
    });
  });

  it("accepts a newer persisted value after a failed write", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("storage unavailable");
      });

    setVoiceInterruptionPreference({
      mode: "preventFeedback",
      sensitivity: "less",
    });
    setItem.mockRestore();
    window.localStorage.setItem(
      "goose:voice-interruption-preference",
      JSON.stringify({ mode: "allowInterruptions", sensitivity: "more" }),
    );

    expect(getVoiceInterruptionPreference()).toEqual({
      mode: "allowInterruptions",
      sensitivity: "more",
    });
  });

  it("accepts a same-value cross-window storage event after a failed write", () => {
    const { result, unmount } = renderHook(() =>
      useVoiceInterruptionPreference(),
    );
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage unavailable");
      });

    act(() => {
      setVoiceInterruptionPreference({
        mode: "preventFeedback",
        sensitivity: "less",
      });
    });
    expect(result.current.mode).toBe("preventFeedback");
    setItem.mockRestore();
    unmount();

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
    });
  });
});
