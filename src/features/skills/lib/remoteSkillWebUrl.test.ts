import { describe, expect, it } from "vitest";
import { remoteSkillWebUrl } from "./remoteSkillWebUrl";

describe("remoteSkillWebUrl", () => {
  it("builds the marketplace skill URL", () => {
    expect(remoteSkillWebUrl("agent-browser")).toBe(
      "https://dev-guides.sqprod.co/skills/skill?id=agent-browser",
    );
  });

  it("encodes names with special characters", () => {
    expect(remoteSkillWebUrl("a b&c")).toBe(
      "https://dev-guides.sqprod.co/skills/skill?id=a%20b%26c",
    );
  });
});
