import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { resolveAgentShareCardCopy } from "./agentShareCardCopy";

function translator(locale: "en" | "es"): TFunction<"agents"> {
  const copy = {
    en: {
      "share.cardLabels.goodFor": "Good for:",
      "share.cardLabels.vibes": "Vibes:",
      "share.cardTraits.research.goodFor": "finding answers",
      "share.cardTraits.research.vibes": "curious",
    },
    es: {
      "share.cardLabels.goodFor": "Ideal para:",
      "share.cardLabels.vibes": "Estilo:",
      "share.cardTraits.research.goodFor": "buscar respuestas",
      "share.cardTraits.research.vibes": "curioso",
    },
  } as const;
  return ((key: keyof (typeof copy)[typeof locale]) =>
    copy[locale][key]) as TFunction<"agents">;
}

describe("resolveAgentShareCardCopy", () => {
  it("uses real agent card metadata when provided", () => {
    expect(
      resolveAgentShareCardCopy("Build software", translator("en"), {
        goodFor: "growing your cast of doers",
        vibes: "sharp, seasoned",
      }),
    ).toEqual({
      goodForLabel: "Good for:",
      vibesLabel: "Vibes:",
      goodFor: "growing your cast of doers",
      vibes: "sharp, seasoned",
    });
  });

  it("rejects overlong metadata instead of truncating it", () => {
    expect(
      resolveAgentShareCardCopy("Research evidence", translator("en"), {
        goodFor: "x".repeat(33),
        vibes: "y".repeat(33),
      }),
    ).toMatchObject({
      goodFor: "finding answers",
      vibes: "curious",
    });
  });

  it("never renders untranslated localization keys", () => {
    const missingTranslator = ((key: string) => key) as TFunction<"agents">;
    expect(
      resolveAgentShareCardCopy("unknown purpose", missingTranslator),
    ).toEqual({
      goodForLabel: "Good for:",
      vibesLabel: "Vibes:",
      goodFor: "focused work",
      vibes: "capable, thoughtful",
    });
  });

  it("resolves one semantic trait into localized card copy", () => {
    expect(
      resolveAgentShareCardCopy("Research evidence", translator("en")),
    ).toEqual({
      goodForLabel: "Good for:",
      vibesLabel: "Vibes:",
      goodFor: "finding answers",
      vibes: "curious",
    });
    expect(
      resolveAgentShareCardCopy("Research evidence", translator("es")),
    ).toEqual({
      goodForLabel: "Ideal para:",
      vibesLabel: "Estilo:",
      goodFor: "buscar respuestas",
      vibes: "curioso",
    });
  });
});
