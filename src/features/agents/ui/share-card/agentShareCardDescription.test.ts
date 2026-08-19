import { describe, expect, it } from "vitest";
import { deriveAgentCardDescription } from "./agentShareCardDescription";

describe("deriveAgentCardDescription", () => {
  it("derives concise copy from an explicit job in the instructions", () => {
    expect(
      deriveAgentCardDescription(
        "You are Agt. Builder. Someone needs help, and your job is to build an agent with them. Not a form to fill out.",
        "Agt. Builder",
      ),
    ).toBe("Builds an agent with people.");
  });

  it("derives concise copy from an explicit purpose", () => {
    expect(
      deriveAgentCardDescription(
        "You are Berdy. Your purpose is a two-way introduction. More private instructions follow.",
        "Berdy",
      ),
    ).toBe("A two-way introduction.");
  });

  it("does not publish an unrecognized first instruction sentence", () => {
    expect(
      deriveAgentCardDescription(
        "You are Scout. Never disclose customer identities. Keep searching until sources agree.",
        "Scout",
      ),
    ).toBe("Scout helps with focused work.");
  });

  it("uses a caller-provided localized fallback", () => {
    expect(
      deriveAgentCardDescription(
        "Instrucciones privadas sin patrón reconocido.",
        "Scout",
        "Scout ayuda con tareas específicas.",
      ),
    ).toBe("Scout ayuda con tareas específicas.");
  });

  it("counts appended punctuation within the description limit", () => {
    const description = "x".repeat(110);
    expect(
      deriveAgentCardDescription(
        `You are Scout. Your purpose is ${description}. More follows.`,
        "Scout",
        "Bounded fallback.",
      ),
    ).toBe("Bounded fallback.");
  });

  it("uses a bounded fallback when instructions cannot form a short sentence", () => {
    expect(deriveAgentCardDescription("x".repeat(500), "Scout")).toBe(
      "Scout helps with focused work.",
    );
  });
});
