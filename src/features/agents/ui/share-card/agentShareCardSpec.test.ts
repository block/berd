import { describe, expect, it } from "vitest";
import {
  classifyAgentCardTraits,
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

  it("derives stable semantic traits from agent instructions", () => {
    expect(
      classifyAgentCardTraits(
        "Research unfamiliar topics, search trustworthy sources, and synthesize evidence.",
      ),
    ).toBe("research");
    expect(classifyAgentCardTraits("Do unusual bespoke work.")).toBe("default");
  });

  it("uses curated order to break equal trait matches", () => {
    expect(
      classifyAgentCardTraits("Review code and improve software quality"),
    ).toBe("software");
  });

  it("maps equivalent English and Spanish instructions to the same traits", () => {
    expect(classifyAgentCardTraits("Research evidence and sources")).toBe(
      "research",
    );
    expect(classifyAgentCardTraits("Investigar evidencia y fuentes")).toBe(
      "research",
    );
    expect(classifyAgentCardTraits("Design an interface prototype")).toBe(
      "design",
    );
    expect(classifyAgentCardTraits("Diseño de una interfaz y prototipo")).toBe(
      "design",
    );
    expect(classifyAgentCardTraits("Automate repetitive workflows")).toBe(
      "automation",
    );
    expect(
      classifyAgentCardTraits("Automatización de flujos repetitivos"),
    ).toBe("automation");
  });

  it("uses explicit casing independent of the host locale", () => {
    expect(truncateAgentCardTitle("mini", "en")).toBe("MINI");
    expect(classifyAgentCardTraits("INTERFACE designer")).toBe("design");
  });
});
