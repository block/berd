import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getVoiceEarlyDeliveryPreference,
  setVoiceEarlyDeliveryPreference,
  useVoiceEarlyDeliveryPreference,
} from "./voiceEarlyDeliveryPreference";

const key = "goose:voice-early-delivery-preference";

describe("voice early delivery preference", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults on and preserves saved off", () => {
    expect(getVoiceEarlyDeliveryPreference()).toEqual({ enabled: true });
    setVoiceEarlyDeliveryPreference({ enabled: false });
    expect(getVoiceEarlyDeliveryPreference()).toEqual({ enabled: false });
    expect(JSON.parse(window.localStorage.getItem(key) ?? "null")).toEqual({
      enabled: false,
    });
  });

  it.each([
    "invalid json",
    "{}",
    '{"enabled":"false"}',
  ])("defaults on for invalid storage: %s", (raw) => {
    window.localStorage.setItem(key, raw);
    expect(getVoiceEarlyDeliveryPreference()).toEqual({ enabled: true });
  });

  it("updates same-window and cross-window subscribers", () => {
    const { result } = renderHook(() => useVoiceEarlyDeliveryPreference());
    act(() => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);
    act(() => {
      window.localStorage.setItem(key, JSON.stringify({ enabled: true }));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(result.current.enabled).toBe(true);
  });
});
