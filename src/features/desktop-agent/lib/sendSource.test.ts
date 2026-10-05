// Send-source priority, perch preamble shape, and guidance-ledger
// semantics. The preamble tests pin the EXACT wire shape —
// transcriptDisplay.stripWirePreamble parses it back out of replays, so
// a drift here breaks display-stripping silently.

import { describe, expect, test } from "vitest";

import {
  chooseComposerSendSource,
  markGuidanceSent,
  perchSendPreamble,
  resetGuidanceLedger,
  shouldSendFullGuidance,
  shouldSendFullGuidanceFor,
} from "./sendSource";
import { stripWirePreamble } from "./transcriptDisplay";

describe("chooseComposerSendSource", () => {
  test("perched phase selects the perched window", () => {
    expect(chooseComposerSendSource({ perchPhase: "perched" })).toBe(
      "perchedWindow",
    );
  });

  test("unperched and targeting select nothing", () => {
    expect(chooseComposerSendSource({ perchPhase: "unperched" })).toBe("none");
    // Mid-drag is not a perch: nothing is granted until the drop attaches.
    expect(chooseComposerSendSource({ perchPhase: "targeting" })).toBe("none");
  });
});

describe("perchSendPreamble", () => {
  test("perched preamble carries app, title, and url", () => {
    const preamble = perchSendPreamble({
      phase: "perched",
      appName: "Google Chrome",
      title: "Q3 Planning - Google Docs",
      artifactUrl: "https://docs.google.com/document/d/abc",
    });
    expect(preamble).toContain(
      '[Perched on: Google Chrome — "Q3 Planning - Google Docs" — https://docs.google.com/document/d/abc]',
    );
    expect(preamble).toContain("prefer acting on the underlying artifact");
    expect(preamble).not.toContain("minimized");
  });

  test("missing title and url degrade gracefully", () => {
    const preamble = perchSendPreamble({
      phase: "perched",
      appName: "Terminal",
      title: "  ",
      artifactUrl: null,
    });
    expect(preamble).toContain("[Perched on: Terminal]");
    expect(preamble).not.toContain('""');
  });

  test("unperched, targeting, or missing identity -> null", () => {
    expect(
      perchSendPreamble({ phase: "unperched", appName: "Safari", title: "T" }),
    ).toBeNull();
    expect(
      perchSendPreamble({ phase: "targeting", appName: "Safari", title: "T" }),
    ).toBeNull();
    expect(
      perchSendPreamble({ phase: "perched", appName: null, title: "T" }),
    ).toBeNull();
  });

  test("slim preamble is bracket-only: identity yes, guidance no", () => {
    const preamble = perchSendPreamble({
      phase: "perched",
      appName: "Google Chrome",
      title: "Q3 Planning",
      artifactUrl: "https://docs.google.com/document/d/abc",
      fullGuidance: false,
    });
    expect(preamble).toBe(
      '[Perched on: Google Chrome — "Q3 Planning" — https://docs.google.com/document/d/abc]',
    );
    expect(preamble).not.toContain("underlying artifact");
  });

  test("fullGuidance defaults to true", () => {
    const preamble = perchSendPreamble({
      phase: "perched",
      appName: "Safari",
      title: "Doc",
    });
    expect(preamble).toContain("underlying artifact");
  });

  test("round-trip: stripWirePreamble recovers the bare words from every preamble shape", () => {
    // The two modules are a matched pair — this is the coupling test.
    const bare = "can you validate this issue";
    for (const args of [
      { phase: "perched" as const, appName: "Chrome", title: "Doc" },
      {
        phase: "perched" as const,
        appName: "Chrome",
        title: "Doc",
        artifactUrl: "https://x.test/d",
        fullGuidance: false,
      },
      { phase: "perched" as const, appName: "Chrome", title: null },
      {
        phase: "perched" as const,
        appName: "Chrome",
        title: "T",
        fullGuidance: false,
      },
    ]) {
      const preamble = perchSendPreamble(args);
      expect(preamble).not.toBeNull();
      expect(stripWirePreamble(`${preamble}\n\n${bare}`)).toBe(bare);
    }
  });
});

describe("guidance ledger", () => {
  test("first send full, subsequent slim, per session key", () => {
    resetGuidanceLedger();
    expect(shouldSendFullGuidance("s1")).toBe(true);
    markGuidanceSent("s1");
    expect(shouldSendFullGuidance("s1")).toBe(false);
    // A different session (new chat) gets guidance again.
    expect(shouldSendFullGuidance("s2")).toBe(true);
  });

  test("reset clears the ledger", () => {
    resetGuidanceLedger();
    markGuidanceSent("s1");
    resetGuidanceLedger();
    expect(shouldSendFullGuidance("s1")).toBe(true);
  });
});

describe("shouldSendFullGuidanceFor", () => {
  test("deferred create is ALWAYS full — even when the visible sessionId is burned", () => {
    resetGuidanceLedger();
    markGuidanceSent("parked-session");
    // While armed, sessionId still holds the PARKED session's id. A
    // deferred create targets a brand-new session whose agent has never
    // seen the guidance — the parked ledger entry must not matter.
    expect(shouldSendFullGuidanceFor(true, "parked-session")).toBe(true);
  });

  test("no pending create: the live session ledger decides", () => {
    resetGuidanceLedger();
    expect(shouldSendFullGuidanceFor(false, "s1")).toBe(true);
    markGuidanceSent("s1");
    expect(shouldSendFullGuidanceFor(false, "s1")).toBe(false);
  });

  test("null sessionId (implicit fresh create) defaults to full", () => {
    resetGuidanceLedger();
    expect(shouldSendFullGuidanceFor(false, null)).toBe(true);
  });
});
