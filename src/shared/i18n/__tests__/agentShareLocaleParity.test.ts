import { describe, expect, it } from "vitest";
import enAgents from "../locales/en/agents.json";
import esAgents from "../locales/es/agents.json";

const exportKeys = [
  "description",
  "downloadPng",
  "downloadZip",
  "downloadMarkdown",
  "downloadOptions",
] as const;

describe("agent share locale parity", () => {
  it("provides every changed export label in Spanish", () => {
    for (const key of exportKeys) {
      expect(enAgents.share[key]).toBeTruthy();
      expect(esAgents.share[key]).toBeTruthy();
      expect(esAgents.share[key]).not.toBe(enAgents.share[key]);
    }
  });
});
