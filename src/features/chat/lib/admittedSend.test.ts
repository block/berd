import { describe, expect, it } from "vitest";
import {
  admitComposerQueuedMessage,
  admitSystemInheritedQueuedMessage,
  createDeferredQueuedMessagePayload,
  personaIntentFromComposer,
  personaIntentToOverride,
} from "./admittedSend";

describe("queued send admission", () => {
  it.each([
    [undefined, { kind: "inherit" }],
    [null, { kind: "none" }],
    ["reviewer", { kind: "persona", id: "reviewer", name: "Reviewer" }],
  ] as const)("captures composer persona intent %s", (personaId, expected) => {
    expect(personaIntentFromComposer(personaId, "Reviewer")).toEqual(expected);
  });

  it("keeps explicit none distinct from system inheritance", () => {
    expect(personaIntentToOverride({ kind: "none" })).toEqual({ id: null });
    expect(personaIntentToOverride({ kind: "inherit" })).toBeUndefined();
  });

  it("admits composer work with one immutable persona intent", () => {
    expect(
      admitComposerQueuedMessage({
        text: "review this",
        personaId: "reviewer",
        personaName: "Reviewer",
      }),
    ).toEqual({
      text: "review this",
      persona: { kind: "persona", id: "reviewer", name: "Reviewer" },
    });
  });

  it("constructs system work as inherited rather than omitted", () => {
    expect(
      admitSystemInheritedQueuedMessage({
        text: "diagnose",
      }),
    ).toEqual({
      text: "diagnose",
      persona: { kind: "inherit" },
    });
  });

  it("allows deferred planning to remain targetless without weakening admission", () => {
    expect(
      createDeferredQueuedMessagePayload({
        text: "wait for workspace",
        persona: { kind: "inherit" },
      }),
    ).toEqual({
      text: "wait for workspace",
      persona: { kind: "inherit" },
    });
  });
});
