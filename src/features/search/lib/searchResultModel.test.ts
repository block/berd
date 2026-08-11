import { describe, expect, it } from "vitest";
import enSettings from "@/shared/i18n/locales/en/settings.json";
import { SETTINGS_SEARCH_ITEMS } from "@/features/settings/ui/settingsSearchItems";
import {
  buildResultNavigationModel,
  buildSettingsSearchResults,
  type SearchCategory,
} from "./searchResultModel";

describe("searchResultModel", () => {
  const visibleSections = [
    { id: "appearance" as const, labelKey: "nav.appearance" },
    { id: "providers" as const, labelKey: "nav.providers" },
  ];

  it("builds settings results only from translated visible labels", () => {
    const labels: Record<string, string> = {
      "appearance.theme.label": "Theme",
      "nav.providers": "AI providers",
    };
    const translate = (key: string) => labels[key] ?? key;

    expect(
      buildSettingsSearchResults({
        query: "theme",
        enabled: true,
        translate,
        visibleSections,
      }),
    ).toEqual([
      expect.objectContaining({ sectionId: "appearance", title: "Theme" }),
    ]);
    expect(
      buildSettingsSearchResults({
        query: "model",
        enabled: true,
        translate,
        visibleSections,
      }),
    ).toEqual([]);
    expect(
      buildSettingsSearchResults({
        query: "theme",
        enabled: false,
        translate,
        visibleSections,
      }),
    ).toEqual([]);
  });

  it("excludes results belonging to hidden settings sections", () => {
    const labels: Record<string, string> = {
      "nav.doctor": "Doctor",
      "nav.appearance": "Appearance",
    };

    expect(
      buildSettingsSearchResults({
        query: "doctor",
        enabled: true,
        translate: (key) => labels[key] ?? key,
        visibleSections: [visibleSections[0]],
      }),
    ).toEqual([]);
  });

  it("excludes hidden controls within a visible settings section", () => {
    const labels: Record<string, string> = {
      "general.agentToolsTips.label": "Agent Tools tips",
    };

    expect(
      buildSettingsSearchResults({
        query: "agent tools",
        enabled: true,
        translate: (key) => labels[key] ?? key,
        visibleSections,
        hiddenItemIds: ["chat-tips"],
      }),
    ).toEqual([]);
  });

  it("references existing English labels for every settings search item", () => {
    for (const item of SETTINGS_SEARCH_ITEMS) {
      const value = item.labelKey.split(".").reduce<unknown>((current, key) => {
        if (!current || typeof current !== "object") return undefined;
        return (current as Record<string, unknown>)[key];
      }, enSettings);
      expect(value, item.labelKey).toBeTypeOf("string");
    }
  });

  it("limits navigation ids to the active category", () => {
    const columnsByCategory: Record<SearchCategory, string[]> = {
      all: [],
      chat: ["chat-1", "chat-2"],
      extensions: [],
      agents: ["agent-1"],
      skills: ["skill-1"],
      automations: [],
      settings: [],
    };

    expect(
      buildResultNavigationModel({
        activeCategory: "all",
        columnsByCategory,
      }).navigableIds,
    ).toEqual(["chat-1", "chat-2", "agent-1", "skill-1"]);
    expect(
      buildResultNavigationModel({
        activeCategory: "skills",
        columnsByCategory,
      }).navigableIds,
    ).toEqual(["skill-1"]);
  });
});
