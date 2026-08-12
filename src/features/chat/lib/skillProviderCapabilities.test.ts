import { describe, expect, it } from "vitest";
import { getSkillProviderCapabilities } from "./skillProviderCapabilities";

describe("getSkillProviderCapabilities", () => {
  it("enables skill discovery for Goose-managed providers", () => {
    expect(getSkillProviderCapabilities("goose")).toEqual({
      supportsSkillDiscovery: true,
      supportsSkillMentions: true,
      discoveryMode: "goose-sources",
      activationStyle: "goose",
    });
    expect(getSkillProviderCapabilities("databricks_v2")).toEqual({
      supportsSkillDiscovery: true,
      supportsSkillMentions: true,
      discoveryMode: "goose-sources",
      activationStyle: "goose",
    });
  });

  it("uses agent skill files for external harnesses", () => {
    expect(getSkillProviderCapabilities("claude-acp")).toEqual({
      supportsSkillDiscovery: true,
      supportsSkillMentions: true,
      discoveryMode: "agent-skill-files",
      activationStyle: "claude",
    });
    expect(getSkillProviderCapabilities("codex-acp")).toEqual({
      supportsSkillDiscovery: true,
      supportsSkillMentions: true,
      discoveryMode: "agent-skill-files",
      activationStyle: "codex",
    });
    expect(getSkillProviderCapabilities("gemini-acp")).toEqual({
      supportsSkillDiscovery: true,
      supportsSkillMentions: true,
      discoveryMode: "agent-skill-files",
      activationStyle: "gemini",
    });
  });
});
