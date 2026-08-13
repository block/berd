import { describe, expect, it } from "vitest";
import {
  deriveAgentCardTraits,
  stableAgentCardNumber,
  truncateAgentCardTitle,
} from "./agentShareCardSpec";

describe("agentShareCardSpec", () => {
  it("uses Berd branding for an empty title", () => {
    expect(truncateAgentCardTitle("  ")).toBe("BERD AGENT");
  });

  it("uppercases and bounds long titles", () => {
    const title = truncateAgentCardTitle(
      "a very long agent name that continues",
    );
    expect(title).toBe("A VERY LONG AGENT NAME TH…");
    expect(Array.from(title)).toHaveLength(26);
  });

  it("derives stable card traits from agent instructions", () => {
    expect(
      deriveAgentCardTraits(
        "Research unfamiliar topics, search trustworthy sources, and synthesize evidence.",
      ),
    ).toEqual({
      goodFor: "finding and synthesizing answers",
      vibes: "curious, thorough",
    });
    expect(deriveAgentCardTraits("Do unusual bespoke work.")).toEqual({
      goodFor: "making progress on focused work",
      vibes: "capable, thoughtful",
    });
  });

  it("uses curated order to break equal trait matches", () => {
    expect(
      deriveAgentCardTraits("Review code and improve software quality"),
    ).toEqual({
      goodFor: "building and improving software",
      vibes: "precise, pragmatic",
    });
  });

  it("creates a stable four-digit card number", () => {
    expect(stableAgentCardNumber("/agents/reviewer.md")).toMatch(/^\d{4}$/);
    expect(stableAgentCardNumber("/agents/reviewer.md")).toBe(
      stableAgentCardNumber("/agents/reviewer.md"),
    );
  });
});
