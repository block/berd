import { beforeEach, describe, expect, it } from "vitest";
import {
  getStoredVoiceInputBackend,
  isMacSpeechAvailable,
  resolveVoiceInputBackend,
  setVoiceInputBackend,
} from "./voiceInputPreference";

describe("voice input preference", () => {
  beforeEach(() => window.localStorage.clear());

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
});
