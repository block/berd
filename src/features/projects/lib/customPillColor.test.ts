import { describe, expect, it } from "vitest";

import {
  customPillColorFromHue,
  hueFromCustomColor,
  isHexColor,
  normalizeCustomPillColor,
} from "./customPillColor";

describe("customPillColor", () => {
  it("normalizes saturated input into the constrained pastel band", () => {
    expect(normalizeCustomPillColor("#ff0000")).toBe("#e9b9b9");
    expect(normalizeCustomPillColor("#0000ff")).toBe("#b9b9e9");
  });

  it("derives a hue from arbitrary hex colors", () => {
    expect(hueFromCustomColor("#22c55e")).toBe(142);
  });

  it("creates stable pastel colors from hue values", () => {
    expect(customPillColorFromHue(142)).toBe("#b9e9cb");
  });

  it("recognizes canonical six-digit hex colors", () => {
    expect(isHexColor("#b4eed0")).toBe(true);
    expect(isHexColor("#fff")).toBe(false);
    expect(isHexColor("b4eed0")).toBe(false);
  });
});
