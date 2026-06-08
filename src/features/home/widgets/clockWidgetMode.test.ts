import { describe, expect, it } from "vitest";
import { clockModeOf } from "./clockWidgetMode";

describe("clockModeOf", () => {
  it("defaults to analog when no mode state is present", () => {
    expect(clockModeOf({ state: undefined })).toBe("analog");
    expect(clockModeOf({ state: {} })).toBe("analog");
  });

  it("returns digital only when state.mode is exactly 'digital'", () => {
    expect(clockModeOf({ state: { mode: "digital" } })).toBe("digital");
    expect(clockModeOf({ state: { mode: "analog" } })).toBe("analog");
    expect(clockModeOf({ state: { mode: "nonsense" } })).toBe("analog");
  });
});
