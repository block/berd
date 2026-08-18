import { describe, expect, it } from "vitest";
import type { Persona } from "@/shared/types/agents";
import { findBerdyPersonaId } from "./berdyAgent";

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "/Users/test/.agents/agents/berdy.md",
    displayName: "Berdy",
    avatar: "app-avatar:gloopies-22",
    systemPrompt: "Help people use Berd.",
    isBuiltin: false,
    writable: true,
    sourceProperties: { metadata: { berdBundled: true } },
    ...overrides,
  };
}

describe("findBerdyPersonaId", () => {
  it("finds the installed Berdy agent by its stable file identity", () => {
    expect(findBerdyPersonaId([persona()])).toBe(
      "/Users/test/.agents/agents/berdy.md",
    );
  });

  it("does not select another agent that only shares Berdy's name", () => {
    expect(
      findBerdyPersonaId([
        persona({ id: "/Users/test/.agents/agents/other.md" }),
      ]),
    ).toBeNull();
  });

  it("ignores a project agent impersonating Berdy before the bundled agent", () => {
    const bundled = persona();
    const projectAgent = persona({
      id: "/Users/test/project/.agents/agents/berdy.md",
      sourceProperties: { metadata: {} },
    });

    expect(findBerdyPersonaId([projectAgent, bundled])).toBe(bundled.id);
  });
});
