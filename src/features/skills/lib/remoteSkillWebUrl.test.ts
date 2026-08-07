import { describe, expect, it } from "vitest";
import { remoteSkillWebUrl } from "./remoteSkillWebUrl";

const TEMPLATE = "https://marketplace.example.test/skills/skill?id={skillId}";

describe("remoteSkillWebUrl", () => {
  it("builds the configured marketplace skill URL", () => {
    expect(remoteSkillWebUrl(TEMPLATE, "agent-browser")).toBe(
      "https://marketplace.example.test/skills/skill?id=agent-browser",
    );
  });

  it("encodes names with special characters", () => {
    expect(remoteSkillWebUrl(TEMPLATE, "a b&c")).toBe(
      "https://marketplace.example.test/skills/skill?id=a%20b%26c",
    );
  });

  it("returns undefined when no marketplace is configured", () => {
    expect(remoteSkillWebUrl(undefined, "agent-browser")).toBeUndefined();
  });
});
