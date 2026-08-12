import { describe, expect, it } from "vitest";
import enChat from "../locales/en/chat.json";
import esChat from "../locales/es/chat.json";

/**
 * Focused parity check for the artifact-chip strings.
 *
 * A full en↔es parity gate would be the better long-term tool, but the
 * locales already have pre-existing gaps (artifactViewer,
 * settings.security, …) that predate this feature, so a blanket check would
 * fail on drift this feature did not create. Until that backlog is cleared,
 * this test pins the contract for the keys this feature owns: every chip
 * string exists in both locales with matching interpolation placeholders.
 */

const PLACEHOLDER_PATTERN = /\{\{\s*([^}\s]+)\s*\}\}/g;

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1])
    .sort();
}

describe("artifactChips locale parity", () => {
  it("exists in both locales with the same keys", () => {
    const enKeys = Object.keys(enChat.artifactChips ?? {}).sort();
    const esKeys = Object.keys(
      (esChat as { artifactChips?: Record<string, string> }).artifactChips ??
        {},
    ).sort();

    expect(enKeys.length).toBeGreaterThan(0);
    expect(esKeys).toEqual(enKeys);
  });

  it("keeps interpolation placeholders intact across locales", () => {
    const en = enChat.artifactChips as Record<string, string>;
    const es = (esChat as { artifactChips?: Record<string, string> })
      .artifactChips as Record<string, string>;

    for (const key of Object.keys(en)) {
      expect(
        placeholdersOf(es[key] ?? ""),
        `placeholders for "${key}"`,
      ).toEqual(placeholdersOf(en[key]));
    }
  });
});
