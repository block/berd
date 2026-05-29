import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS, resolveSettingsSection } from "../settingsSections";

describe("settingsSections", () => {
  it("includes updates in settings navigation", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toContain("updates");
    expect(resolveSettingsSection("updates")).toBe("updates");
  });

  it("folds the legacy extensions route into connections", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).not.toContain(
      "extensions",
    );
    expect(resolveSettingsSection("extensions")).toBe("connections");
  });
});
