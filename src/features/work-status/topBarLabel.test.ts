import i18next from "i18next";
import { describe, expect, it } from "vitest";

import enCommon from "@/shared/i18n/locales/en/common.json";
import esCommon from "@/shared/i18n/locales/es/common.json";

describe("PR Inbox top-bar label", () => {
  it.each([
    ["en", 0, "PR Inbox, 0 open"],
    ["en", 1, "PR Inbox, 1 open"],
    ["en", 2, "PR Inbox, 2 open"],
    ["es", 0, "PR Inbox, 0 abiertas"],
    ["es", 1, "PR Inbox, 1 abierta"],
    ["es", 2, "PR Inbox, 2 abiertas"],
  ])("formats %s count %i", async (locale, count, expected) => {
    const instance = i18next.createInstance();
    await instance.init({
      lng: locale,
      fallbackLng: false,
      resources: {
        en: { common: enCommon },
        es: { common: esCommon },
      },
    });

    expect(instance.t("workStatus.topBarLabel", { count, ns: "common" })).toBe(
      expected,
    );
  });
});
