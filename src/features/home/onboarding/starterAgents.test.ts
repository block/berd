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
    id:
      options.id ??
      `/Users/test/.agents/agents/${displayName.toLowerCase()}.md`,
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

  it("selects Tinker and Wildcard in pinned order", () => {
    expect(STARTER_AGENT_NAMES).toEqual(["Tinker", "Wildcard"]);
    expect(
      selectStarterAgentPersonas([
        persona("Wildcard"),
        persona("Berdy"),
        persona("Tinker"),
      ]).map((agent) => agent.displayName),
    ).toEqual(["Tinker", "Wildcard"]);
  });

  it("uses canonical bundled filenames instead of similar names", () => {
    expect(
      selectStarterAgentPersonas([
        persona("Tinker copy"),
        persona("Wildcard", { bundled: false }),
        persona("Workbench", {
          id: "/Users/test/.agents/agents/tinker.md",
        }),
        persona("Surprise", {
          id: "/Users/test/.agents/agents/wildcard.md",
        }),
      ]).map((agent) => agent.displayName),
    ).toEqual(["Workbench", "Surprise"]);
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

    markStarterAgentPinsSeeded();

    expect(haveStarterAgentPinsBeenSeeded()).toBe(true);
    expect(shouldRemoveLegacyBerdyPin()).toBe(false);
  });
});
