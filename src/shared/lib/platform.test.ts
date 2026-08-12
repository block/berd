import { afterEach, describe, expect, it } from "vitest";

import { getPlatform } from "./platform";

const originalNavigator = globalThis.navigator;

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: originalNavigator,
  });
});

describe("getPlatform", () => {
  it("falls back to linux when navigator is unavailable", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: undefined,
    });

    expect(getPlatform()).toBe("linux");
  });
});
