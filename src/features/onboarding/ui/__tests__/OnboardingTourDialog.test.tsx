import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The dialog composes ProjectArtifactPreview and motion animations, which
// do not complete rendering under jsdom, so this pins the source directly
// (the globals.test.ts idiom). The token values themselves are pinned in
// src/shared/styles/globals.test.ts.
const source = readFileSync(
  join(__dirname, "..", "OnboardingTourDialog.tsx"),
  "utf8",
);

describe("OnboardingTourDialog overlay", () => {
  it("dims with the semantic onboarding scrim token, not paper paint", () => {
    // bg-background is the paper alias of card; a modal scrim sourced from
    // it would composite 40% card gray in dark mode instead of dimming.
    // The paper-intent tiles and mock chat bubbles inside the tour keep
    // bg-background deliberately — only the scrim prop is pinned.
    const overlayClassName = source.match(/overlayClassName="([^"]*)"/)?.[1];
    expect(overlayClassName).toBeDefined();
    expect(overlayClassName).toContain("bg-[var(--overlay-onboarding-scrim)]");
    expect(overlayClassName).not.toContain("bg-background");
  });
});
