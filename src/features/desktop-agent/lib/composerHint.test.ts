// Table tests pinning the composer-hint priority chain. The helper
// returns i18n descriptors ({ key, params }) — the component translates.

import { describe, expect, test } from "vitest";

import { deriveComposerHint, type ComposerHintInputs } from "./composerHint";

const quiet: ComposerHintInputs = {
  lastSendError: null,
  perchError: null,
  perchPhase: "unperched",
  perchApp: null,
  perchTitle: null,
  attached: true,
  connectionError: null,
  reconnectExhausted: false,
  sendStalled: false,
  agentSendInFlight: false,
  pendingName: null,
  thinking: false,
};

describe("deriveComposerHint", () => {
  test("quiet state renders no hint", () => {
    expect(deriveComposerHint(quiet)).toBeNull();
  });

  test("send error beats everything", () => {
    const everythingOn: ComposerHintInputs = {
      lastSendError: "boom",
      perchError: "ax broke",
      perchPhase: "perched",
      perchApp: "Chrome",
      perchTitle: "Doc",
      attached: false,
      connectionError: "closed",
      reconnectExhausted: true,
      sendStalled: true,
      agentSendInFlight: true,
      pendingName: "Panda",
      thinking: true,
    };
    expect(deriveComposerHint(everythingOn)).toEqual({
      key: "hint.sendFailed",
      params: { message: "boom" },
    });
  });

  test("disconnected ladder: exhausted > reconnecting > connecting", () => {
    const off = { ...quiet, attached: false };
    expect(deriveComposerHint({ ...off, reconnectExhausted: true })?.key).toBe(
      "hint.reconnectExhausted",
    );
    expect(deriveComposerHint({ ...off, connectionError: "closed" })?.key).toBe(
      "hint.reconnecting",
    );
    expect(deriveComposerHint(off)?.key).toBe("hint.connecting");
  });

  test("attached ladder: stalled > agent starting > thinking", () => {
    expect(
      deriveComposerHint({
        ...quiet,
        sendStalled: true,
        agentSendInFlight: true,
        thinking: true,
      })?.key,
    ).toBe("hint.stalled");
    expect(
      deriveComposerHint({
        ...quiet,
        agentSendInFlight: true,
        pendingName: "Panda",
        thinking: true,
      }),
    ).toEqual({ key: "hint.agentStarting", params: { name: "Panda" } });
    expect(deriveComposerHint({ ...quiet, thinking: true })?.key).toBe(
      "hint.thinking",
    );
  });

  test("agent starting without a name uses the generic key (no English fallback)", () => {
    expect(deriveComposerHint({ ...quiet, agentSendInFlight: true })).toEqual({
      key: "hint.agentStartingGeneric",
    });
  });
});

describe("deriveComposerHint perch rungs", () => {
  const perched: ComposerHintInputs = {
    ...quiet,
    perchPhase: "perched",
    perchApp: "Chrome",
    perchTitle: "Quarterly Doc",
  };

  test("perch error beats disconnected but loses to send error", () => {
    expect(
      deriveComposerHint({ ...quiet, perchError: "ax broke", attached: false }),
    ).toEqual({ key: "hint.perchError", params: { message: "ax broke" } });
    expect(
      deriveComposerHint({
        ...quiet,
        perchError: "ax broke",
        lastSendError: "boom",
      })?.key,
    ).toBe("hint.sendFailed");
  });

  test("accessibility_denied maps to the grant-instructions key", () => {
    expect(
      deriveComposerHint({ ...quiet, perchError: "accessibility_denied" }),
    ).toEqual({ key: "hint.perchAccessibility" });
    // The gate token arrives wrapped in invoke error prose — still maps.
    expect(
      deriveComposerHint({
        ...quiet,
        perchError: 'invoke error: "accessibility_denied"',
      }),
    ).toEqual({ key: "hint.perchAccessibility" });
  });

  test("perched identity: app+title and app-only variants", () => {
    expect(deriveComposerHint(perched)).toEqual({
      key: "hint.perched",
      params: { app: "Chrome", title: "Quarterly Doc" },
    });
    expect(deriveComposerHint({ ...perched, perchTitle: "  " })).toEqual({
      key: "hint.perchedApp",
      params: { app: "Chrome" },
    });
  });

  test("perch identity beats thinking but loses to agent starting", () => {
    expect(deriveComposerHint({ ...perched, thinking: true })?.key).toBe(
      "hint.perched",
    );
    expect(
      deriveComposerHint({ ...perched, agentSendInFlight: true })?.key,
    ).toBe("hint.agentStartingGeneric");
  });

  test("targeting and unperched render no identity hint", () => {
    expect(
      deriveComposerHint({ ...perched, perchPhase: "targeting" }),
    ).toBeNull();
    expect(
      deriveComposerHint({ ...perched, perchPhase: "unperched" }),
    ).toBeNull();
  });

  test("long app/title truncate with ellipsis (one-line hint row)", () => {
    const hint = deriveComposerHint({
      ...perched,
      perchApp: "A".repeat(40),
      perchTitle: "T".repeat(90),
    });
    expect(hint?.params?.app).toBe(`${"A".repeat(27)}…`);
    expect(hint?.params?.title).toBe(`${"T".repeat(71)}…`);
  });
});
