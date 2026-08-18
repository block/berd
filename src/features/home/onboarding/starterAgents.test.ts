import { beforeEach, describe, expect, it } from "vitest";
import type { Persona } from "@/shared/types/agents";
import {
  haveStarterAgentPinsBeenSeeded,
  markStarterAgentPinsSeeded,
  resetStarterAgentPinsSeeded,
  selectStarterAgentPersonas,
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

  it("accepts only bundled starter identities", () => {
    expect(
      selectStarterAgentPersonas([
        persona("Unmarked Tinker", {
          id: "/Users/test/.agents/agents/tinker.md",
          bundled: false,
        }),
        persona("Wrong-path Tinker", {
          id: "/Users/test/.agents/agents/tinker2.md",
        }),
        persona("Bundled Wildcard", {
          id: "/Users/test/.agents/agents/wildcard.md",
        }),
      ]).map((agent) => agent.displayName),
    ).toEqual(["Bundled Wildcard"]);
  });

  it("clears starter-agent seeding for onboarding reset", () => {
    markStarterAgentPinsSeeded();
    expect(haveStarterAgentPinsBeenSeeded()).toBe(true);

    resetStarterAgentPinsSeeded();

    expect(haveStarterAgentPinsBeenSeeded()).toBe(false);
  });
});
