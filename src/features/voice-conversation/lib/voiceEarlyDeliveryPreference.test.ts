import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_CONVERSATION_EXPERIMENT_ID as id } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY as key,
  getExperiment,
  setExperimentConfigValue,
  setExperimentEnabled,
} from "@/features/experiments/experimentPreferences";
import {
  getVoiceEarlyDeliveryPreference,
  setVoiceEarlyDeliveryPreference,
  useVoiceEarlyDeliveryPreference,
} from "./voiceEarlyDeliveryPreference";

describe("voice early delivery experiment config", () => {
  beforeEach(() => window.localStorage.clear());
  it("defaults on inside enabled voice experiment", () => {
    setExperimentEnabled(id, true);
    expect(getVoiceEarlyDeliveryPreference().enabled).toBe(true);
    setExperimentEnabled(id, false);
    expect(getVoiceEarlyDeliveryPreference().enabled).toBe(false);
  });
  it("writes config under parent and preserves saved off", () => {
    setVoiceEarlyDeliveryPreference({ enabled: false });
    expect(getExperiment(id)?.config.earlyDelivery).toBe(false);
    expect(getVoiceEarlyDeliveryPreference().enabled).toBe(false);
  });
  it("migrates explicitly saved legacy off without overwriting registry choices", () => {
    window.localStorage.setItem(
      "goose:voice-early-delivery-preference",
      '{"enabled":false}',
    );
    expect(getVoiceEarlyDeliveryPreference().enabled).toBe(false);
    expect(getExperiment(id)?.config.earlyDelivery).toBe(false);
    setExperimentConfigValue(id, "earlyDelivery", true);
    expect(getVoiceEarlyDeliveryPreference().enabled).toBe(true);
  });
  it("preserves an existing registry choice over legacy off", () => {
    setExperimentConfigValue(id, "earlyDelivery", true);
    window.localStorage.setItem(
      "goose:voice-early-delivery-preference",
      '{"enabled":false}',
    );
    expect(getVoiceEarlyDeliveryPreference().enabled).toBe(true);
  });
  it("reports failed and unsupported-version writes without losing saved off", () => {
    window.localStorage.setItem(key, '{"version":999}');
    expect(setVoiceEarlyDeliveryPreference({ enabled: false })).toBe(false);
    expect(window.localStorage.getItem(key)).toBe('{"version":999}');
    window.localStorage.clear();
    window.localStorage.setItem(
      "goose:voice-early-delivery-preference",
      '{"enabled":false}',
    );
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    expect(setVoiceEarlyDeliveryPreference({ enabled: false })).toBe(false);
    expect(
      window.localStorage.getItem("goose:voice-early-delivery-preference"),
    ).toBe('{"enabled":false}');
    write.mockRestore();
  });
  it("updates same-window and cross-window subscribers", () => {
    const { result } = renderHook(() => useVoiceEarlyDeliveryPreference());
    act(() => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);
    act(() => {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          version: 2,
          experiments: {
            [id]: { enabled: true, config: { earlyDelivery: true } },
          },
        }),
      );
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(result.current.enabled).toBe(true);
  });
});
