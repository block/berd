import { beforeEach, describe, expect, it } from "vitest";
import type { Persona } from "@/shared/types/agents";
import {
  areStarterAgentPinsEligible,
  haveStarterAgentPinsBeenSeeded,
  markStarterAgentPinsEligible,
  markStarterAgentPinsSeeded,
  resetStarterAgentPinsSeeded,
  selectStarterAgentPersonas,
  shouldRemoveLegacyBerdyPin,
  STARTER_AGENT_NAMES,
} from "./starterAgents";

function persona(
  displayName: string,
  options: { bundled?: boolean; id?: string; sourceId?: string } = {},
): Persona {
  return {
    id: options.id ?? `/Users/test/.agents/agents/${displayName}.md`,
    displayName,
    systemPrompt: "Help.",
    isBuiltin: false,
    writable: true,
    sourceProperties: {
      metadata: {
        berdBundled: options.bundled ?? true,
        berdBundledSource: options.sourceId ?? displayName.toLowerCase(),
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
        persona("Wildcard"),
        persona("Choosey"),
        persona("Berdy"),
        persona("Tinker"),
      ]).map((agent) => agent.displayName),
    ).toEqual(["Tinker", "Wildcard"]);
  });

  it("uses stable bundled file identities rather than display names", () => {
    const renamedTinker = persona("Workbench", {
      id: "/Users/test/.agents/agents/tinker7.md",
      sourceId: "tinker",
    });
    const fallbackWildcard = persona("Surprise", {
      id: "/Users/test/.agents/agents/wildcard12.md",
      sourceId: "wildcard",
    });
    const impostor = persona("Tinker", {
      id: "/Users/test/.agents/agents/choosey.md",
      sourceId: "choosey",
    });

    expect(
      selectStarterAgentPersonas([
        fallbackWildcard,
        impostor,
        renamedTinker,
      ]).map((agent) => agent.id),
    ).toEqual([renamedTinker.id, fallbackWildcard.id]);
  });

  it("deduplicates canonical and fallback files by starter slot", () => {
    const canonical = persona("Tinker", {
      id: "/Users/test/.agents/agents/tinker.md",
    });
    const fallback = persona("Tinker fallback", {
      id: "/Users/test/.agents/agents/tinker2.md",
    });

    expect(selectStarterAgentPersonas([fallback, canonical])).toEqual([
      canonical,
    ]);
    expect(selectStarterAgentPersonas([canonical, fallback])).toEqual([
      canonical,
    ]);
  });

  it("prefers verified managed copies over preserved edits", () => {
    const edited = persona("Tinker edited", {
      id: "/Users/test/.agents/agents/tinker.md",
      sourceId: "tinker",
    });
    const managed = persona("Tinker", {
      id: "/Users/test/.agents/agents/tinker2.md",
      sourceId: "tinker",
    });
    managed.sourceProperties = {
      metadata: {
        berdBundled: true,
        berdBundledSource: "tinker",
        berdManagedBundledCopy: true,
        berdBundledAllocationSource: "tinker",
      },
    };

    expect(selectStarterAgentPersonas([edited, managed])).toEqual([managed]);
    expect(selectStarterAgentPersonas([managed, edited])).toEqual([managed]);
  });

  it("does not mix unmanaged claims with verified managed copies", () => {
    const managedTinker = persona("Tinker", {
      id: "/Users/test/.agents/agents/tinker2.md",
      sourceId: "tinker",
    });
    managedTinker.sourceProperties = {
      metadata: {
        berdBundled: true,
        berdBundledSource: "tinker",
        berdManagedBundledCopy: true,
        berdBundledAllocationSource: "tinker",
      },
    };
    const claimedWildcard = persona("Wildcard", {
      id: "/Users/test/.agents/agents/wildcard.md",
      sourceId: "wildcard",
    });

    expect(
      selectStarterAgentPersonas([managedTinker, claimedWildcard]),
    ).toEqual([managedTinker]);
  });

  it("clears recovery eligibility after starter pins are seeded", () => {
    markStarterAgentPinsEligible();
    expect(areStarterAgentPinsEligible()).toBe(true);

    markStarterAgentPinsSeeded();

    expect(areStarterAgentPinsEligible()).toBe(false);
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
