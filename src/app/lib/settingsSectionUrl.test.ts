import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSettingsSectionUrl,
  getInitialSettingsSection,
  setSettingsSectionUrl,
} from "./settingsSectionUrl";

describe("settingsSectionUrl", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  describe("getInitialSettingsSection", () => {
    it("returns null when pathname is /", () => {
      expect(getInitialSettingsSection()).toBeNull();
    });

    it("returns the resolved section for /settings?section=providers", () => {
      window.history.replaceState({}, "", "/settings?section=providers");
      expect(getInitialSettingsSection()).toBe("providers");
    });

    it("returns the resolved section for /settings?section=experiments", () => {
      window.history.replaceState({}, "", "/settings?section=experiments");
      expect(getInitialSettingsSection()).toBe("experiments");
    });

    it("returns the default section when /settings has no section param", () => {
      window.history.replaceState({}, "", "/settings");
      expect(getInitialSettingsSection()).toBe("appearance");
    });

    it("redirects legacy ?section=projects to archive", () => {
      window.history.replaceState({}, "", "/settings?section=projects");
      expect(getInitialSettingsSection()).toBe("archive");
    });

    it("falls back to the default section for an unknown ?section value", () => {
      window.history.replaceState({}, "", "/settings?section=bogus");
      expect(getInitialSettingsSection()).toBe("appearance");
    });
  });

  describe("setSettingsSectionUrl", () => {
    it("sets pathname to /settings and adds the section param from /", () => {
      setSettingsSectionUrl("providers");
      expect(window.location.pathname).toBe("/settings");
      expect(window.location.search).toBe("?section=providers");
    });

    it("overwrites an existing section param", () => {
      window.history.replaceState({}, "", "/settings?section=general");
      setSettingsSectionUrl("providers");
      expect(window.location.pathname).toBe("/settings");
      expect(window.location.search).toBe("?section=providers");
    });
  });

  describe("clearSettingsSectionUrl", () => {
    it("resets pathname to / and strips section from /settings?section=providers", () => {
      window.history.replaceState({}, "", "/settings?section=providers");
      clearSettingsSectionUrl();
      expect(window.location.pathname).toBe("/");
      expect(window.location.search).toBe("");
    });

    it("strips section but leaves a non-settings pathname untouched", () => {
      window.history.replaceState({}, "", "/?section=providers");
      clearSettingsSectionUrl();
      expect(window.location.pathname).toBe("/");
      expect(window.location.search).toBe("");
    });
  });

  it("round-trips a deep link: read providers then clear back to /", () => {
    window.history.replaceState({}, "", "/settings?section=providers");
    expect(getInitialSettingsSection()).toBe("providers");
    clearSettingsSectionUrl();
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
  });
});
