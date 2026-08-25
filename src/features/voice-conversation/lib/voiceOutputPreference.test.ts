import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultVoiceOutputBackend,
  getVoiceOutputBackend,
  setVoiceOutputBackend,
} from "./voiceOutputPreference";

const originalNavigator = globalThis.navigator;

function setPlatform(userAgent: string) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent },
  });
}

describe("voice output preference", () => {
  beforeEach(() => window.localStorage.clear());

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  });

  it("defaults to Siri on macOS", () => {
    setPlatform("Macintosh");
    expect(getDefaultVoiceOutputBackend()).toBe("siri");
    expect(getVoiceOutputBackend()).toBe("siri");
  });

  it("defaults to Pocket and rejects persisted Siri off macOS", () => {
    setPlatform("Windows");
    window.localStorage.setItem("goose:voice-output-backend", "siri");
    expect(getDefaultVoiceOutputBackend()).toBe("pocket");
    expect(getVoiceOutputBackend()).toBe("pocket");
  });

  it("preserves an explicit Pocket choice on macOS", () => {
    setPlatform("Macintosh");
    window.localStorage.setItem("goose:voice-output-backend", "pocket");
    expect(getVoiceOutputBackend()).toBe("pocket");
  });

  it("preserves an explicit Siri choice on macOS", () => {
    setPlatform("Macintosh");
    window.localStorage.setItem("goose:voice-output-backend", "siri");
    expect(getVoiceOutputBackend()).toBe("siri");
  });

  it("keeps an explicit Pocket choice when local storage rejects the write", () => {
    setPlatform("Macintosh");
    window.localStorage.setItem("goose:voice-output-backend", "siri");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    setVoiceOutputBackend("pocket");

    expect(getVoiceOutputBackend()).toBe("pocket");
  });
});
