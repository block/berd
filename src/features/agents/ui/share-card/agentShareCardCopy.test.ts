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
