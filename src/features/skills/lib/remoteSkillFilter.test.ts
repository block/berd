import { describe, expect, it } from "vitest";
import { remoteSkillMatchesQuery } from "./remoteSkillFilter";
import type { RemoteSkill } from "../api/skillMarketplace";

function makeSkill(overrides: Partial<RemoteSkill> = {}): RemoteSkill {
  return {
    name: "agent-browser",
    description: "Debug visual bugs and interact with web apps",
    roles: ["frontend"],
    references: [],
    author: "monicab",
    status: null,
    installed: false,
    ...overrides,
  };
}

describe("remoteSkillMatchesQuery", () => {
  it("matches everything for an empty or whitespace query", () => {
    expect(remoteSkillMatchesQuery(makeSkill(), "")).toBe(true);
    expect(remoteSkillMatchesQuery(makeSkill(), "   ")).toBe(true);
  });

  it("matches on name case-insensitively", () => {
    expect(remoteSkillMatchesQuery(makeSkill(), "AGENT")).toBe(true);
  });

  it("matches on description, author, and roles", () => {
    expect(remoteSkillMatchesQuery(makeSkill(), "visual bugs")).toBe(true);
    expect(remoteSkillMatchesQuery(makeSkill(), "monicab")).toBe(true);
    expect(remoteSkillMatchesQuery(makeSkill(), "frontend")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(remoteSkillMatchesQuery(makeSkill(), "database")).toBe(false);
  });

  it("does not throw when author is null", () => {
    expect(remoteSkillMatchesQuery(makeSkill({ author: null }), "agent")).toBe(
      true,
    );
  });
});
