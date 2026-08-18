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
  options: { bundled?: boolean; id?: string; managedSource?: string } = {},
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
      metadata: {
        berdBundled: options.bundled ?? true,
        ...(options.managedSource
          ? {
              berdManagedBundledCopy: true,
              berdBundledAllocationSource: options.managedSource,
            }
          : {}),
      },
    },
  };
}

describe("starter agents", () => {
  beforeEach(() => localStorage.clear());

  it("selects Tinker and Wildcard in pinned order", () => {
    expect(STARTER_AGENT_NAMES).toEqual(["Tinker", "Wildcard"]);
    expect(
      selectStarterAgentPersonas([
        persona("Wildcard", { managedSource: "wildcard" }),
        persona("Berdy", { managedSource: "berdy" }),
        persona("Tinker", { managedSource: "tinker" }),
      ]).map((agent) => agent.displayName),
    ).toEqual(["Tinker", "Wildcard"]);
  });

  it("accepts only verified managed starter identities", () => {
    expect(
      selectStarterAgentPersonas([
        persona("Self-declared Tinker", {
          id: "/Users/test/.agents/agents/tinker.md",
        }),
        persona("Managed Tinker", {
          id: "/Users/test/.agents/agents/tinker2.md",
          managedSource: "tinker",
        }),
        persona("Managed Wildcard", {
          id: "/Users/test/.agents/agents/wildcard.md",
          managedSource: "wildcard",
        }),
      ]).map((agent) => agent.displayName),
    ).toEqual(["Managed Tinker", "Managed Wildcard"]);
  });

  it("clears starter-agent seeding for onboarding reset", () => {
    markStarterAgentPinsSeeded();
    expect(haveStarterAgentPinsBeenSeeded()).toBe(true);

    resetStarterAgentPinsSeeded();

    expect(haveStarterAgentPinsBeenSeeded()).toBe(false);
  });
});
