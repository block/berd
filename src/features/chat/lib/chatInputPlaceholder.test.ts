import { describe, expect, it } from "vitest";
import {
  getChatInputAgentGroupLabel,
  getChatInputAgentLabel,
  getChatInputPlaceholder,
} from "./chatInputPlaceholder";

const t = (key: string, options?: { agent: string }) =>
  options?.agent ? `${key}:${options.agent}` : key;

const persona = (id: string, displayName: string) => ({ id, displayName });

describe("getChatInputAgentLabel", () => {
  it("uses the active persona display name when present", () => {
    expect(getChatInputAgentLabel("Reviewer", "Goose")).toBe("Reviewer");
  });

  it("falls back to the provider display name", () => {
    expect(getChatInputAgentLabel(undefined, "Goose")).toBe("Goose");
  });

  it("preserves explicit persona names with the default suffix", () => {
    expect(getChatInputAgentLabel("Ops (Default)", "Goose (Default)")).toBe(
      "Ops (Default)",
    );
  });

  it("removes the default suffix from provider fallback labels", () => {
    expect(getChatInputAgentLabel(undefined, "Goose (Default)")).toBe("Goose");
  });
});

describe("getChatInputAgentGroupLabel", () => {
  it("falls back to the provider label when there are no selected personas", () => {
    expect(getChatInputAgentGroupLabel([], "Goose (Default)")).toBe("Goose");
  });

  it("uses the selected persona label for a single selected persona", () => {
    expect(
      getChatInputAgentGroupLabel([persona("reviewer", "Reviewer")], "Goose"),
    ).toBe("Reviewer");
  });

  it("names both selected personas", () => {
    expect(
      getChatInputAgentGroupLabel(
        [persona("eugene", "Eugene"), persona("you-x", "YOU-X")],
        "Goose",
      ),
    ).toBe("Eugene and YOU-X");
  });

  it("uses persona ids to separate active and mentioned agents", () => {
    expect(
      getChatInputAgentGroupLabel(
        [persona("reviewer-a", "Reviewer"), persona("reviewer-b", "Reviewer")],
        "Goose",
        "reviewer-b",
      ),
    ).toBe("Reviewer (can summon Reviewer)");
  });

  it("falls back to naming both selected personas when the active id is unavailable", () => {
    expect(
      getChatInputAgentGroupLabel(
        [persona("eugene", "Eugene"), persona("you-x", "YOU-X")],
        "Goose",
        "missing",
      ),
    ).toBe("Eugene and YOU-X");
  });

  it("shows 'can summon' language when a larger selected group has an active persona", () => {
    expect(
      getChatInputAgentGroupLabel(
        [persona("eugene", "Eugene"), persona("you-x", "YOU-X")],
        "Goose",
        "you-x",
      ),
    ).toBe("YOU-X (can summon Eugene)");
  });

  it("shows 'can summon' with multiple mentioned agents", () => {
    expect(
      getChatInputAgentGroupLabel(
        [
          persona("eugene", "Eugene"),
          persona("you-x", "YOU-X"),
          persona("builderbot", "Builderbot"),
        ],
        "Goose",
        "you-x",
      ),
    ).toBe("YOU-X (can summon Eugene, Builderbot)");
  });

  it("shows 'can summon X others' for many mentioned agents", () => {
    expect(
      getChatInputAgentGroupLabel(
        [
          persona("eugene", "Eugene"),
          persona("you-x", "YOU-X"),
          persona("builderbot", "Builderbot"),
          persona("val", "Val"),
          persona("uma", "Uma"),
        ],
        "Goose",
        "you-x",
      ),
    ).toBe("YOU-X (can summon 4 others)");
  });

  it("keeps larger selected persona groups compact", () => {
    expect(
      getChatInputAgentGroupLabel(
        [
          persona("builderbot", "Builderbot"),
          persona("you-x", "YOU-X"),
          persona("eugene", "Eugene"),
        ],
        "Goose",
      ),
    ).toBe("Builderbot, YOU-X, + 1 more");
  });
});

describe("getChatInputPlaceholder", () => {
  it("uses the agent label in the default placeholder", () => {
    expect(getChatInputPlaceholder(t, "Goose", false, false)).toBe(
      "input.placeholder:Goose",
    );
  });

  it("uses voice status placeholders while recording or transcribing", () => {
    expect(getChatInputPlaceholder(t, "Goose", true, false)).toBe(
      "toolbar.voiceInputRecording",
    );
    expect(getChatInputPlaceholder(t, "Goose", false, true)).toBe(
      "toolbar.voiceInputTranscribing",
    );
  });
});
