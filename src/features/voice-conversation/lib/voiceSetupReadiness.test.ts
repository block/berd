import { describe, expect, it } from "vitest";
import type { PocketVoiceStatus } from "../api/pocketVoice";
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

describe("voice setup readiness", () => {
  it("requires Parakeet and Pocket for the Pocket backend", () => {
    expect(isVoiceSetupReady(pocket, null, "pocket")).toBe(true);
    expect(
      isVoiceSetupReady(
        { ...pocket, parakeetInstalled: false },
        null,
        "pocket",
      ),
    ).toBe(false);
  });

  it("requires Parakeet and an installed selected Siri voice", () => {
    expect(isVoiceSetupReady(pocket, siri, "siri")).toBe(true);
    expect(
      isVoiceSetupReady(
        pocket,
        { ...siri, selectedVoiceInstalled: false },
        "siri",
      ),
    ).toBe(false);
  });
});
