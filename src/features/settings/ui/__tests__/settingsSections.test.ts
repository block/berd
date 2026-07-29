import { afterEach, describe, expect, it, vi } from "vitest";
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
  voiceDictation: true,
  kgooseConnections: true,
  updates: true,
};

describe("settingsSections", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
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

  it("includes security in settings navigation by default", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toContain(
      "security",
    );
    expect(resolveSettingsSection("security")).toBe("security");
  });

  it("omits security when security ML is disabled", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_SECURITY_ML", "0");

    const {
      SETTINGS_SECTIONS: disabledSections,
      resolveSettingsSection: resolveDisabledSettingsSection,
    } = await import("../settingsSections");

    expect(disabledSections.map((section) => section.id)).not.toContain(
      "security",
    );
    expect(resolveDisabledSettingsSection("security")).toBe("general");
  });

  it("includes updates in settings navigation", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toContain("updates");
    expect(resolveSettingsSection("updates")).toBe("updates");
  });

  it("hosts connections and redirects the legacy extensions route", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).not.toContain(
      "extensions",
    );
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toContain(
      "connections",
    );
    expect(resolveSettingsSection("extensions")).toBe("connections");
    expect(resolveSettingsSection("connections")).toBe("connections");
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

  it("filters updates when the updater build feature is disabled", () => {
    const capabilities = {
      ...enabledCapabilities,
      updates: false,
    };

    expect(isSettingsSectionEnabled("updates", capabilities)).toBe(false);
    expect(resolveEnabledSettingsSection("updates", capabilities)).toBe(
      DEFAULT_SETTINGS_SECTION,
    );
    expect(
      getVisibleSettingsSections(capabilities).map((section) => section.id),
    ).not.toContain("updates");
  });
});
