import { beforeEach, describe, expect, it } from "vitest";
import type { Persona } from "@/shared/types/agents";
import {
  haveStarterAgentPinsBeenSeeded,
  markStarterAgentPinsSeeded,
  resetStarterAgentPinsSeeded,
  selectStarterAgentPersonas,
  shouldRemoveLegacyBerdyPin,
  STARTER_AGENT_NAMES,
} from "./starterAgents";

function persona(
  displayName: string,
  options: { bundled?: boolean; id?: string } = {},
): Persona {
  return {
    id: options.id ?? `/Users/test/.agents/agents/${displayName}.md`,
    displayName,
    systemPrompt: "Help.",
    isBuiltin: false,
    writable: true,
    sourceProperties: {
      metadata: { berdBundled: options.bundled ?? true },
    },
  };
}

describe("starter agents", () => {
  beforeEach(() => localStorage.clear());

  it("selects block.md and Builderbot without duplicating Berdy", () => {
    expect(STARTER_AGENT_NAMES).toEqual(["block.md", "Builderbot"]);
    expect(
      selectStarterAgentPersonas([
        persona("Builderbot"),
        persona("Berdy"),
        persona("block.md"),
      ]).map((agent) => agent.displayName),
    ).toEqual(["block.md", "Builderbot"]);
  });

  it("does not treat similarly named user agents as starter agents", () => {
    expect(
      selectStarterAgentPersonas([
        persona("Berdy", { bundled: false }),
        persona("Builderbot copy"),
      ]),
    ).toEqual([]);
  });

  it("clears starter-agent seeding for onboarding reset", () => {
    markStarterAgentPinsSeeded();
    expect(haveStarterAgentPinsBeenSeeded()).toBe(true);

    resetStarterAgentPinsSeeded();

    expect(haveStarterAgentPinsBeenSeeded()).toBe(false);
  });

  it("migrates the legacy three-agent seed marker", () => {
    localStorage.setItem("goose:home:starter-agent-pins-seeded", "1");
    expect(shouldRemoveLegacyBerdyPin()).toBe(true);
    expect(haveStarterAgentPinsBeenSeeded()).toBe(false);

    markStarterAgentPinsSeeded();

    expect(haveStarterAgentPinsBeenSeeded()).toBe(true);
    expect(shouldRemoveLegacyBerdyPin()).toBe(false);
    expect(
      localStorage.getItem("goose:home:starter-agent-pins-seeded"),
    ).toBeNull();
  });
});
