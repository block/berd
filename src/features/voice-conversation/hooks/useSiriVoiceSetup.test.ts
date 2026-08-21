import { describe, expect, it } from "vitest";
import {
  availableLocales,
  canonicalLocale,
  chooseAvailableLocale,
  initialSelectedVoiceLocale,
} from "./useSiriVoiceSetup";

describe("Siri voice locales", () => {
  it("preserves exact regional variants", () => {
    expect(availableLocales(["en_US", "en-AU", "en-IN", "en-US"])).toEqual([
      "en-AU",
      "en-IN",
      "en-US",
    ]);
    expect(canonicalLocale("en_US")).toBe("en-US");
  });

  it("uses the exact system locale when it is available", () => {
    expect(chooseAvailableLocale("en-US", ["en-AU", "en-IN", "en-US"])).toBe(
      "en-US",
    );
  });

  it("falls back to a regional variant without adding an all-language option", () => {
    expect(chooseAvailableLocale("en-CA", ["en-AU", "en-IN"])).toBe("en-AU");
  });

  it("opens on the selected voice's regional locale", () => {
    expect(
      initialSelectedVoiceLocale("en-US", ["en-AU", "en-US"], {
        name: "Catherine",
        language: "en_AU",
      }),
    ).toBe("en-AU");
  });
});
