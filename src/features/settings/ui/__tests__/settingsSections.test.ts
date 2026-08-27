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
  agentTools: true,
  automations: true,
  builderbot: true,
  doctor: true,
  feedback: true,
  feedbackSurveys: true,
  telemetry: true,
  voiceDictation: true,
  voiceConversation: true,
  managedConnections: true,
  updates: true,
};

// Rev 3 (Aug 10): rewritten for the appearance/behavior/system/about split.
// "general" and "updates" are gone as real sections -- "general" resolves
// to "appearance" via legacy redirect, "updates" redirects to "about"
// (the update check now lives embedded there). Security is permanent now
// (no securityMl-gated omission at the nav level -- SecuritySettings.tsx
// gates its ML rows internally instead). Doctor is a hidden, routable
// sub-page reached from a row inside System, not a nav destination.
//
// Rev 5 (Aug 19): "about" is gone as a section too -- both "about" and
// "updates" now redirect to "system", which absorbed About's content under
// its own subhead.
describe("settingsSections", () => {
  it("includes experiments in settings navigation", () => {
    const sectionIds = SETTINGS_SECTIONS.map((section) => section.id);

    expect(sectionIds).toContain("experiments");
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

  it("includes security in settings navigation permanently", () => {
    expect(
      getVisibleSettingsSections(enabledCapabilities).map(
        (section) => section.id,
      ),
    ).toContain("security");
    expect(resolveSettingsSection("security")).toBe("security");

    // Security has no capability gate at the nav level -- it's always
    // visible even when the caller's capability state has nothing to do
    // with security ML. SecuritySettings.tsx itself gates the ML rows via
    // getBuildFeatureState().securityMl, which is a build-time flag, not a
    // capability, so it's not exercised by getVisibleSettingsSections.
    expect(isSettingsSectionEnabled("security", enabledCapabilities)).toBe(
      true,
    );
  });

  it("redirects the legacy general, about, and updates routes to their new homes", () => {
    expect(resolveSettingsSection("general")).toBe("appearance");
    // About merged into System (rev 5): app identity, Account, and the
    // update check all live there now, under an "About" subhead.
    expect(resolveSettingsSection("about")).toBe("system");
    expect(resolveSettingsSection("updates")).toBe("system");
  });

  it("no longer lists about as a settings section", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).not.toContain(
      "about",
    );
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

  it("redirects the legacy doctor route to System (rev 4: dialog, not a page)", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).not.toContain(
      "doctor",
    );
    expect(resolveSettingsSection("doctor")).toBe("system");
  });

  it("filters and redirects capability-gated settings sections", () => {
    const capabilities = {
      ...enabledCapabilities,
      voiceConversation: false,
    };

    expect(isSettingsSectionEnabled("voice", capabilities)).toBe(false);
    expect(isSettingsSectionEnabled("appearance", capabilities)).toBe(true);
    expect(resolveEnabledSettingsSection("voice", capabilities)).toBe(
      DEFAULT_SETTINGS_SECTION,
    );
    expect(
      getVisibleSettingsSections(capabilities).map((section) => section.id),
    ).not.toContain("voice");
  });
});
