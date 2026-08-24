import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStoredVoiceInputBackend,
  isMacSpeechAvailable,
  resolveVoiceInputBackend,
  setVoiceInputBackend,
  useVoiceInputPreference,
} from "./voiceInputPreference";

describe("voice input preference", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("waits for macOS capability before resolving an automatic default", () => {
    expect(resolveVoiceInputBackend(null, null)).toBeNull();
  });

  it("treats an unsupported current locale as unavailable", () => {
    expect(
      isMacSpeechAvailable({ supported: true, localeSupported: false }, false),
    ).toBe(false);
  });

  it("defaults to native macOS speech when it is supported", () => {
    expect(resolveVoiceInputBackend(null, true)).toBe("macos");
  });

  it("defaults to Parakeet when native macOS speech is unavailable", () => {
    expect(resolveVoiceInputBackend(null, false)).toBe("parakeet");
  });

  it("preserves an explicit Parakeet choice on supported macOS", () => {
    expect(resolveVoiceInputBackend("parakeet", true)).toBe("parakeet");
  });

  it("uses Parakeet without erasing a persisted unavailable choice", () => {
    setVoiceInputBackend("macos");
    expect(getStoredVoiceInputBackend()).toBe("macos");
    expect(resolveVoiceInputBackend(getStoredVoiceInputBackend(), false)).toBe(
      "parakeet",
    );
    expect(getStoredVoiceInputBackend()).toBe("macos");
  });

  it("keeps the selected backend when local storage rejects the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const { result } = renderHook(() => useVoiceInputPreference(true));

    act(() => setVoiceInputBackend("parakeet"));

    expect(getStoredVoiceInputBackend()).toBe("parakeet");
    expect(result.current.backend).toBe("parakeet");
  });

  it("synchronizes the fallback from valid cross-window storage events", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    const { result } = renderHook(() => useVoiceInputPreference(true));
    act(() => setVoiceInputBackend("macos"));
    expect(result.current.backend).toBe("macos");

    act(() => {
      window.localStorage.setItem("goose:voice-input-backend", "parakeet");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "goose:voice-input-backend",
          newValue: "parakeet",
        }),
      );
    });

    expect(getStoredVoiceInputBackend()).toBe("parakeet");
    expect(result.current.backend).toBe("parakeet");
  });
});
