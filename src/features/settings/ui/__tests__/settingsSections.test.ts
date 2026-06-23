import { describe, expect, it } from "vitest";
import type { ProfileCapabilityState } from "@/shared/profile/capabilities";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  getVisibleSettingsSections,
  isSettingsSectionEnabled,
  resolveEnabledSettingsSection,
  resolveSettingsSection,
} from "../settingsSections";

const enabledCapabilities: ProfileCapabilityState = {
  agentToolsTip: true,
  automations: true,
  builderbot: true,
  doctor: true,
  feedback: true,
  telemetry: true,
};

describe("settingsSections", () => {
  it("includes experiments in settings navigation after doctor", () => {
    const sectionIds = SETTINGS_SECTIONS.map((section) => section.id);

    expect(sectionIds).toContain("experiments");
    expect(sectionIds.indexOf("experiments")).toBeGreaterThan(
      sectionIds.indexOf("doctor"),
    );
    expect(resolveSettingsSection("experiments")).toBe("experiments");
  });

  it("includes shortcuts in settings navigation after notifications", () => {
    const sectionIds = SETTINGS_SECTIONS.map((section) => section.id);

    expect(sectionIds).toContain("shortcuts");
    expect(sectionIds.indexOf("shortcuts")).toBe(
      sectionIds.indexOf("notifications") + 1,
    );
    expect(resolveSettingsSection("shortcuts")).toBe("shortcuts");
  });

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

  it("filters and redirects capability-gated settings sections", () => {
    const capabilities = {
      ...enabledCapabilities,
      doctor: false,
    };

    expect(isSettingsSectionEnabled("doctor", capabilities)).toBe(false);
    expect(isSettingsSectionEnabled("general", capabilities)).toBe(true);
    expect(resolveEnabledSettingsSection("doctor", capabilities)).toBe(
      DEFAULT_SETTINGS_SECTION,
    );
    expect(
      getVisibleSettingsSections(capabilities).map((section) => section.id),
    ).not.toContain("doctor");
  });
});
