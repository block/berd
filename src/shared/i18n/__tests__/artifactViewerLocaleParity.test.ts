import { describe, expect, it } from "vitest";
import enChat from "../locales/en/chat.json";
import esChat from "../locales/es/chat.json";

/**
 * Focused parity check for the doc-viewer strings.
 *
 * Mirrors artifactChipsLocaleParity: a blanket en↔es gate is still blocked by
 * pre-existing gaps elsewhere (settings.security, toolbar, …), so this pins
 * the contract for the keys this surface owns. The viewer's header is a mixed
 * surface — the reveal action reads its label from `common:labels`, which was
 * already translated — so an untranslated viewer key shows up as one English
 * item sitting between Spanish ones rather than a uniformly English panel.
 */

const PLACEHOLDER_PATTERN = /\{\{\s*([^}\s]+)\s*\}\}/g;

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1])
    .sort();
}

type ArtifactViewerStrings = Record<string, string>;

function esArtifactViewer(): ArtifactViewerStrings {
  return (
    (esChat as { artifactViewer?: ArtifactViewerStrings }).artifactViewer ?? {}
  );
}

describe("artifactViewer locale parity", () => {
  it("exists in both locales with the same keys", () => {
    const enKeys = Object.keys(enChat.artifactViewer ?? {}).sort();
    const esKeys = Object.keys(esArtifactViewer()).sort();

    expect(enKeys.length).toBeGreaterThan(0);
    expect(esKeys).toEqual(enKeys);
  });

  it("keeps interpolation placeholders intact across locales", () => {
    const en = enChat.artifactViewer as ArtifactViewerStrings;
    const es = esArtifactViewer();

    for (const key of Object.keys(en)) {
      expect(
        placeholdersOf(es[key] ?? ""),
        `placeholders for "${key}"`,
      ).toEqual(placeholdersOf(en[key]));
    }
  });

  it("translates every viewer string rather than echoing English", () => {
    // Guards the failure mode the fallback hides: a key present in es but
    // still holding the English copy would satisfy a keys-only check while
    // reading as English in the UI. "Código" and placeholder-only values are
    // legitimately identical or near-identical, so only compare prose.
    const en = enChat.artifactViewer as ArtifactViewerStrings;
    const es = esArtifactViewer();

    for (const [key, enValue] of Object.entries(en)) {
      if (
        enValue.replace(PLACEHOLDER_PATTERN, "").trim().split(/\s+/).length < 2
      ) {
        continue;
      }
      expect(es[key], `"${key}" should be translated`).not.toBe(enValue);
    }
  });
});
