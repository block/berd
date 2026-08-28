import { describe, expect, it } from "vitest";
import type { PocketVoiceStatus } from "../api/pocketVoice";
import type { MacSpeechStatus } from "../api/macSpeech";
import type { SiriVoiceStatus } from "../api/siriVoice";
import { isVoiceSetupReady } from "./voiceSetupReadiness";

const pocket = {
  installed: true,
  pocketInstalled: true,
  parakeetInstalled: true,
} as PocketVoiceStatus;

const siri = {
  supported: true,
  selectedVoice: { name: "Aaron", language: "en-US" },
  selectedVoiceInstalled: true,
} as SiriVoiceStatus;

const macSpeech = {
  supported: true,
  localeSupported: true,
  modelInstalled: true,
} as MacSpeechStatus;

describe("voice setup readiness", () => {
  it("requires Parakeet and Pocket for the Pocket backend", () => {
    expect(isVoiceSetupReady(pocket, null, null, "parakeet", "pocket")).toBe(
      true,
    );
    expect(
      isVoiceSetupReady(
        { ...pocket, parakeetInstalled: false },
        null,
        null,
        "parakeet",
        "pocket",
      ),
    ).toBe(false);
  });

  it("requires Parakeet and an installed selected Siri voice", () => {
    expect(isVoiceSetupReady(pocket, null, siri, "parakeet", "siri")).toBe(
      true,
    );
    expect(
      isVoiceSetupReady(
        pocket,
        null,
        { ...siri, selectedVoiceInstalled: false },
        "parakeet",
        "siri",
      ),
    ).toBe(false);
  });

  it("requires the configured OpenAI TTS key and TTS availability for OpenAI output", () => {
    const configured = { ttsConfigured: true, ttsAvailable: true } as never;
    expect(
      isVoiceSetupReady(pocket, null, null, "parakeet", "openai", configured),
    ).toBe(true);
    expect(isVoiceSetupReady(pocket, null, null, "parakeet", "openai")).toBe(
      false,
    );
  });

  it("allows configured OpenAI input when TTS is unavailable", () => {
    const configuredStt = { sttConfigured: true, ttsAvailable: false } as never;
    expect(
      isVoiceSetupReady(pocket, null, null, "openai", "pocket", configuredStt),
    ).toBe(true);
    expect(isVoiceSetupReady(pocket, null, null, "openai", "pocket")).toBe(
      false,
    );
  });

  it("uses native macOS speech readiness instead of Parakeet when selected", () => {
    expect(
      isVoiceSetupReady(
        { ...pocket, parakeetInstalled: false },
        macSpeech,
        null,
        "macos",
        "pocket",
      ),
    ).toBe(true);
  });
});
